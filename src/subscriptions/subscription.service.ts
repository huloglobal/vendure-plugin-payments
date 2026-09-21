import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger, Order, Payment, TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { NormalisedEvent, ProviderArgs, SubscriptionPlanInput, getProvider } from '../core/provider';
import { resolveMethod, listHuloMethods } from '../core/credentials';
import { LedgerService, loggerCtx } from '../core/ledger.service';
import { getRuntime } from '../core/runtime';

export type SubscriptionStatus = 'pending' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled';

export interface SubscriptionRow {
    id: number;
    provider: string;
    providerSubscriptionRef: string;
    channelId: number | null;
    customerId: number | null;
    customerEmail: string;
    orderId: number | null;
    orderCode: string;
    variantId: number;
    variantName: string;
    quantity: number;
    amount: number;
    currency: string;
    interval: string;
    intervalCount: number;
    status: SubscriptionStatus;
    currentPeriodEnd: string | null;
    nextChargeAt: string | null;
    cancelAtPeriodEnd: boolean;
    providerCustomerRef: string | null;
    providerPaymentRef: string | null;
    approveUrl: string | null;
    selfScheduled: boolean;
    failures: number;
    createdAt: string;
    updatedAt: string;
}

function intervalMs(interval: string, count: number): number {
    const unit: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    return (unit[interval] || 30) * Math.max(1, count) * 86400_000;
}

/**
 * Subscriptions across providers: the product variant says how often to
 * bill (custom fields), the order's first payment provides the customer /
 * token, and either the provider bills natively (Stripe, PayPal, Mollie) or
 * the plugin's scheduler charges the stored payment details (Adyen). All
 * of it lands in `hulo_subscription`, with renewals in the ledger.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class SubscriptionService implements OnModuleInit {
    constructor(private connection: TransactionalConnection, private ledger: LedgerService) {}
    private get db() { return adapterFor(this.connection.rawConnection); }

    async onModuleInit() { await this.ensureSchema(); }

    async ensureSchema(): Promise<void> {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_subscription (
                id INT AUTO_INCREMENT PRIMARY KEY,
                provider VARCHAR(32) NOT NULL,
                providerSubscriptionRef VARCHAR(190) NOT NULL DEFAULT '',
                channelId INT NULL,
                customerId INT NULL,
                customerEmail VARCHAR(190) NOT NULL DEFAULT '',
                orderId INT NULL,
                orderCode VARCHAR(32) NOT NULL DEFAULT '',
                variantId INT NOT NULL,
                variantName VARCHAR(255) NOT NULL DEFAULT '',
                quantity INT NOT NULL DEFAULT 1,
                amount INT NOT NULL DEFAULT 0,
                currency VARCHAR(3) NOT NULL DEFAULT 'GBP',
                \`interval\` VARCHAR(8) NOT NULL DEFAULT 'month',
                intervalCount INT NOT NULL DEFAULT 1,
                status VARCHAR(16) NOT NULL DEFAULT 'pending',
                currentPeriodEnd DATETIME NULL,
                nextChargeAt DATETIME NULL,
                cancelAtPeriodEnd TINYINT NOT NULL DEFAULT 0,
                providerCustomerRef VARCHAR(190) NULL,
                providerPaymentRef VARCHAR(190) NULL,
                approveUrl VARCHAR(500) NULL,
                selfScheduled TINYINT NOT NULL DEFAULT 0,
                failures INT NOT NULL DEFAULT 0,
                createdAt DATETIME NOT NULL,
                updatedAt DATETIME NOT NULL,
                INDEX idx_hs_customer (customerId),
                INDEX idx_hs_ref (providerSubscriptionRef),
                INDEX idx_hs_status (status, nextChargeAt),
                INDEX idx_hs_order (orderCode)
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_subscription_plan (
                id INT AUTO_INCREMENT PRIMARY KEY,
                provider VARCHAR(32) NOT NULL,
                variantId INT NOT NULL,
                amount INT NOT NULL,
                currency VARCHAR(3) NOT NULL,
                \`interval\` VARCHAR(8) NOT NULL,
                intervalCount INT NOT NULL,
                providerPlanRef VARCHAR(190) NOT NULL,
                createdAt DATETIME NOT NULL,
                UNIQUE KEY uq_hsp (provider, variantId, amount, currency, \`interval\`, intervalCount)
            )`);
    }

    // ── Detection ───────────────────────────────────────────────────────
    planForLine(line: any): SubscriptionPlanInput | null {
        const cf = line?.productVariant?.customFields || {};
        const interval = String(cf.huloSubscriptionInterval || 'none');
        if (!['day', 'week', 'month', 'year'].includes(interval)) return null;
        return {
            variantId: Number(line.productVariant.id), name: String(line.productVariant.name || `Variant ${line.productVariant.id}`),
            amount: Number(line.proratedUnitPriceWithTax ?? line.unitPriceWithTax ?? 0), currency: String(line.order?.currencyCode || ''),
            interval: interval as any, intervalCount: Math.max(1, Number(cf.huloSubscriptionIntervalCount) || 1),
            trialDays: Math.max(0, Number(cf.huloSubscriptionTrialDays) || 0), quantity: Number(line.quantity) || 1,
        };
    }

    orderHasSubscriptionLines(order: Order): boolean {
        return (order.lines || []).some(l => !!this.planForLine(l));
    }

    // ── Creation after payment ──────────────────────────────────────────
    async startForOrder(order: Order, payment: Payment): Promise<void> {
        if (!getRuntime().hasPremiumAccess()) return;
        const methods = await listHuloMethods(this.connection);
        const method = methods.find(m => m.paymentMethodCode === payment.method);
        if (!method) return;
        const provider = getProvider(method.handlerCode);
        if (!provider?.createSubscription) return;
        const channelId = Number((order.channels || []).find((c: any) => c.code !== '__default_channel__')?.id || order.channels?.[0]?.id) || null;
        for (const line of order.lines || []) {
            const plan = this.planForLine(line);
            if (!plan) continue;
            plan.currency = order.currencyCode;
            const [existing] = await this.db.query(`SELECT id FROM hulo_subscription WHERE orderCode = ? AND variantId = ?`, [order.code, plan.variantId]).catch(() => []);
            if (existing) continue;
            try {
                const planRef = await this.ensurePlanRef(provider.code, method.args, plan);
                const meta: any = payment.metadata || {};
                const outcome = await provider.createSubscription(method.args, {
                    ...plan, orderCode: order.code, customerEmail: order.customer?.emailAddress || '',
                    customerName: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || undefined,
                    providerCustomerRef: meta.customer || meta.customerId || (provider.code === 'hulo-adyen' ? (order.customer?.id ? `cust-${order.customer.id}` : `guest-${order.code}`) : undefined),
                    providerPaymentRef: meta.paymentMethod || meta.mandateId || meta.storedPaymentMethodId || undefined,
                    initialPaymentRef: payment.transactionId, providerPlanRef: planRef || undefined,
                    returnUrl: `${getRuntime().publicBaseUrl()}/account/subscriptions`,
                });
                const next = outcome.currentPeriodEnd || new Date(Date.now() + intervalMs(plan.interval, plan.intervalCount)).toISOString();
                await this.db.query(
                    `INSERT INTO hulo_subscription (provider, providerSubscriptionRef, channelId, customerId, customerEmail, orderId, orderCode, variantId, variantName, quantity, amount, currency, \`interval\`, intervalCount, status, currentPeriodEnd, nextChargeAt, cancelAtPeriodEnd, providerCustomerRef, providerPaymentRef, approveUrl, selfScheduled, failures, createdAt, updatedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, NOW(), NOW())`,
                    [provider.code, outcome.providerSubscriptionRef, channelId, order.customer?.id || null, order.customer?.emailAddress || '', order.id, order.code,
                     plan.variantId, plan.name.slice(0, 255), plan.quantity, plan.amount, plan.currency, plan.interval, plan.intervalCount, outcome.status,
                     this.sqlDate(next), outcome.selfScheduled ? this.sqlDate(next) : null,
                     outcome.providerCustomerRef || null, outcome.providerPaymentRef || null, outcome.approveUrl || null, outcome.selfScheduled ? 1 : 0]);
                Logger.info(`Subscription ${outcome.providerSubscriptionRef} (${outcome.status}) for ${order.code} × ${plan.name}`, loggerCtx);
            } catch (e: any) {
                Logger.error(`subscription creation failed for ${order.code} / variant ${plan.variantId}: ${e.message}`, loggerCtx);
                await getRuntime().notifyOps({ kind: 'payments.subscription.failed', subject: `Subscription could not be created for order ${order.code}`, text: `${plan.name} × ${plan.quantity}: ${e.message}`, orderCode: order.code, channelId });
            }
        }
    }

    private async ensurePlanRef(providerCode: string, args: ProviderArgs, plan: SubscriptionPlanInput): Promise<string | null> {
        const provider = getProvider(providerCode);
        if (!provider?.ensurePlan) return null;
        const [row] = await this.db.query(
            `SELECT providerPlanRef FROM hulo_subscription_plan WHERE provider = ? AND variantId = ? AND amount = ? AND currency = ? AND \`interval\` = ? AND intervalCount = ?`,
            [providerCode, plan.variantId, plan.amount, plan.currency, plan.interval, plan.intervalCount]).catch(() => []);
        if (row?.providerPlanRef) return row.providerPlanRef;
        const ref = await provider.ensurePlan(args, plan);
        await this.db.query(
            `INSERT INTO hulo_subscription_plan (provider, variantId, amount, currency, \`interval\`, intervalCount, providerPlanRef, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE providerPlanRef = VALUES(providerPlanRef)`,
            [providerCode, plan.variantId, plan.amount, plan.currency, plan.interval, plan.intervalCount, ref], { conflictColumns: ['provider', 'variantId', 'amount', 'currency', 'interval', 'intervalCount'] }).catch(() => undefined);
        return ref;
    }

    // ── Queries ─────────────────────────────────────────────────────────
    private rowToSub(r: any): SubscriptionRow {
        return { ...r, cancelAtPeriodEnd: !!Number(r.cancelAtPeriodEnd), selfScheduled: !!Number(r.selfScheduled), amount: Number(r.amount), quantity: Number(r.quantity), intervalCount: Number(r.intervalCount), failures: Number(r.failures || 0) };
    }

    async findOne(id: number): Promise<SubscriptionRow | null> {
        const [r] = await this.db.query(`SELECT * FROM hulo_subscription WHERE id = ?`, [id]);
        return r ? this.rowToSub(r) : null;
    }

    async listForCustomer(customerId: number): Promise<SubscriptionRow[]> {
        return (await this.db.query(`SELECT * FROM hulo_subscription WHERE customerId = ? ORDER BY id DESC`, [customerId])).map((r: any) => this.rowToSub(r));
    }

    async list(opts: { status?: string; search?: string; page?: number; perPage?: number }): Promise<{ items: SubscriptionRow[]; totalItems: number; page: number; perPage: number }> {
        const where: string[] = []; const params: any[] = [];
        if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
        if (opts.search) { where.push('(orderCode LIKE ? OR customerEmail LIKE ? OR variantName LIKE ? OR providerSubscriptionRef LIKE ?)'); const like = `%${opts.search.slice(0, 80)}%`; params.push(like, like, like, like); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const perPage = Math.min(200, Math.max(5, Number(opts.perPage) || 50)); const page = Math.max(1, Number(opts.page) || 1);
        const [count] = await this.db.query(`SELECT COUNT(*) AS n FROM hulo_subscription ${whereSql}`, params);
        const items = (await this.db.query(`SELECT * FROM hulo_subscription ${whereSql} ORDER BY id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params)).map((r: any) => this.rowToSub(r));
        return { items, totalItems: Number(count?.n || 0), page, perPage };
    }

    async stats(): Promise<{ active: number; trialing: number; pastDue: number; canceled30d: number; mrr: Record<string, number> }> {
        const rows = await this.db.query(`SELECT status, currency, \`interval\`, intervalCount, amount, quantity, updatedAt FROM hulo_subscription`);
        const mrr: Record<string, number> = {};
        let active = 0, trialing = 0, pastDue = 0, canceled30d = 0;
        const cutoff = Date.now() - 30 * 86400_000;
        for (const r of rows) {
            if (r.status === 'active' || r.status === 'trialing') {
                if (r.status === 'active') active++; else trialing++;
                const months = ({ day: 1 / 30, week: 7 / 30, month: 1, year: 12 } as any)[r.interval] * Number(r.intervalCount || 1);
                mrr[r.currency] = (mrr[r.currency] || 0) + Math.round(Number(r.amount) * Number(r.quantity) / (months || 1));
            } else if (r.status === 'past_due') pastDue++;
            else if (r.status === 'canceled' && new Date(r.updatedAt).getTime() > cutoff) canceled30d++;
        }
        return { active, trialing, pastDue, canceled30d, mrr };
    }

    // ── Actions ─────────────────────────────────────────────────────────
    private async update(id: number, fields: Record<string, any>): Promise<void> {
        const keys = Object.keys(fields);
        if (!keys.length) return;
        await this.db.query(`UPDATE hulo_subscription SET ${keys.map(k => `\`${k}\` = ?`).join(', ')}, updatedAt = NOW() WHERE id = ?`, [...keys.map(k => fields[k]), id]);
    }

    private sqlDate(iso: string | Date | null | undefined): string | null {
        if (!iso) return null;
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
    }

    async cancel(id: number, atPeriodEnd: boolean, actor: string): Promise<SubscriptionRow> {
        const sub = await this.findOne(id);
        if (!sub) throw new Error('Subscription not found');
        if (sub.status === 'canceled') return sub;
        const provider = getProvider(sub.provider);
        const method = await resolveMethod(this.connection, sub.provider, sub.channelId || undefined);
        if (provider?.cancelSubscription && method && !sub.selfScheduled && !sub.providerSubscriptionRef.startsWith('hulo-')) {
            const r = await provider.cancelSubscription(method.args, sub.providerSubscriptionRef, atPeriodEnd);
            await this.update(id, atPeriodEnd && r.status !== 'canceled' ? { cancelAtPeriodEnd: 1 } : { status: 'canceled', cancelAtPeriodEnd: 0 });
        } else {
            await this.update(id, atPeriodEnd ? { cancelAtPeriodEnd: 1 } : { status: 'canceled', cancelAtPeriodEnd: 0, nextChargeAt: null });
        }
        await this.ledger.record({ channelId: sub.channelId, provider: sub.provider, kind: 'renewal', status: 'ok', orderId: sub.orderId, orderCode: sub.orderCode, paymentRef: sub.providerSubscriptionRef, amount: 0, currency: sub.currency, reason: `${atPeriodEnd ? 'cancel at period end' : 'cancelled'} by ${actor}`, meta: { subscriptionId: id, action: 'cancel' } });
        return (await this.findOne(id))!;
    }

    async pause(id: number, resume: boolean): Promise<SubscriptionRow> {
        const sub = await this.findOne(id);
        if (!sub) throw new Error('Subscription not found');
        const provider = getProvider(sub.provider);
        const method = await resolveMethod(this.connection, sub.provider, sub.channelId || undefined);
        if (provider?.pauseSubscription && method && !sub.selfScheduled) {
            const r = await provider.pauseSubscription(method.args, sub.providerSubscriptionRef, resume);
            await this.update(id, { status: r.status });
        } else {
            await this.update(id, { status: resume ? 'active' : 'paused', nextChargeAt: resume ? this.sqlDate(new Date(Math.max(Date.now(), new Date(sub.currentPeriodEnd || Date.now()).getTime()))) : null });
        }
        return (await this.findOne(id))!;
    }

    // ── Webhook events ──────────────────────────────────────────────────
    async applyEvent(providerCode: string, ev: NormalisedEvent, args: ProviderArgs): Promise<void> {
        // Tokens arriving after the order paid (Adyen RECURRING_CONTRACT / AUTHORISATION, Mollie mandate).
        if (ev.subscription?.paymentRef && ev.orderCode && (ev.type === 'payment.authorized' || ev.type === 'payment.settled' || ev.type === 'subscription.updated')) {
            const pending = await this.db.query(`SELECT * FROM hulo_subscription WHERE orderCode = ? AND provider = ? AND status = 'pending'`, [ev.orderCode, providerCode]);
            for (const raw of pending) {
                const sub = this.rowToSub(raw);
                if (sub.providerSubscriptionRef.startsWith('hulo-pending:')) {
                    // Mollie: create the real subscription now that the mandate exists.
                    const provider = getProvider(providerCode);
                    if (provider?.createSubscription) {
                        try {
                            const out = await provider.createSubscription(args, { variantId: sub.variantId, name: sub.variantName, amount: sub.amount, currency: sub.currency, interval: sub.interval as any, intervalCount: sub.intervalCount, trialDays: 0, quantity: sub.quantity, orderCode: sub.orderCode, customerEmail: sub.customerEmail, providerCustomerRef: ev.subscription.customerRef || sub.providerCustomerRef || undefined, providerPaymentRef: ev.subscription.paymentRef });
                            await this.update(sub.id, { providerSubscriptionRef: out.providerSubscriptionRef, status: out.status, providerCustomerRef: out.providerCustomerRef || sub.providerCustomerRef, providerPaymentRef: out.providerPaymentRef || ev.subscription.paymentRef, currentPeriodEnd: this.sqlDate(out.currentPeriodEnd) });
                        } catch (e: any) { Logger.warn(`deferred subscription creation failed for ${sub.orderCode}: ${e.message}`, loggerCtx); }
                    }
                } else {
                    await this.update(sub.id, { status: 'active', providerPaymentRef: ev.subscription.paymentRef, providerCustomerRef: ev.subscription.customerRef || sub.providerCustomerRef });
                }
            }
            if (!ev.type.startsWith('subscription.')) return;
        }
        if (!ev.subscriptionRef) return;
        const [raw] = await this.db.query(`SELECT * FROM hulo_subscription WHERE providerSubscriptionRef = ? AND provider = ?`, [ev.subscriptionRef, providerCode]);
        if (!raw) return;
        const sub = this.rowToSub(raw);
        const periodEnd = ev.subscription?.currentPeriodEnd ? this.sqlDate(ev.subscription.currentPeriodEnd) : null;
        switch (ev.type) {
            case 'subscription.active':
                await this.update(sub.id, { status: 'active', ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}), failures: 0, approveUrl: null });
                return;
            case 'subscription.renewed':
                await this.update(sub.id, { status: 'active', failures: 0, currentPeriodEnd: periodEnd || this.sqlDate(new Date(Date.now() + intervalMs(sub.interval, sub.intervalCount))) });
                await this.ledger.record({ channelId: sub.channelId, provider: providerCode, kind: 'renewal', status: 'ok', orderId: sub.orderId, orderCode: sub.orderCode, paymentRef: ev.paymentRef || ev.subscriptionRef, amount: ev.amount ?? sub.amount * sub.quantity, currency: ev.currency || sub.currency, meta: { subscriptionId: sub.id, eventId: ev.id } });
                return;
            case 'subscription.payment_failed':
                await this.update(sub.id, { status: 'past_due', failures: sub.failures + 1 });
                await this.ledger.record({ channelId: sub.channelId, provider: providerCode, kind: 'renewal', status: 'failed', orderId: sub.orderId, orderCode: sub.orderCode, paymentRef: ev.paymentRef || ev.subscriptionRef, amount: ev.amount ?? sub.amount * sub.quantity, currency: ev.currency || sub.currency, reason: ev.reason || 'renewal payment failed', meta: { subscriptionId: sub.id } });
                await getRuntime().notifyOps({ kind: 'payments.subscription.past_due', subject: `Renewal failed: ${sub.variantName} for ${sub.customerEmail}`, text: `${providerCode} could not collect the renewal for subscription ${sub.providerSubscriptionRef} (order ${sub.orderCode})${ev.reason ? `: ${ev.reason}` : ''}.`, orderCode: sub.orderCode, channelId: sub.channelId });
                return;
            case 'subscription.canceled':
                await this.update(sub.id, { status: 'canceled', cancelAtPeriodEnd: 0, nextChargeAt: null });
                return;
            case 'subscription.paused':
                await this.update(sub.id, { status: 'paused' });
                return;
            case 'subscription.updated': {
                const fields: Record<string, any> = {};
                const st = ev.subscription?.status;
                if (st) fields.status = st === 'trialing' ? 'trialing' : st === 'active' ? 'active' : st === 'past_due' || st === 'unpaid' ? 'past_due' : st === 'paused' ? 'paused' : st === 'canceled' ? 'canceled' : sub.status;
                if (periodEnd) fields.currentPeriodEnd = periodEnd;
                if (ev.subscription?.cancelAtPeriodEnd !== undefined) fields.cancelAtPeriodEnd = ev.subscription.cancelAtPeriodEnd ? 1 : 0;
                await this.update(sub.id, fields);
                return;
            }
            default: return;
        }
    }

    // ── Scheduler ───────────────────────────────────────────────────────
    /** Charge due self-scheduled renewals and apply period-end cancellations. Returns counts. */
    async runScheduler(): Promise<{ charged: number; failed: number; canceled: number }> {
        const out = { charged: 0, failed: 0, canceled: 0 };
        if (!getRuntime().hasPremiumAccess()) return out;
        // Period-end cancellations for providers without a native "cancel at period end".
        const ending = await this.db.query(`SELECT * FROM hulo_subscription WHERE cancelAtPeriodEnd = 1 AND status IN ('active','trialing','past_due') AND currentPeriodEnd IS NOT NULL AND currentPeriodEnd <= NOW()`);
        for (const raw of ending) {
            const sub = this.rowToSub(raw);
            const provider = getProvider(sub.provider);
            const method = await resolveMethod(this.connection, sub.provider, sub.channelId || undefined);
            try {
                if (provider?.cancelSubscription && method && !sub.selfScheduled && !sub.providerSubscriptionRef.startsWith('hulo-')) await provider.cancelSubscription(method.args, sub.providerSubscriptionRef, false);
                await this.update(sub.id, { status: 'canceled', cancelAtPeriodEnd: 0, nextChargeAt: null });
                out.canceled++;
            } catch (e: any) { Logger.warn(`period-end cancel failed for subscription ${sub.id}: ${e.message}`, loggerCtx); }
        }
        // Self-scheduled renewals (Adyen tokens).
        const due = await this.db.query(`SELECT * FROM hulo_subscription WHERE selfScheduled = 1 AND status IN ('active','past_due') AND nextChargeAt IS NOT NULL AND nextChargeAt <= NOW() LIMIT 100`);
        for (const raw of due) {
            const sub = this.rowToSub(raw);
            const provider = getProvider(sub.provider);
            const method = await resolveMethod(this.connection, sub.provider, sub.channelId || undefined);
            if (!provider?.chargeStored || !method || !sub.providerPaymentRef || !sub.providerCustomerRef) { await this.update(sub.id, { status: 'past_due', failures: sub.failures + 1, nextChargeAt: this.sqlDate(new Date(Date.now() + 86400_000)) }); out.failed++; continue; }
            const periodStart = new Date(sub.currentPeriodEnd || Date.now());
            const reference = `${sub.orderCode}-R${periodStart.toISOString().slice(0, 10).replace(/-/g, '')}-${sub.variantId}`;
            const r = await provider.chargeStored(method.args, { customerRef: sub.providerCustomerRef, paymentRef: sub.providerPaymentRef, amount: sub.amount * sub.quantity, currency: sub.currency, reference, description: `${sub.variantName} × ${sub.quantity} renewal` });
            if (r.state === 'Settled' || r.state === 'Authorized') {
                const nextEnd = new Date(Math.max(periodStart.getTime(), Date.now()) + intervalMs(sub.interval, sub.intervalCount));
                await this.update(sub.id, { status: 'active', failures: 0, currentPeriodEnd: this.sqlDate(nextEnd), nextChargeAt: this.sqlDate(nextEnd) });
                await this.ledger.record({ channelId: sub.channelId, provider: sub.provider, kind: 'renewal', status: 'ok', orderId: sub.orderId, orderCode: sub.orderCode, paymentRef: r.transactionId || reference, amount: sub.amount * sub.quantity, currency: sub.currency, meta: { subscriptionId: sub.id, reference } });
                out.charged++;
            } else {
                const settings = await this.ledger.getSettings(sub.channelId || 1);
                const failures = sub.failures + 1;
                const giveUp = failures >= settings.dunningDays;
                await this.update(sub.id, { status: giveUp ? 'canceled' : 'past_due', failures, nextChargeAt: giveUp ? null : this.sqlDate(new Date(Date.now() + 86400_000)) });
                await this.ledger.record({ channelId: sub.channelId, provider: sub.provider, kind: 'renewal', status: 'failed', orderId: sub.orderId, orderCode: sub.orderCode, paymentRef: r.transactionId || reference, amount: sub.amount * sub.quantity, currency: sub.currency, reason: r.errorMessage || 'declined', meta: { subscriptionId: sub.id, failures } });
                await getRuntime().notifyOps({ kind: 'payments.subscription.past_due', subject: `${giveUp ? 'Subscription cancelled after repeated failures' : 'Renewal failed'}: ${sub.variantName} for ${sub.customerEmail}`, text: `${sub.provider} declined renewal ${reference}${r.errorMessage ? `: ${r.errorMessage}` : ''}. Attempt ${failures} of ${settings.dunningDays}.`, orderCode: sub.orderCode, channelId: sub.channelId });
                out.failed++;
            }
        }
        return out;
    }
}
