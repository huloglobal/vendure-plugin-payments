import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Logger, ProcessContext, TransactionalConnection } from '@vendure/core';
import {
    DigestMail, DigestTip, PluginPrefs, WeeklyDigest, WeeklyDigestSettings, adapterFor, composeDigest, describeLicence,
    formatStat, licenceLifecycleNotice,
} from '@huloglobal/vendure-licence-sdk';
import { HuloPaymentsPlugin, getOptions } from './plugin';
import { PLUGIN_ID } from './licence.service';
import { LedgerService, loggerCtx } from './core/ledger.service';
import { SubscriptionService } from './subscriptions/subscription.service';
import { listHuloMethods } from './core/credentials';
import { getRuntime } from './core/runtime';
import { ADMIN_ROUTE, PLUGIN_NAME, PREMIUM_FEATURES, STAT_DEFS, SetupItem, setupItemsFrom, toDigestStat } from './core/engagement-rules';

export { ADMIN_ROUTE, PLUGIN_NAME, PREMIUM_FEATURES, STAT_DEFS, SetupItem } from './core/engagement-rules';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Merchant engagement: the usage numbers the licence server receives, the
 * set-up checklist, the weekly report and the dashboard widget. Every
 * query here is fail-soft — a SQL or SMTP problem is logged, never thrown
 * into the host.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class HuloPaymentsEngagementService implements OnApplicationBootstrap {
    readonly prefs: PluginPrefs;
    readonly digest: WeeklyDigest;

    constructor(
        private connection: TransactionalConnection,
        private ledger: LedgerService,
        private subscriptions: SubscriptionService,
        private processContext: ProcessContext,
    ) {
        this.prefs = new PluginPrefs((sql, params, opts) => this.db.query(sql, params, opts), PLUGIN_ID);
        this.digest = new WeeklyDigest({
            pluginId: PLUGIN_ID,
            pluginName: PLUGIN_NAME,
            prefs: this.prefs,
            collect: (from, to) => this.collect(from, to),
            send: (to, mail) => this.send(to, mail),
            defaultRecipient: () => this.defaultRecipient(),
        });
    }

    private get db() { return adapterFor(this.connection.rawConnection); }

    async onApplicationBootstrap() {
        await this.prefs.ensureTable();
        HuloPaymentsPlugin.setStatsProvider(() => this.evalStats());
        if (this.processContext.isWorker && !getOptions().disableScheduler) this.digest.start();
    }

    // ── Usage stats ─────────────────────────────────────────────────────
    /** Last 30 days, numbers only, no personal data — what the evaluation ping and the heartbeat carry. */
    async evalStats(): Promise<Record<string, number>> {
        const now = new Date();
        return this.statsFor(new Date(now.getTime() - 30 * DAY_MS), now, null);
    }

    /** Stats for the window `[from, to)`, optionally one channel. Snapshot keys (subscriptions, MRR) are as of now. */
    async statsFor(from: Date, to: Date, channelId: number | null): Promise<Record<string, number>> {
        const out: Record<string, number> = {};
        for (const d of STAT_DEFS) out[d.key] = 0;
        const where = channelId ? 'WHERE channelId = ? AND' : 'WHERE';
        const params = channelId ? [channelId, from, to] : [from, to];
        try {
            const [row] = await this.db.query(
                `SELECT SUM(CASE WHEN kind IN ('capture','renewal') AND status = 'ok' AND (amount IS NULL OR amount > 0) THEN 1 ELSE 0 END) AS settled,
                        SUM(CASE WHEN kind IN ('capture','renewal') AND status = 'ok' THEN COALESCE(amount, 0) ELSE 0 END) AS volume,
                        SUM(CASE WHEN kind = 'refund' AND status = 'ok' THEN COALESCE(amount, 0) ELSE 0 END) AS refunded,
                        SUM(CASE WHEN kind = 'dispute' AND status = 'open' THEN 1 ELSE 0 END) AS disputes,
                        SUM(CASE WHEN kind = 'paylink' AND status = 'ok' THEN COALESCE(amount, 0) ELSE 0 END) AS paylink
                 FROM hulo_payment_txn ${where} createdAt >= ? AND createdAt < ?`, params);
            out.paymentsSettled = Number(row?.settled || 0);
            out.volumePence = Number(row?.volume || 0);
            out.refundedPence = Number(row?.refunded || 0);
            out.disputesOpened = Number(row?.disputes || 0);
            out.payLinkPaidPence = Number(row?.paylink || 0);
            out.renewalsRecovered = await this.renewalsRecovered(from, to, channelId);
        } catch (e: any) {
            Logger.warn(`usage stats failed: ${e?.message || e}`, loggerCtx);
        }
        try {
            const subs = await this.subscriptions.stats();
            out.subscriptionsActive = subs.active + subs.trialing;
            out.mrrPence = Object.values(subs.mrr || {}).reduce((n, v) => n + Number(v || 0), 0);
        } catch { /* table missing on a fresh install */ }
        return out;
    }

    /** Successful renewals in the window whose previous renewal attempt for the same subscription had failed. */
    async renewalsRecovered(from: Date, to: Date, channelId: number | null): Promise<number> {
        const where = channelId ? 'WHERE r.channelId = ? AND' : 'WHERE';
        const params = channelId ? [channelId, from, to] : [from, to];
        const [row] = await this.db.query(
            `SELECT COUNT(*) AS n FROM hulo_payment_txn r
             ${where} r.kind = 'renewal' AND r.status = 'ok' AND r.amount > 0 AND r.orderCode IS NOT NULL
               AND r.createdAt >= ? AND r.createdAt < ?
               AND EXISTS (SELECT 1 FROM hulo_payment_txn f
                           WHERE f.kind = 'renewal' AND f.status = 'failed' AND f.orderCode = r.orderCode AND f.provider = r.provider AND f.id < r.id
                             AND NOT EXISTS (SELECT 1 FROM hulo_payment_txn g
                                             WHERE g.kind = 'renewal' AND g.status = 'ok' AND g.amount > 0 AND g.orderCode = r.orderCode AND g.provider = r.provider
                                               AND g.id > f.id AND g.id < r.id))`, params).catch(() => [] as any[]);
        return Number(row?.n || 0);
    }

    /** The currency most settled payments in the window used (money stats are summed in minor units of it). */
    async mainCurrency(from: Date, to: Date): Promise<string> {
        const [row] = await this.db.query(
            `SELECT currency, COUNT(*) AS n FROM hulo_payment_txn
             WHERE kind IN ('capture','renewal') AND status = 'ok' AND currency IS NOT NULL AND createdAt >= ? AND createdAt < ?
             GROUP BY currency ORDER BY n DESC LIMIT 1`, [from, to]).catch(() => [] as any[]);
        return String(row?.currency || 'GBP').toUpperCase();
    }

    /** Top non-zero 30-day figures for the admin banner, already formatted. */
    async recentStats(limit = 3): Promise<Array<{ label: string; value: string }>> {
        const now = new Date();
        const from = new Date(now.getTime() - 30 * DAY_MS);
        const stats = await this.statsFor(from, now, null);
        const currency = await this.mainCurrency(from, now);
        return STAT_DEFS.filter(d => stats[d.key] > 0).slice(0, limit)
            .map(d => { const s = toDigestStat(d, stats[d.key], null, currency); return { label: d.label, value: formatStat(s) }; });
    }

    // ── Set-up checklist ────────────────────────────────────────────────
    async setup(): Promise<{ items: SetupItem[]; complete: boolean }> {
        const o = getOptions();
        const methods = await listHuloMethods(this.connection).catch(() => []);
        const [ops] = await this.db.query(`SELECT COUNT(*) AS n FROM hulo_payment_settings WHERE opsEmail <> ''`).catch(() => [] as any[]);
        const paid = await this.db.query(`SELECT id FROM hulo_payment_txn WHERE kind IN ('capture','authorize') AND status = 'ok' ORDER BY id DESC LIMIT 1`).catch(() => [] as any[]);
        return setupItemsFrom({
            methods,
            returnHosts: o.hostedReturnHosts || [],
            opsEmailOption: o.ops?.email || '',
            channelOpsEmails: Number(ops?.n || 0),
            firstPayment: paid.length > 0,
        });
    }

    // ── Weekly report ───────────────────────────────────────────────────
    tier(): 'paid' | 'trial' | 'free' {
        const licence = HuloPaymentsPlugin.getLicenceStatus();
        return licence?.valid ? 'paid' : (HuloPaymentsPlugin.getEvalState()?.active ? 'trial' : 'free');
    }

    adminUrl(): string | null {
        const base = (getOptions().publicBaseUrl || '').replace(/\/$/, '');
        return base ? `${base}/admin/extensions/${ADMIN_ROUTE}` : null;
    }

    async collect(from: Date, to: Date) {
        const [cur, prev, currency, setup] = await Promise.all([
            this.statsFor(from, to, null),
            this.statsFor(new Date(from.getTime() - WEEK_MS), from, null),
            this.mainCurrency(from, to),
            this.setup(),
        ]);
        const stats = STAT_DEFS.map(d => toDigestStat(d, cur[d.key], d.snapshot ? null : prev[d.key], currency))
            .filter(s => s.format !== 'text' || s.value > 0);
        const adminUrl = this.adminUrl();
        const tips: DigestTip[] = setup.items.filter(i => !i.done).slice(0, 3).map(i => ({
            title: i.label, body: i.hint,
            url: i.tab && adminUrl ? `${adminUrl}?tab=${i.tab}` : i.url,
            linkLabel: i.tab ? 'Open in Admin' : 'Read the docs',
        }));
        const licence = HuloPaymentsPlugin.getLicenceStatus();
        return {
            stats, tips,
            tier: this.tier(),
            licence: describeLicence(licence),
            evalState: HuloPaymentsPlugin.getEvalState(),
            adminUrl,
            premiumFeatures: PREMIUM_FEATURES,
            settingsHint: 'Change the recipient or stop this weekly report in Admin → Sales → Payments → Settings → Weekly report.',
        };
    }

    /** This week's report as the scheduler would send it (admin preview). */
    async preview(): Promise<DigestMail> {
        const end = new Date();
        const start = new Date(end.getTime() - WEEK_MS);
        return composeDigest({ ...(await this.collect(start, end)), pluginName: PLUGIN_NAME, shortId: PLUGIN_ID, periodStart: start, periodEnd: end });
    }

    async send(to: string, mail: DigestMail): Promise<void> {
        await getRuntime().sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
    }

    /** Ops address (option, then any channel's), then the licence customer, then the trial lead. */
    async defaultRecipient(): Promise<string | null> {
        const opt = getOptions().ops?.email;
        if (opt) return opt;
        const [row] = await this.db.query(`SELECT opsEmail FROM hulo_payment_settings WHERE opsEmail <> '' ORDER BY channelId ASC LIMIT 1`).catch(() => [] as any[]);
        if (row?.opsEmail) return String(row.opsEmail);
        const customer = describeLicence(HuloPaymentsPlugin.getLicenceStatus())?.customer;
        if (customer) return customer;
        return this.prefs.get('eval.leadEmail');
    }

    digestSettings(): Promise<WeeklyDigestSettings> { return this.digest.settings(); }

    // ── Banner + widget ─────────────────────────────────────────────────
    notice() {
        return licenceLifecycleNotice(describeLicence(HuloPaymentsPlugin.getLicenceStatus()), HuloPaymentsPlugin.getEvalState(), PLUGIN_ID);
    }

    /** Three headline figures for the last 7 days, for the Admin dashboard widget. */
    async widget(): Promise<{ tier: string; notice: { kind: string; message: string; daysLeft: number } | null; stats: Array<{ label: string; value: string }>; route: string }> {
        const now = new Date();
        const from = new Date(now.getTime() - WEEK_MS);
        const [stats, currency] = await Promise.all([this.statsFor(from, now, null), this.mainCurrency(from, now)]);
        const pick = (key: string) => STAT_DEFS.find(d => d.key === key)!;
        const n = this.notice();
        return {
            tier: this.tier(),
            notice: n ? { kind: n.kind, message: n.message, daysLeft: n.daysLeft } : null,
            stats: [
                { label: 'Taken · 7 days', value: formatStat(toDigestStat(pick('volumePence'), stats.volumePence, null, currency)) },
                { label: 'Payments settled · 7 days', value: formatStat(toDigestStat(pick('paymentsSettled'), stats.paymentsSettled, null, currency)) },
                { label: 'Disputes opened · 7 days', value: formatStat(toDigestStat(pick('disputesOpened'), stats.disputesOpened, null, currency)) },
            ],
            route: `/extensions/${ADMIN_ROUTE}`,
        };
    }
}
