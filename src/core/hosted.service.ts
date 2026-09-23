import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ID, TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';

export interface HostedSession {
    id: number;
    token: string;
    orderId: number;
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

    async onModuleInit() { await this.ensureSchema(); }

    async ensureSchema(): Promise<void> {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS hulo_hosted_session (
                id INT AUTO_INCREMENT PRIMARY KEY,
                token VARCHAR(64) NOT NULL,
                orderId INT NOT NULL,
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
    }

    async create(orderId: ID, orderCode: string, channelId: number, returnUrl: string, cancelUrl: string, locale: string, preferredMethod?: string): Promise<HostedSession> {
        const token = randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + TTL_MS);
        await this.db.query(
            `INSERT INTO hulo_hosted_session (token, orderId, orderCode, channelId, returnUrl, cancelUrl, locale, lastMethodCode, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [token, Number(orderId), orderCode, channelId, String(returnUrl || '').slice(0, 1000), String(cancelUrl || '').slice(0, 1000), String(locale || 'en-GB').slice(0, 16), preferredMethod ? String(preferredMethod).slice(0, 64) : null, expires.toISOString().slice(0, 19).replace('T', ' ')]);
        return (await this.find(token))!;
    }

    async find(token: string): Promise<HostedSession | null> {
        if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
        const [row] = await this.db.query(`SELECT * FROM hulo_hosted_session WHERE token = ?`, [token]);
        return row ? { ...row, id: Number(row.id), orderId: Number(row.orderId), channelId: Number(row.channelId) } : null;
    }

    isLive(s: HostedSession): boolean { return !s.completedAt && new Date(s.expiresAt).getTime() > Date.now(); }

    async remember(token: string, methodCode: string, sessionId: string | undefined): Promise<void> {
        await this.db.query(`UPDATE hulo_hosted_session SET lastMethodCode = ?, lastSessionId = ? WHERE token = ?`, [methodCode.slice(0, 64), sessionId ? String(sessionId).slice(0, 190) : null, token]);
    }

    async complete(token: string): Promise<void> {
        await this.db.query(`UPDATE hulo_hosted_session SET completedAt = NOW() WHERE token = ?`, [token]);
    }
}
