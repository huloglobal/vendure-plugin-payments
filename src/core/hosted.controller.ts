import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ChannelService, Logger, Order, OrderService, RequestContext, RequestContextService, TransactionalConnection } from '@vendure/core';
import type { Request, Response } from 'express';
import { HostedCheckoutService } from './hosted.service';
import { PaymentsService } from './payments.service';
import { LedgerService, loggerCtx } from './ledger.service';
import { esc, renderHostedPage } from './hosted-page';
import { getProvider } from './provider';
import { listHuloMethods } from './credentials';
import { getRuntime } from './runtime';

/**
 * Public endpoints behind the hosted checkout token. Everything here acts
 * on exactly one order for the token's lifetime; nothing needs a customer
 * session.
 */
/** Order states in which the order has been paid (or is being fulfilled) and the link must not take another payment. */
const PAID_STATES = ['PaymentSettled', 'PaymentAuthorized', 'Delivered', 'Shipped', 'PartiallyDelivered', 'PartiallyShipped'];
const METHOD_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Keys the hosted page may pass through to the payment handler (client-supplied; everything else is dropped). */
const METADATA_KEYS = ['paymentIntentId', 'sessionId', 'sessionResult', 'resultCode', 'paypalOrderId', 'sourceId', 'nonce', 'deviceData', 'molliePaymentId', 'billingRequestId', 'chargeCode', 'token'];
const MAX_SESSIONS_PER_LINK = 30;

function securityHeaders(res: Response): void {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-content-type-options', 'nosniff');
}

@Controller('hulo-payments/pay')
export class HostedCheckoutController {
    constructor(
        private hosted: HostedCheckoutService,
        private payments: PaymentsService,
        private ledger: LedgerService,
        private orderService: OrderService,
        private channelService: ChannelService,
        private requestContextService: RequestContextService,
        private connection: TransactionalConnection,
    ) {}

    private async shopCtx(channelId: number): Promise<RequestContext> {
        const channel = await this.channelService.findOne(RequestContext.empty(), channelId);
        return this.requestContextService.create({ apiType: 'shop', channelOrToken: channel || (await this.channelService.getDefaultChannel()) });
    }

    private async load(token: string) {
        const s = await this.hosted.find(token);
        if (!s) return null;
        const ctx = await this.shopCtx(s.channelId);
        const order = await this.orderService.findOne(ctx, s.orderId, ['lines', 'lines.productVariant', 'customer', 'customer.groups', 'surcharges', 'payments', 'channels']);
        return order ? { s, ctx, order } : null;
    }

    private async brand(channelId: number, channelCode: string): Promise<{ brand: string; accent: string; logoUrl: string }> {
        const s = await this.ledger.getSettings(channelId);
        return { brand: s.hostedBrandName || (channelCode === '__default_channel__' ? 'Checkout' : channelCode), accent: s.hostedAccent || '#1d4ed8', logoUrl: s.hostedLogoUrl || '' };
    }

    @Get(':token')
    async page(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
        const loaded = await this.load(token);
        if (!loaded) return res.status(404).type('html').send(this.gone('This payment link is not valid.'));
        const { s, ctx, order } = loaded;
        securityHeaders(res);
        const paid = PAID_STATES.includes(order.state);
        if (paid) return res.redirect(302, this.returnUrl(s.returnUrl, order.code, 'paid'));
        if (!this.hosted.isLive(s)) return res.status(410).type('html').send(this.gone('This payment link has expired. Please go back to the shop and try again.'));
        if (order.state !== 'ArrangingPayment') {
            const t: any = await this.connection.withTransaction(ctx, tctx => this.orderService.transitionToState(tctx, order.id, 'ArrangingPayment'));
            if (t?.errorCode) {
                Logger.warn(`hosted page: ${order.code} cannot enter ArrangingPayment: ${t.message || t.errorCode}`, loggerCtx);
                return res.status(409).type('html').send(this.gone('This order cannot take a payment right now. Please go back to the shop and try again.'));
            }
        }
        let providers: any[] = [];
        try { providers = await this.payments.offeredProviders(ctx, order); } catch (e: any) { Logger.warn(`hosted page: providers failed for ${order.code}: ${e.message}`, loggerCtx); }
        const channelCode = (order.channels || []).find((c: any) => c.code !== '__default_channel__')?.code || order.channels?.[0]?.code || '__default_channel__';
        const html = renderHostedPage({
            token, orderCode: order.code, amount: order.totalWithTax, currency: order.currencyCode, locale: s.locale, customerEmail: order.customer?.emailAddress || '',
            ...(await this.brand(s.channelId, channelCode)), cancelUrl: s.cancelUrl,
            providers: providers.map(p => ({ methodCode: p.methodCode, provider: p.provider, name: p.name, wallets: p.capabilities?.wallets || [], offline: !!p.capabilities?.offline, surcharge: p.surcharge })),
            returned: !!(req.query && Object.keys(req.query).length),
            preselect: s.lastMethodCode || '',
            lines: (order.lines || []).map(l => ({ name: l.productVariant?.name || 'Item', quantity: l.quantity, total: l.proratedLinePriceWithTax ?? l.linePriceWithTax })),
        });
        return res.type('html').send(html);
    }

    @Post(':token/session')
    async session(@Param('token') token: string, @Body() body: any, @Res() res: Response) {
        const loaded = await this.load(token);
        if (!loaded || !this.hosted.isLive(loaded.s)) return res.status(410).json({ error: 'expired', message: 'This payment link has expired.' });
        const { s, ctx, order } = loaded;
        const methodCode = String(body?.methodCode || '');
        if (!METHOD_CODE_RE.test(methodCode)) return res.status(400).json({ error: 'session', message: 'Choose a payment method first.' });
        // One link, a bounded number of provider sessions: each call creates a PaymentIntent / session at the provider.
        if ((await this.hosted.bumpSessionCount(token)) > MAX_SESSIONS_PER_LINK) {
            return res.status(429).json({ error: 'too_many', message: 'Too many attempts on this payment link. Please go back to the shop and start again.' });
        }
        try {
            const pageUrl = `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/hulo-payments/pay/${token}`;
            const session = await this.payments.createSession(ctx, order, methodCode, { returnUrl: `${pageUrl}?returned=1`, locale: s.locale, countryCode: order.shippingAddress?.countryCode || order.billingAddress?.countryCode || undefined });
            await this.hosted.remember(token, methodCode, session.sessionId);
            const provider = getProvider(session.provider);
            const flow = session.flow || defaultFlow(session.provider);
            return res.status(200).json({ ...session, flow, name: provider?.name });
        } catch (e: any) {
            Logger.warn(`hosted session failed (${methodCode}) for ${order.code}: ${e.message}`, loggerCtx);
            return res.status(400).json({ error: 'session', message: 'This payment method is not available right now. Please choose another.' });
        }
    }

    @Post(':token/complete')
    async complete(@Param('token') token: string, @Body() body: any, @Res() res: Response) {
        const loaded = await this.load(token);
        if (!loaded) return res.status(404).json({ paid: false, message: 'This payment link is not valid.' });
        const { s, ctx, order } = loaded;
        securityHeaders(res);
        const already = PAID_STATES.includes(order.state);
        if (already) { await this.hosted.complete(token); return res.status(200).json({ paid: true, redirect: this.returnUrl(s.returnUrl, order.code, 'paid'), message: 'This order is already paid.' }); }
        if (!this.hosted.isLive(s)) return res.status(410).json({ paid: false, message: 'This payment link has expired.' });
        const methodCode = String(body?.methodCode || s.lastMethodCode || '');
        if (!METHOD_CODE_RE.test(methodCode)) return res.status(400).json({ paid: false, message: 'Choose a payment method first.' });
        // Only known keys, only short strings: the body is customer-controlled.
        const metadata: Record<string, any> = {};
        for (const k of METADATA_KEYS) {
            const v = body?.metadata?.[k];
            if (typeof v === 'string' && v.length > 0 && v.length <= 500) metadata[k] = v;
        }
        // The ids we created server-side win over anything the page sends back.
        if (s.lastSessionId) {
            metadata.sessionId = s.lastSessionId;
            for (const k of ['molliePaymentId', 'billingRequestId', 'chargeCode', 'paypalOrderId']) if (!metadata[k]) metadata[k] = s.lastSessionId;
            if (/^pi_/.test(s.lastSessionId)) metadata.paymentIntentId = s.lastSessionId;
        }
        // The session row is the mutex: the page's auto-call after a redirect and
        // a click on Pay can both reach here; only the first proceeds.
        if (!(await this.hosted.beginComplete(token))) {
            const fresh = await this.orderService.findOne(ctx, order.id);
            const paidNow = !!fresh && PAID_STATES.includes(fresh.state);
            return res.status(200).json({ paid: paidNow, redirect: paidNow ? this.returnUrl(s.returnUrl, order.code, 'paid') : undefined, message: paidNow ? 'This order is paid.' : 'Your payment is still being confirmed — please wait a moment.' });
        }
        // REST route, not a resolver: run the payment inside our own transaction.
        let r: any;
        try {
            // Lock the order and re-check: the provider's webhook may have recorded
            // this same payment a moment ago (redirect flows race the customer's return).
            r = await this.connection.withTransaction(ctx, async tctx => {
                await this.connection.getRepository(tctx, Order).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: order.id }).getOne();
                const fresh = await this.orderService.findOne(tctx, order.id, ['payments']);
                if (fresh && PAID_STATES.includes(fresh.state)) return { alreadyPaid: true, state: fresh.state };
                const ref = metadata.paymentIntentId || metadata.sessionId || metadata.paypalOrderId || metadata.molliePaymentId || '';
                const dup = !!ref && (fresh?.payments || []).some(p => !['Declined', 'Cancelled', 'Error'].includes(p.state)
                    && (p.transactionId === ref || String(p.metadata?.paymentIntentId || '') === ref || String(p.metadata?.sessionId || '') === ref));
                if (dup) return { alreadyPaid: true, state: fresh?.state };
                return this.orderService.addPaymentToOrder(tctx, order.id, { method: methodCode, metadata });
            });
            if (r?.alreadyPaid) {
                await this.hosted.complete(token);
                const state = String(r.state || '');
                return res.status(200).json({ paid: true, state, redirect: this.returnUrl(s.returnUrl, order.code, state === 'PaymentSettled' ? 'paid' : 'pending'), message: 'Payment received.' });
            }
        } catch (e: any) {
            await this.hosted.releaseComplete(token);
            Logger.warn(`hosted complete failed (${methodCode}) for ${order.code}: ${e.message}`, loggerCtx);
            return res.status(200).json({ paid: false, message: 'The payment could not be completed. Please try again or choose another method.' });
        }
        if (r?.errorCode) {
            await this.hosted.releaseComplete(token);
            const msg = r.paymentErrorMessage || 'The payment was not completed. Please try again or choose another method.';
            Logger.warn(`hosted complete (${methodCode}) for ${order.code}: ${r.message || r.errorCode}`, loggerCtx);
            return res.status(200).json({ paid: false, message: msg });
        }
        await this.hosted.complete(token);
        const state = r.state;
        const method = (await listHuloMethods(this.connection, s.channelId)).find(m => m.paymentMethodCode === methodCode);
        const offline = !!(method && getProvider(method.handlerCode)?.capabilities?.offline);
        return res.status(200).json({ paid: true, state, redirect: this.returnUrl(s.returnUrl, order.code, state === 'PaymentSettled' ? 'paid' : 'pending'), message: offline ? 'Order placed — you will find the payment details in your confirmation email.' : state === 'PaymentSettled' ? 'Payment received — taking you back to the shop…' : 'Payment received and awaiting confirmation — taking you back to the shop…' });
    }

    private returnUrl(base: string, orderCode: string, result: string): string {
        try {
            const u = new URL(base || `${getRuntime().publicBaseUrl()}/`);
            if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
            u.searchParams.set('order', orderCode);
            u.searchParams.set('result', result);
            return u.toString();
        } catch {
            return `${getRuntime().publicBaseUrl()}/`;
        }
    }

    private gone(text: string): string {
        text = esc(text);
        return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:24px;text-align:center;color:#0f172a"><h1 style="font-size:20px">Payment link</h1><p style="color:#475569;line-height:1.6">${text.replace(/</g, '&lt;')}</p></div>`;
    }
}

function defaultFlow(provider: string): string {
    return ({ 'hulo-stripe': 'stripe-element', 'hulo-adyen': 'adyen-dropin', 'hulo-paypal': 'paypal-buttons', 'hulo-square': 'square-web', 'hulo-braintree': 'braintree-dropin', 'hulo-bank-transfer': 'instructions', 'hulo-pay-later': 'instructions' } as Record<string, string>)[provider] || 'redirect';
}
