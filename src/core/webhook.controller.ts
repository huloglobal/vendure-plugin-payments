import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import { Logger } from '@vendure/core';
import type { Request, Response } from 'express';
import { json as bodyJson, raw as bodyRaw, text as bodyText, urlencoded as bodyUrlencoded } from 'express';
import { TransactionalConnection } from '@vendure/core';
import { getProvider } from './provider';
import { listHuloMethods } from './credentials';
import { LedgerService, loggerCtx } from './ledger.service';
import { PaymentsService } from './payments.service';

/**
 * Raw bodies for every provider webhook: signatures are computed over the
 * exact bytes, so the route is excluded from Vendure's JSON parsing and
 * parsed here.
 */
export const webhookRawBodyMiddleware = {
    route: '/hulo-payments/webhook/:provider',
    handler: bodyRaw({ type: () => true, limit: '2mb' }),
    beforeListen: true,
};

@Controller('hulo-payments')
export class WebhookController {
    constructor(private connection: TransactionalConnection, private ledger: LedgerService, private payments: PaymentsService) {}

    /**
     * One endpoint per provider: `/hulo-payments/webhook/hulo-stripe` etc.
     * Verification happens with the credentials of every enabled method for
     * that provider (multi-channel installs may have several), the first
     * that validates wins. Events are claimed in the ledger before they are
     * applied, so redelivery is harmless.
     */
    @Post('webhook/:provider')
    async webhook(@Param('provider') providerCode: string, @Req() req: Request, @Res() res: Response) {
        const provider = getProvider(providerCode);
        if (!provider) return res.status(404).json({ error: 'unknown provider' });
        const raw: Buffer | string = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
        const all = (await listHuloMethods(this.connection)).filter(m => m.handlerCode === providerCode);
        if (!all.length) return res.status(404).json({ error: `no ${providerCode} payment method` });
        // A configured-but-disabled method still owns its webhook endpoint: acknowledge what the provider
        // sends (after verifying it) instead of failing, otherwise the provider marks the endpoint as broken
        // and switches it off, and the admin sees "webhook error" the moment they enable the method.
        const methods = all.filter(m => m.enabled);
        if (!methods.length) {
            for (const m of all) {
                try {
                    const v = await provider.verifyWebhook(m.args, raw, req.headers as any, (req.query || {}) as any);
                    if (v.ok) return res.status(200).json({ received: true, ignored: true, reason: 'payment method disabled' });
                } catch { /* try the next method's secret */ }
            }
            return res.status(400).json({ error: 'verification failed (payment method disabled)' });
        }
        let lastError = '';
        for (const m of methods) {
            let v;
            try { v = await provider.verifyWebhook(m.args, raw, req.headers as any, (req.query || {}) as any); }
            catch (e: any) { lastError = e.message; continue; }
            if (!v.ok) { lastError = v.error || 'verification failed'; continue; }
            for (const ev of v.events) {
                if (ev.type === 'ignored') continue;
                if (!(await this.ledger.claimEvent(providerCode, ev.id, ev.type, ev.orderCode || null))) continue;
                try {
                    await this.payments.applyEvent(providerCode, ev, m);
                    await this.ledger.finishEvent(providerCode, ev.id);
                } catch (e: any) {
                    Logger.error(`${providerCode} webhook ${ev.type} (${ev.id}) failed: ${e.message}`, loggerCtx);
                    await this.ledger.finishEvent(providerCode, ev.id, e.message);
                }
            }
            if (v.reply !== undefined) return res.status(200).type('text/plain').send(typeof v.reply === 'string' ? v.reply : JSON.stringify(v.reply));
            return res.status(200).json({ received: true, events: v.events.filter(e => e.type !== 'ignored').length });
        }
        Logger.warn(`${providerCode} webhook rejected: ${lastError}`, loggerCtx);
        return res.status(400).json({ error: lastError || 'verification failed' });
    }
}

// Re-exported so hosts that already parse bodies can opt out.
export const bodyParsers = { bodyJson, bodyText, bodyUrlencoded };
