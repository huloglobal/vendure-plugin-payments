import { createHmac } from 'crypto';
import { Order, RequestContext } from '@vendure/core';
import { ClientSession, CredentialCheck, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs, SessionOptions, WebhookVerification } from '../core/provider';
import { idem, request, safeEqual } from '../core/rest';
import { fromProviderMinor, toProviderMinor } from '../core/money';

export const CHECKOUT_COM_CODE = 'hulo-checkout-com' as const;
const base = (args: ProviderArgs) => (String(args.environment) === 'live' ? 'https://api.checkout.com' : 'https://api.sandbox.checkout.com');
async function cko<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST'; json?: any; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${args.secretKey}` };
    if (opts.idempotencyKey) headers['cko-idempotency-key'] = opts.idempotencyKey;
    return request<T>('Checkout.com', `${base(args)}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers, json: opts.json, okStatuses: [202] });
}

/**
 * Checkout.com through Hosted Payments Pages: cards, Apple Pay, Google Pay,
 * PayPal, Klarna, iDEAL, Bancontact and more on a page Checkout.com hosts;
 * automatic or manual capture, refunds, disputes, payment links, signed
 * webhooks.
 */
export const checkoutComProvider: PaymentProvider = {
    code: CHECKOUT_COM_CODE,
    name: 'Checkout.com',
    freeTier: false,
    capabilities: { session: true, manualCapture: true, partialCapture: true, refund: true, partialRefund: true, savedMethods: false, subscriptions: false, payByLink: true, disputes: true, wallets: ['apple_pay', 'google_pay', 'paypal', 'klarna', 'ideal', 'bancontact'] },
    connectFields: ['environment', 'secretKey', 'publicKey', 'processingChannelId', 'captureMode'],
    publicConfig(args) { return { publicKey: args.publicKey, environment: String(args.environment) === 'live' ? 'live' : 'sandbox' }; },
    dashboardLinks(args) {
        const live = String(args?.environment) === 'live';
        const d = live ? 'https://dashboard.checkout.com' : 'https://dashboard.sandbox.checkout.com';
        return { dashboard: d, keys: `${d}/settings/channels`, webhooks: `${d}/developers/webhooks`, docs: 'https://www.checkout.com/docs/payments/accept-payments/hosted-payments-page' };
    },
    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.secretKey || !args.processingChannelId) return { ok: false, message: 'Secret key and processing channel ID are required (Dashboard → Settings → Channels).' };
        try {
            await cko(args, '/workflows');
            return { ok: true, message: `Connected to Checkout.com (${String(args.environment) === 'live' ? 'live' : 'sandbox'}), channel ${args.processingChannelId}.`, environment: String(args.environment) === 'live' ? 'live' : 'sandbox' };
        } catch (e: any) { return { ok: false, message: e.status === 401 ? 'Checkout.com rejected the secret key.' : e.message }; }
    },
    async ensureWebhook(args, url) {
        const events = ['payment_approved', 'payment_captured', 'payment_declined', 'payment_capture_declined', 'payment_voided', 'payment_refunded', 'payment_refund_declined', 'dispute_received', 'dispute_resolved', 'dispute_won', 'dispute_lost', 'dispute_expired', 'dispute_canceled'];
        const list = await cko(args, '/workflows').catch(() => ({ data: [] }));
        const existing = (list.data || []).find((w: any) => w.name === 'HULO Payments for Vendure');
        if (existing && args.webhookSecret) return { args: {}, ref: existing.id, note: 'Existing workflow kept.' };
        const secret = args.webhookSecret || require('crypto').randomBytes(24).toString('hex');
        const r = await cko(args, '/workflows', { json: { name: 'HULO Payments for Vendure', active: true, conditions: [{ type: 'event', events: { gateway: events, dispute: events.filter(e => e.startsWith('dispute')) } }], actions: [{ type: 'webhook', url, headers: {}, signature: { method: 'HMACSHA256', key: secret } }] } });
        return { args: { webhookSecret: secret }, ref: r.id };
    },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const ret = opts.returnUrl || 'https://example.com/return';
        const r = await cko(args, '/hosted-payments', { json: { amount: toProviderMinor(order.totalWithTax, order.currencyCode), currency: order.currencyCode, reference: order.code, description: `Order ${order.code}`, capture: args.captureMode !== 'manual', processing_channel_id: args.processingChannelId, customer: order.customer ? { email: order.customer.emailAddress, name: [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ') || undefined } : undefined, billing: { address: { country: order.billingAddress?.countryCode || order.shippingAddress?.countryCode || 'GB' } }, success_url: `${ret}${ret.includes('?') ? '&' : '?'}cko=success`, failure_url: `${ret}${ret.includes('?') ? '&' : '?'}cko=failure`, cancel_url: `${ret}${ret.includes('?') ? '&' : '?'}cko=cancel`, metadata: { orderCode: order.code } }, idempotencyKey: idem('hulo-cko', order.code, order.totalWithTax, order.currencyCode) });
        return { provider: CHECKOUT_COM_CODE, flow: 'redirect', sessionId: r.id, checkoutUrl: r._links?.redirect?.href, environment: this.publicConfig(args).environment, amount: order.totalWithTax, currency: order.currencyCode, expiresAt: r.expires_on };
    },
    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        let paymentId = String(metadata?.paymentId || '');
        if (!paymentId && metadata?.sessionId) {
            const s = await cko(args, `/hosted-payments/${metadata.sessionId}`);
            paymentId = s.payment_id || (s.payments || [])[0]?.id || '';
            if (!paymentId) return { state: 'Error', amount: 0, transactionId: String(metadata.sessionId), errorMessage: `Hosted page is ${s.status || 'incomplete'} — no payment yet` };
        }
        if (!paymentId) return { state: 'Error', amount: 0, errorMessage: 'Missing Checkout.com payment id' };
        const p = await cko(args, `/payments/${paymentId}`);
        if (p.reference && p.reference !== order.code) return { state: 'Error', amount: 0, errorMessage: 'Payment belongs to a different order' };
        if (p.currency && p.currency !== order.currencyCode) return { state: 'Error', amount: 0, errorMessage: 'Currency mismatch' };
        const amount = fromProviderMinor(Number(p.amount || 0), order.currencyCode);
        const meta = { paymentId: p.id, scheme: p.source?.scheme || null, last4: p.source?.last4 || null, public: { method: p.source?.type || 'card', last4: p.source?.last4 || null } };
        if (['Captured', 'Paid'].includes(p.status)) return { state: 'Settled', amount, transactionId: p.id, metadata: meta };
        if (p.status === 'Authorized') return { state: 'Authorized', amount, transactionId: p.id, metadata: { ...meta, capture: args.captureMode === 'manual' ? 'manual' : undefined, pending: args.captureMode !== 'manual' } };
        if (['Pending', 'Card Verified'].includes(p.status)) return { state: 'Authorized', amount, transactionId: p.id, metadata: { ...meta, pending: true } };
        return { state: 'Declined', amount: 0, transactionId: p.id, errorMessage: `Checkout.com payment ${p.status}${p.response_summary ? ` (${p.response_summary})` : ''}`, metadata: meta };
    },
    async capture(args, paymentRef, amount, currency) { try { await cko(args, `/payments/${paymentRef}/captures`, { json: { amount: toProviderMinor(amount, currency) }, idempotencyKey: idem('hulo-cko-cap', paymentRef, amount) }); return { success: true }; } catch (e: any) { return { success: false, errorMessage: e.message }; } },
    async cancel(args, paymentRef) { try { await cko(args, `/payments/${paymentRef}/voids`, { json: {} }); return { success: true }; } catch (e: any) { return { success: false, errorMessage: e.message }; } },
    async refund(args, paymentRef, amount, currency, reason) {
        const r = await cko(args, `/payments/${paymentRef}/refunds`, { json: { amount: toProviderMinor(amount, currency), reference: reason ? String(reason).slice(0, 50) : undefined }, idempotencyKey: idem('hulo-cko-ref', paymentRef, amount, Date.now().toString(36).slice(0, 6)) });
        return { state: 'Pending', transactionId: r.action_id, metadata: { actionId: r.action_id } };
    },
    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        if (!args.webhookSecret) return { ok: false, events: [], error: 'webhookSecret not configured' };
        const expected = createHmac('sha256', String(args.webhookSecret)).update(body).digest('hex');
        if (!safeEqual(expected, String(headers['cko-signature'] || ''))) return { ok: false, events: [], error: 'signature mismatch' };
        let ev: any; try { ev = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        return { ok: true, events: [normaliseCkoEvent(ev)] };
    },
    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const r = await cko(args, '/payment-links', { json: { amount: toProviderMinor(input.amount, input.currency), currency: input.currency, reference: input.orderCode, description: input.description.slice(0, 100), processing_channel_id: args.processingChannelId, expires_in: input.expiresAt ? Math.max(60, Math.floor((new Date(input.expiresAt).getTime() - Date.now()) / 1000)) : undefined, customer: input.customerEmail ? { email: input.customerEmail } : undefined, billing: { address: { country: 'GB' } }, return_url: input.returnUrl || undefined, metadata: { orderCode: input.orderCode } } });
        return { url: r._links?.redirect?.href, ref: r.id, expiresAt: r.expires_on };
    },
};

export function normaliseCkoEvent(ev: any): NormalisedEvent {
    const d = ev?.data || {};
    const cur = d.currency ? String(d.currency).toUpperCase() : undefined;
    const amount = cur && d.amount != null ? fromProviderMinor(Number(d.amount), cur) : undefined;
    const base: NormalisedEvent = { id: String(ev?.id || ''), type: 'ignored', orderCode: d.reference || d.metadata?.orderCode, paymentRef: d.id || d.payment_id, amount, currency: cur, reason: d.response_summary || d.reason_code, raw: ev };
    const map: Record<string, NormalisedEvent['type']> = { payment_approved: 'payment.authorized', payment_captured: 'payment.settled', payment_declined: 'payment.failed', payment_capture_declined: 'payment.failed', payment_voided: 'payment.canceled', payment_refunded: 'refund.settled', payment_refund_declined: 'refund.failed', dispute_received: 'dispute.opened', dispute_won: 'dispute.closed', dispute_lost: 'dispute.closed', dispute_expired: 'dispute.closed', dispute_canceled: 'dispute.closed', dispute_resolved: 'dispute.closed' };
    const type = map[ev?.type] || 'ignored';
    return { ...base, type, reason: ev?.type === 'dispute_won' ? 'won' : ev?.type === 'dispute_lost' ? 'lost' : base.reason };
}
