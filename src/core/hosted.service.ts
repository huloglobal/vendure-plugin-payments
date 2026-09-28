import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ID, Logger, TransactionalConnection } from '@vendure/core';
import { loggerCtx } from './ledger.service';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';

export interface HostedSession {
    id: number;
    token: string;
    /** Vendure order id as text: integer or UUID depending on the host's id strategy. */
    orderId: string;
    orderCode: string;
    channelId: number;
    returnUrl: string;
    cancelUrl: string;
    locale: string;
    lastMethodCode: string | null;
    lastSessionId: string | null;
    createdAt: string;
    expiresAt: string;
    completedAt: string | null;
}

const TTL_MS = 2 * 3600_000;

/**
 * Hosted checkout sessions: an unguessable token that lets the plugin's own
 * payment page act on one order for a couple of hours. The storefront asks
 * for the URL, sends the customer there, and gets them back with the order
 * paid — no provider client code on the storefront at all.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class HostedCheckoutService implements OnModuleInit {
    constructor(private connection: TransactionalConnection) {}
    private get db() { return adapterFor(this.connection.rawConnection); }

    async onModuleInit() {
        await this.ensureSchema();
        // Retention: a row per checkout attempt, never read again a week after it expired.
        const purge = () => this.purge().catch(() => undefined);
        void purge();
        const t = setInterval(purge, 6 * 3600_000);
        if (typeof t.unref === 'function') t.unref();
    }

    /** Rows whose link expired more than 7 days ago. */
    async purge(): Promise<number> {
        const r = await this.db.query(`DELETE FROM hulo_hosted_session WHERE expiresAt < DATE_SUB(NOW(), INTERVAL 7 DAY)`, [], { needAffected: true });
        return Number(r?.affectedRows || 0);
    }

    async ensureSchema(): Promise<void> {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_hosted_session (
                id INT AUTO_INCREMENT PRIMARY KEY,
                token VARCHAR(64) NOT NULL,
                orderId VARCHAR(36) NOT NULL,
                orderCode VARCHAR(32) NOT NULL,
                channelId INT NOT NULL,
                returnUrl VARCHAR(1000) NOT NULL DEFAULT '',
                cancelUrl VARCHAR(1000) NOT NULL DEFAULT '',
                locale VARCHAR(16) NOT NULL DEFAULT 'en-GB',
                lastMethodCode VARCHAR(64) NULL,
                lastSessionId VARCHAR(190) NULL,
                createdAt DATETIME NOT NULL,
                expiresAt DATETIME NOT NULL,
                completedAt DATETIME NULL,
                UNIQUE KEY uq_hhs_token (token),
                INDEX idx_hhs_order (orderId)
            )`);
        // 0.2.8: a completion lease and a per-link session counter.
        for (const ddl of [
            'ALTER TABLE hulo_hosted_session ADD COLUMN IF NOT EXISTS completingAt DATETIME NULL',
            'ALTER TABLE hulo_hosted_session ADD COLUMN IF NOT EXISTS sessionCount INT NOT NULL DEFAULT 0',
        ]) {
            try { await this.db.query(ddl); } catch (e: any) { if (!/duplicate|exists/i.test(String(e?.message || ''))) throw e; }
        }
        await this.widenOrderId();
    }

    /** 0.2.9: `orderId` was INT, which no host on Vendure's UUID id strategy could use; widen it in place. */
    private async widenOrderId(): Promise<void> {
        try {
            const scope = this.db.dialect === 'postgres' ? 'table_catalog = current_database() AND table_schema = current_schema()' : 'table_schema = DATABASE()';
            const rows: any[] = await this.db.query(`SELECT data_type AS dt FROM information_schema.columns WHERE ${scope} AND LOWER(table_name) = 'hulo_hosted_session' AND LOWER(column_name) = 'orderid'`);
            const dt = String(rows?.[0]?.dt ?? rows?.[0]?.DT ?? '').toLowerCase();
            if (!dt || /char|text/.test(dt)) return;
            await this.db.query(this.db.dialect === 'postgres'
                ? `ALTER TABLE hulo_hosted_session ALTER COLUMN orderId TYPE VARCHAR(36) USING orderId::varchar`
                : `ALTER TABLE hulo_hosted_session MODIFY orderId VARCHAR(36) NOT NULL`);
            Logger.info('hulo_hosted_session.orderId widened to VARCHAR(36)', loggerCtx);
        } catch (e: any) {
            Logger.warn(`could not widen hulo_hosted_session.orderId (run it by hand: ALTER TABLE hulo_hosted_session MODIFY orderId VARCHAR(36) NOT NULL): ${e?.message || e}`, loggerCtx);
        }
    }

    /** Claim the right to run `/complete` for one minute; false when another call holds it or the link is spent. */
    async beginComplete(token: string): Promise<boolean> {
        const r = await this.db.query(
            `UPDATE hulo_hosted_session SET completingAt = NOW()
              WHERE token = ? AND completedAt IS NULL AND (completingAt IS NULL OR completingAt < DATE_SUB(NOW(), INTERVAL 1 MINUTE))`,
            [token], { needAffected: true },
        );
        return Number(r?.affectedRows ?? r?.rowCount ?? 0) > 0;
    }

    async releaseComplete(token: string): Promise<void> {
        await this.db.query(`UPDATE hulo_hosted_session SET completingAt = NULL WHERE token = ?`, [token]).catch(() => undefined);
    }

    /** Count a provider-session creation on this link; returns the new total. */
    async bumpSessionCount(token: string): Promise<number> {
        await this.db.query(`UPDATE hulo_hosted_session SET sessionCount = sessionCount + 1 WHERE token = ?`, [token]).catch(() => undefined);
        const [row] = await this.db.query(`SELECT sessionCount FROM hulo_hosted_session WHERE token = ?`, [token]).catch(() => [] as any[]);
        return Number(row?.sessionCount || 0);
    }

    async create(orderId: ID, orderCode: string, channelId: number, returnUrl: string, cancelUrl: string, locale: string, preferredMethod?: string): Promise<HostedSession> {
        const token = randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + TTL_MS);
        await this.db.query(
            `INSERT INTO hulo_hosted_session (token, orderId, orderCode, channelId, returnUrl, cancelUrl, locale, lastMethodCode, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [token, String(orderId), orderCode, channelId, String(returnUrl || '').slice(0, 1000), String(cancelUrl || '').slice(0, 1000), String(locale || 'en-GB').slice(0, 16), preferredMethod ? String(preferredMethod).slice(0, 64) : null, expires]);
        return (await this.find(token))!;
    }

    async find(token: string): Promise<HostedSession | null> {
        if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
        const [row] = await this.db.query(`SELECT * FROM hulo_hosted_session WHERE token = ?`, [token]);
        return row ? { ...row, id: Number(row.id), orderId: String(row.orderId), channelId: Number(row.channelId) } : null;
    }

    isLive(s: HostedSession): boolean { return !s.completedAt && new Date(s.expiresAt).getTime() > Date.now(); }

    async remember(token: string, methodCode: string, sessionId: string | undefined): Promise<void> {
        await this.db.query(`UPDATE hulo_hosted_session SET lastMethodCode = ?, lastSessionId = ? WHERE token = ?`, [methodCode.slice(0, 64), sessionId ? String(sessionId).slice(0, 190) : null, token]);
    }

    async complete(token: string): Promise<void> {
        await this.db.query(`UPDATE hulo_hosted_session SET completedAt = NOW() WHERE token = ?`, [token]);
    }
}
