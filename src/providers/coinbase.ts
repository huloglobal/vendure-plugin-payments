import { createHmac } from 'crypto';
import { Order, RequestContext } from '@vendure/core';
import { ClientSession, CredentialCheck, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs, SessionOptions, WebhookVerification } from '../core/provider';
import { idem, request, safeEqual } from '../core/rest';
import { fromDecimalString, toDecimalString } from '../core/money';

export const COINBASE_CODE = 'hulo-coinbase' as const;
const API = 'https://api.commerce.coinbase.com';
async function cb<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST'; json?: any } = {}): Promise<T> {
    return request<T>('Coinbase Commerce', `${API}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers: { 'x-cc-api-key': String(args.apiKey || ''), 'x-cc-version': '2018-03-22' }, json: opts.json });
}

/**
 * Coinbase Commerce: crypto (Bitcoin, Ethereum, USDC and more) on a hosted
 * charge page priced in your currency. Charges confirm on-chain by webhook;
 * refunds are handled outside the plugin.
 */
export const coinbaseProvider: PaymentProvider = {
    code: COINBASE_CODE,
    name: 'Coinbase Commerce (crypto)',
    freeTier: false,
    capabilities: { session: true, manualCapture: false, partialCapture: false, refund: false, partialRefund: false, savedMethods: false, subscriptions: false, payByLink: true, disputes: false, wallets: ['bitcoin', 'ethereum', 'usdc', 'litecoin'] },
    connectFields: ['apiKey'],
    publicConfig() { return { environment: 'live' }; },
    dashboardLinks() { return { dashboard: 'https://beta.commerce.coinbase.com/', keys: 'https://beta.commerce.coinbase.com/settings/security', webhooks: 'https://beta.commerce.coinbase.com/settings/notifications', docs: 'https://docs.cdp.coinbase.com/commerce-onchain/docs/welcome' }; },
    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.apiKey) return { ok: false, message: 'API key is required (Settings → Security → API keys).' };
        try { await cb(args, '/charges?limit=1'); return { ok: true, message: 'Connected to Coinbase Commerce.', environment: 'live' }; }
        catch (e: any) { return { ok: false, message: e.status === 401 ? 'Coinbase Commerce rejected the API key.' : e.message }; }
    },
    async ensureWebhook(args, url) {
        return { args: {}, note: args.webhookSharedSecret ? 'Webhook shared secret kept.' : `Add ${url} under Settings → Notifications in Coinbase Commerce and paste the shared secret into the payment method's webhookSharedSecret.` };
    },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const r = await cb(args, '/charges', { json: { name: `Order ${order.code}`, description: `${(order.lines || []).length} item(s)`, pricing_type: 'fixed_price', local_price: { amount: toDecimalString(order.totalWithTax, order.currencyCode), currency: order.currencyCode }, metadata: { orderCode: order.code, customer_email: order.customer?.emailAddress || '' }, redirect_url: opts.returnUrl || undefined, cancel_url: opts.returnUrl || undefined } });
        return { provider: COINBASE_CODE, flow: 'redirect', sessionId: r.data?.code, checkoutUrl: r.data?.hosted_url, environment: 'live', amount: order.totalWithTax, currency: order.currencyCode, expiresAt: r.data?.expires_at };
    },
    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const code = String(metadata?.chargeCode || metadata?.sessionId || '');
        if (!code) return { state: 'Error', amount: 0, errorMessage: 'Missing Coinbase charge code' };
        const r = await cb(args, `/charges/${encodeURIComponent(code)}`);
        const c = r.data || {};
        if (c.metadata?.orderCode && c.metadata.orderCode !== order.code) return { state: 'Error', amount: 0, errorMessage: 'Charge belongs to a different order' };
        const status = String((c.timeline || []).slice(-1)[0]?.status || 'NEW').toUpperCase();
        const meta = { chargeCode: code, public: { method: 'crypto' } };
        if (['COMPLETED', 'RESOLVED'].includes(status)) return { state: 'Settled', amount: order.totalWithTax, transactionId: code, metadata: meta };
        if (['PENDING', 'SIGNED'].includes(status)) return { state: 'Authorized', amount: order.totalWithTax, transactionId: code, metadata: { ...meta, pending: true } };
        if (['EXPIRED', 'CANCELED', 'UNRESOLVED'].includes(status)) return { state: 'Declined', amount: 0, transactionId: code, errorMessage: `Charge ${status.toLowerCase()}`, metadata: meta };
        return { state: 'Error', amount: 0, transactionId: code, errorMessage: 'The customer has not paid the charge yet' };
    },
    async capture() { return { success: false, errorMessage: 'Crypto charges confirm on-chain; nothing to capture' }; },
    async cancel(args, paymentRef) { try { await cb(args, `/charges/${encodeURIComponent(paymentRef)}/cancel`, { json: {} }); return { success: true }; } catch (e: any) { return { success: false, errorMessage: e.message }; } },
    async refund() { return { state: 'Failed', metadata: { note: 'Refund crypto payments from the Coinbase Commerce dashboard, then record the refund in Vendure.' } }; },
    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        if (!args.webhookSharedSecret) return { ok: false, events: [], error: 'webhookSharedSecret not configured' };
        const expected = createHmac('sha256', String(args.webhookSharedSecret)).update(body).digest('hex');
        if (!safeEqual(expected, String(headers['x-cc-webhook-signature'] || ''))) return { ok: false, events: [], error: 'signature mismatch' };
        let ev: any; try { ev = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        const e = ev.event || {}; const d = e.data || {};
        const cur = d.pricing?.local?.currency; const amount = cur ? fromDecimalString(d.pricing.local.amount, cur) : undefined;
        const map: Record<string, NormalisedEvent['type']> = { 'charge:confirmed': 'payment.settled', 'charge:resolved': 'payment.settled', 'charge:failed': 'payment.failed', 'charge:pending': 'payment.authorized' };
        return { ok: true, events: [{ id: String(e.id || ''), type: map[e.type] || 'ignored', orderCode: d.metadata?.orderCode, paymentRef: d.code, amount, currency: cur, raw: ev }] };
    },
    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const r = await cb(args, '/charges', { json: { name: `Order ${input.orderCode}`, description: input.description.slice(0, 200), pricing_type: 'fixed_price', local_price: { amount: toDecimalString(input.amount, input.currency), currency: input.currency }, metadata: { orderCode: input.orderCode, huloPayLink: '1' }, redirect_url: input.returnUrl || undefined } });
        return { url: r.data?.hosted_url, ref: r.data?.code, expiresAt: r.data?.expires_at };
    },
};
void idem;
