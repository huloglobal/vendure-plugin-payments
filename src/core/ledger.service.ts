import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';

export const loggerCtx = 'HuloPayments';

export type TxnKind = 'authorize' | 'capture' | 'cancel' | 'refund' | 'dispute' | 'failure' | 'renewal' | 'paylink';
export type TxnStatus = 'ok' | 'failed' | 'pending' | 'open' | 'won' | 'lost';

export interface TxnInput {
    channelId?: number | null;
    provider: string;
    kind: TxnKind;
    status: TxnStatus;
    orderId?: number | null;
    orderCode?: string | null;
    paymentRef?: string | null;
    amount?: number | null;
    currency?: string | null;
    reason?: string | null;
    meta?: Record<string, any> | null;
}

export interface ChannelSettings {
    channelId: number;
    /** Provider handler codes in preferred order (first = default). */
    providerOrder: string[];
    /** Offer the next provider when the first declines. */
    fallbackOnFailure: boolean;
    /** Offer "save this card" to signed-in customers by default. */
    saveCardsDefault: boolean;
    /** Per handler code: { type: 'percent'|'fixed', value } added as a surcharge line. */
    surcharges: Record<string, { type: 'percent' | 'fixed'; value: number; label?: string }>;
    /** Where dispute / failed-renewal alerts go. */
    opsEmail: string;
    /** Days before a past-due subscription is cancelled by the scheduler. */
    dunningDays: number;
}

export const DEFAULT_SETTINGS: Omit<ChannelSettings, 'channelId'> = {
    providerOrder: ['hulo-stripe', 'hulo-adyen', 'hulo-paypal', 'hulo-mollie'],
    fallbackOnFailure: true,
    saveCardsDefault: true,
    surcharges: {},
    opsEmail: '',
    dunningDays: 7,
};

/**
 * The payments ledger: every authorisation, capture, refund, dispute,
 * failure, renewal and pay-link lands here regardless of provider, which
 * is what makes one dashboard (and one reconciliation) possible. Also owns
 * webhook idempotency, provider customer references and channel settings.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class LedgerService implements OnModuleInit {
    constructor(private connection: TransactionalConnection) {}
    private get db() { return adapterFor(this.connection.rawConnection); }

    async onModuleInit() { await this.ensureSchema(); }

    async ensureSchema(): Promise<void> {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_payment_txn (
                id INT AUTO_INCREMENT PRIMARY KEY,
                channelId INT NULL,
                provider VARCHAR(32) NOT NULL,
                kind VARCHAR(16) NOT NULL,
                status VARCHAR(16) NOT NULL,
                orderId INT NULL,
                orderCode VARCHAR(32) NULL,
                paymentRef VARCHAR(190) NULL,
                amount INT NULL,
                currency VARCHAR(3) NULL,
                reason VARCHAR(500) NULL,
                meta TEXT NULL,
                createdAt DATETIME NOT NULL,
                INDEX idx_hpt_created (createdAt),
                INDEX idx_hpt_order (orderCode),
                INDEX idx_hpt_ref (paymentRef),
                INDEX idx_hpt_kind (provider, kind, status)
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_payment_event (
                id INT AUTO_INCREMENT PRIMARY KEY,
                provider VARCHAR(32) NOT NULL,
                eventId VARCHAR(190) NOT NULL,
                type VARCHAR(64) NOT NULL,
                orderCode VARCHAR(32) NULL,
                receivedAt DATETIME NOT NULL,
                processedAt DATETIME NULL,
                error VARCHAR(500) NULL,
                UNIQUE KEY uq_hpe (provider, eventId)
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_payment_customer (
                id INT AUTO_INCREMENT PRIMARY KEY,
                provider VARCHAR(32) NOT NULL,
                customerId INT NOT NULL,
                email VARCHAR(190) NOT NULL DEFAULT '',
                providerCustomerRef VARCHAR(190) NOT NULL,
                createdAt DATETIME NOT NULL,
                UNIQUE KEY uq_hpc (provider, customerId)
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_payment_settings (
                channelId INT PRIMARY KEY,
                providerOrder TEXT NULL,
                fallbackOnFailure TINYINT NOT NULL DEFAULT 1,
                saveCardsDefault TINYINT NOT NULL DEFAULT 1,
                surchargeJson TEXT NULL,
                opsEmail VARCHAR(190) NOT NULL DEFAULT '',
                dunningDays INT NOT NULL DEFAULT 7,
                updatedAt DATETIME NOT NULL
            )`);
    }

    // ── Transactions ────────────────────────────────────────────────────
    async record(t: TxnInput): Promise<number> {
        try {
            const res = await this.db.query(
                `INSERT INTO hulo_payment_txn (channelId, provider, kind, status, orderId, orderCode, paymentRef, amount, currency, reason, meta, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [t.channelId ?? null, t.provider, t.kind, t.status, t.orderId ?? null, t.orderCode ?? null,
                 t.paymentRef ? String(t.paymentRef).slice(0, 190) : null, t.amount ?? null,
                 t.currency ? String(t.currency).toUpperCase().slice(0, 3) : null,
                 t.reason ? String(t.reason).slice(0, 500) : null, t.meta ? JSON.stringify(t.meta).slice(0, 60000) : null],
                { needInsertId: true },
            );
            return Number(res?.insertId || 0);
        } catch (e: any) {
            Logger.warn(`ledger write failed: ${e.message}`, loggerCtx);
            return 0;
        }
    }

    async list(opts: { channelId?: number | null; provider?: string; kind?: string; status?: string; orderCode?: string; days?: number; page?: number; perPage?: number }): Promise<{ items: any[]; totalItems: number; page: number; perPage: number }> {
        const where: string[] = []; const params: any[] = [];
        if (opts.channelId) { where.push('channelId = ?'); params.push(opts.channelId); }
        if (opts.provider) { where.push('provider = ?'); params.push(opts.provider); }
        if (opts.kind && opts.kind !== 'all') { where.push('kind = ?'); params.push(opts.kind); }
        if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
        if (opts.orderCode) { where.push('orderCode LIKE ?'); params.push(`%${opts.orderCode.slice(0, 32)}%`); }
        if (opts.days) { where.push('createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)'); params.push(Number(opts.days)); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const perPage = Math.min(200, Math.max(5, Number(opts.perPage) || 50));
        const page = Math.max(1, Number(opts.page) || 1);
        const [count] = await this.db.query(`SELECT COUNT(*) AS n FROM hulo_payment_txn ${whereSql}`, params);
        const items = await this.db.query(
            `SELECT id, channelId, provider, kind, status, orderId, orderCode, paymentRef, amount, currency, reason, createdAt
             FROM hulo_payment_txn ${whereSql} ORDER BY id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params);
        return { items, totalItems: Number(count?.n || 0), page, perPage };
    }

    async stats(channelId: number | null, days = 30): Promise<any> {
        const where = channelId ? 'WHERE channelId = ? AND' : 'WHERE';
        const params = channelId ? [channelId] : [];
        const byProvider = await this.db.query(
            `SELECT provider,
                    SUM(CASE WHEN kind IN ('capture','renewal') AND status = 'ok' THEN amount ELSE 0 END) AS volume,
                    SUM(CASE WHEN kind IN ('capture','renewal') AND status = 'ok' THEN 1 ELSE 0 END) AS captures,
                    SUM(CASE WHEN kind = 'failure' THEN 1 ELSE 0 END) AS failures,
                    SUM(CASE WHEN kind = 'refund' AND status = 'ok' THEN amount ELSE 0 END) AS refunded,
                    SUM(CASE WHEN kind = 'dispute' THEN 1 ELSE 0 END) AS disputes
             FROM hulo_payment_txn ${where} createdAt > DATE_SUB(NOW(), INTERVAL ${Number(days) || 30} DAY)
             GROUP BY provider`, params);
        const byDay = await this.db.query(
            `SELECT DATE(createdAt) AS day, provider,
                    SUM(CASE WHEN kind IN ('capture','renewal') AND status = 'ok' THEN amount ELSE 0 END) AS volume
             FROM hulo_payment_txn ${where} createdAt > DATE_SUB(NOW(), INTERVAL ${Number(days) || 30} DAY)
             GROUP BY DATE(createdAt), provider ORDER BY day ASC`, params);
        const [open] = await this.db.query(
            `SELECT SUM(CASE WHEN kind = 'dispute' AND status = 'open' THEN 1 ELSE 0 END) AS openDisputes,
                    SUM(CASE WHEN kind = 'authorize' AND status = 'ok' THEN 1 ELSE 0 END) AS authorisations
             FROM hulo_payment_txn ${where} createdAt > DATE_SUB(NOW(), INTERVAL 90 DAY)`, params);
        const captures = byProvider.reduce((n: number, r: any) => n + Number(r.captures || 0), 0);
        const failures = byProvider.reduce((n: number, r: any) => n + Number(r.failures || 0), 0);
        return {
            days,
            byProvider,
            byDay,
            totals: {
                volume: byProvider.reduce((n: number, r: any) => n + Number(r.volume || 0), 0),
                captures,
                failures,
                successRate: captures + failures ? Math.round((captures / (captures + failures)) * 1000) / 10 : null,
                refunded: byProvider.reduce((n: number, r: any) => n + Number(r.refunded || 0), 0),
                disputes: byProvider.reduce((n: number, r: any) => n + Number(r.disputes || 0), 0),
                openDisputes: Number(open?.openDisputes || 0),
            },
        };
    }

    // ── Webhook idempotency ─────────────────────────────────────────────
    /** True when this event has not been seen before (and is now claimed). */
    async claimEvent(provider: string, eventId: string, type: string, orderCode?: string | null): Promise<boolean> {
        try {
            await this.db.query(
                `INSERT INTO hulo_payment_event (provider, eventId, type, orderCode, receivedAt) VALUES (?, ?, ?, ?, NOW())`,
                [provider, String(eventId).slice(0, 190), String(type).slice(0, 64), orderCode || null]);
            return true;
        } catch {
            return false; // duplicate delivery
        }
    }

    async finishEvent(provider: string, eventId: string, error?: string): Promise<void> {
        await this.db.query(`UPDATE hulo_payment_event SET processedAt = NOW(), error = ? WHERE provider = ? AND eventId = ?`,
            [error ? String(error).slice(0, 500) : null, provider, String(eventId).slice(0, 190)]).catch(() => undefined);
    }

    async recentEvents(limit = 50): Promise<any[]> {
        return this.db.query(`SELECT provider, eventId, type, orderCode, receivedAt, processedAt, error FROM hulo_payment_event ORDER BY id DESC LIMIT ${Math.min(200, limit)}`).catch(() => []);
    }

    // ── Provider customers ──────────────────────────────────────────────
    async getCustomerRef(provider: string, customerId: number): Promise<string | null> {
        const [row] = await this.db.query(`SELECT providerCustomerRef FROM hulo_payment_customer WHERE provider = ? AND customerId = ?`, [provider, customerId]).catch(() => []);
        return row?.providerCustomerRef || null;
    }

    async setCustomerRef(provider: string, customerId: number, email: string, ref: string): Promise<void> {
        await this.db.query(
            `INSERT INTO hulo_payment_customer (provider, customerId, email, providerCustomerRef, createdAt) VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE providerCustomerRef = VALUES(providerCustomerRef), email = VALUES(email)`,
            [provider, customerId, String(email || '').slice(0, 190), String(ref).slice(0, 190)], { conflictColumns: ['provider', 'customerId'] });
    }

    // ── Settings ────────────────────────────────────────────────────────
    async getSettings(channelId: number): Promise<ChannelSettings> {
        const [row] = await this.db.query(`SELECT * FROM hulo_payment_settings WHERE channelId = ?`, [channelId]).catch(() => []);
        if (!row) return { ...DEFAULT_SETTINGS, channelId };
        let providerOrder = DEFAULT_SETTINGS.providerOrder; let surcharges = {};
        try { providerOrder = row.providerOrder ? JSON.parse(row.providerOrder) : providerOrder; } catch { /* keep default */ }
        try { surcharges = row.surchargeJson ? JSON.parse(row.surchargeJson) : {}; } catch { /* keep default */ }
        return {
            channelId,
            providerOrder,
            fallbackOnFailure: !!Number(row.fallbackOnFailure ?? 1),
            saveCardsDefault: !!Number(row.saveCardsDefault ?? 1),
            surcharges,
            opsEmail: row.opsEmail || '',
            dunningDays: Number(row.dunningDays ?? 7),
        };
    }

    async saveSettings(s: ChannelSettings): Promise<void> {
        await this.db.query(
            `INSERT INTO hulo_payment_settings (channelId, providerOrder, fallbackOnFailure, saveCardsDefault, surchargeJson, opsEmail, dunningDays, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE providerOrder = VALUES(providerOrder), fallbackOnFailure = VALUES(fallbackOnFailure),
                saveCardsDefault = VALUES(saveCardsDefault), surchargeJson = VALUES(surchargeJson), opsEmail = VALUES(opsEmail),
                dunningDays = VALUES(dunningDays), updatedAt = NOW()`,
            [s.channelId, JSON.stringify((s.providerOrder || []).filter(c => typeof c === 'string').slice(0, 10)),
             s.fallbackOnFailure ? 1 : 0, s.saveCardsDefault ? 1 : 0, JSON.stringify(s.surcharges || {}).slice(0, 4000),
             String(s.opsEmail || '').slice(0, 190), Math.max(1, Math.min(60, Number(s.dunningDays) || 7))],
            { conflictColumns: ['channelId'] });
    }
}
