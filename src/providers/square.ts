import { createHmac } from 'crypto';
import { Order, RequestContext } from '@vendure/core';
import { ClientSession, CredentialCheck, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs, SessionOptions, WebhookVerification } from '../core/provider';
import { idem, request, safeEqual } from '../core/rest';
import { fromProviderMinor, toProviderMinor } from '../core/money';
import { getRuntime } from '../core/runtime';

export const SQUARE_CODE = 'hulo-square' as const;
const VERSION = '2024-08-21';

const base = (args: ProviderArgs) => (String(args.environment) === 'live' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com');
async function square<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; json?: any } = {}): Promise<T> {
    return request<T>('Square', `${base(args)}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers: { authorization: `Bearer ${args.accessToken}`, 'square-version': VERSION }, json: opts.json });
}
const webhookUrl = () => `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/hulo-payments/webhook/${SQUARE_CODE}`;

/**
 * Square through the Payments API: the Web Payments SDK tokenises the card,
 * Apple Pay, Google Pay, Cash App Pay or Afterpay in the browser and the
 * plugin charges the token server-side. Manual capture, refunds, disputes,
 * payment links, signed webhooks.
 */
export const squareProvider: PaymentProvider = {
    code: SQUARE_CODE,
    name: 'Square',
    freeTier: false,
    capabilities: { session: true, manualCapture: true, partialCapture: false, refund: true, partialRefund: true, savedMethods: false, subscriptions: false, payByLink: true, disputes: true, wallets: ['apple_pay', 'google_pay', 'cash_app', 'afterpay'] },
    connectFields: ['environment', 'accessToken', 'applicationId', 'locationId', 'captureMode'],
    publicConfig(args) { return { applicationId: args.applicationId, locationId: args.locationId, environment: String(args.environment) === 'live' ? 'live' : 'sandbox' }; },
    dashboardLinks(args) {
        const live = String(args?.environment) === 'live';
        return { dashboard: live ? 'https://squareup.com/dashboard' : 'https://developer.squareup.com/apps', keys: 'https://developer.squareup.com/apps', webhooks: 'https://developer.squareup.com/apps', docs: 'https://developer.squareup.com/docs/payments-api/overview' };
    },
    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.accessToken || !args.locationId || !args.applicationId) return { ok: false, message: 'Access token, application ID and location ID are all required.' };
        try {
            const r = await square(args, `/v2/locations/${encodeURIComponent(args.locationId)}`);
            return { ok: true, message: `Connected to ${r.location?.name || args.locationId} (${String(args.environment) === 'live' ? 'live' : 'sandbox'}, ${r.location?.currency || '?'}).`, account: r.location?.name, environment: String(args.environment) === 'live' ? 'live' : 'sandbox' };
        } catch (e: any) { return { ok: false, message: e.status === 401 ? 'Square rejected the access token.' : e.message }; }
    },
    async ensureWebhook(args, url) {
        const list = await square(args, '/v2/webhooks/subscriptions?include_disabled=false').catch(() => ({ subscriptions: [] }));
        const existing = (list.subscriptions || []).find((s: any) => s.notification_url === url);
        if (existing && args.webhookSignatureKey) return { args: {}, ref: existing.id, note: 'Existing webhook kept.' };
        if (existing) await square(args, `/v2/webhooks/subscriptions/${existing.id}`, { method: 'DELETE' }).catch(() => undefined);
        const r = await square(args, '/v2/webhooks/subscriptions', { json: { idempotency_key: idem('hulo-sq-wh', url, Date.now().toString(36)), subscription: { name: 'HULO Payments for Vendure', notification_url: url, event_types: ['payment.updated', 'refund.updated', 'dispute.created', 'dispute.state.updated'] } } });
        return { args: { webhookSignatureKey: r.subscription?.signature_key }, ref: r.subscription?.id };
    },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, _opts: SessionOptions): Promise<ClientSession> {
        return { provider: SQUARE_CODE, flow: 'square-web', publicKey: args.applicationId, environment: this.publicConfig(args).environment, config: { applicationId: args.applicationId, locationId: args.locationId, currency: order.currencyCode }, amount: order.totalWithTax, currency: order.currencyCode };
    },
    /** The browser hands back a payment token (`sourceId`); the charge itself happens here. */
    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const sourceId = String(metadata?.sourceId || '');
        if (metadata?.paymentId) {
            const p = await square(args, `/v2/payments/${encodeURIComponent(metadata.paymentId)}`);
            return outcome(p.payment, order);
        }
        if (!sourceId) return { state: 'Error', amount: 0, errorMessage: 'Missing Square payment token (sourceId)' };
        const r = await square(args, '/v2/payments', { json: { source_id: sourceId, idempotency_key: idem('hulo-sq', order.code, order.totalWithTax, sourceId.slice(-8)), amount_money: { amount: toProviderMinor(order.totalWithTax, order.currencyCode), currency: order.currencyCode }, location_id: args.locationId, reference_id: order.code, note: `Order ${order.code}`, autocomplete: args.captureMode !== 'manual', verification_token: metadata?.verificationToken || undefined, buyer_email_address: order.customer?.emailAddress || undefined } });
        return outcome(r.payment, order);
    },
    async capture(args, paymentRef) { try { await square(args, `/v2/payments/${paymentRef}/complete`, { json: {} }); return { success: true }; } catch (e: any) { return { success: false, errorMessage: e.message }; } },
    async cancel(args, paymentRef) { try { await square(args, `/v2/payments/${paymentRef}/cancel`, { json: {} }); return { success: true }; } catch (e: any) { return { success: false, errorMessage: e.message }; } },
    async refund(args, paymentRef, amount, currency, reason) {
        const r = await square(args, '/v2/refunds', { json: { idempotency_key: idem('hulo-sq-ref', paymentRef, amount, Date.now().toString(36).slice(0, 6)), payment_id: paymentRef, amount_money: { amount: toProviderMinor(amount, currency), currency }, reason: reason ? String(reason).slice(0, 190) : undefined } });
        return { state: r.refund?.status === 'COMPLETED' ? 'Settled' : r.refund?.status === 'FAILED' || r.refund?.status === 'REJECTED' ? 'Failed' : 'Pending', transactionId: r.refund?.id, metadata: { status: r.refund?.status } };
    },
    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        if (!args.webhookSignatureKey) return { ok: false, events: [], error: 'webhookSignatureKey not configured' };
        const expected = createHmac('sha256', String(args.webhookSignatureKey)).update(webhookUrl() + body).digest('base64');
        if (!safeEqual(expected, String(headers['x-square-hmacsha256-signature'] || ''))) return { ok: false, events: [], error: 'signature mismatch' };
        let ev: any; try { ev = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        return { ok: true, events: [normaliseSquareEvent(ev)] };
    },
    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const r = await square(args, '/v2/online-checkout/payment-links', { json: { idempotency_key: idem('hulo-sq-link', input.orderCode, input.amount, Date.now().toString(36).slice(0, 5)), quick_pay: { name: input.description.slice(0, 250), price_money: { amount: toProviderMinor(input.amount, input.currency), currency: input.currency }, location_id: args.locationId }, checkout_options: { redirect_url: input.returnUrl || undefined }, payment_note: `Order ${input.orderCode}`, pre_populated_data: { buyer_email: input.customerEmail || undefined } } });
        return { url: r.payment_link?.url, ref: r.payment_link?.id };
    },
};

function outcome(p: any, order: Order): PaymentOutcome {
    if (!p) return { state: 'Error', amount: 0, errorMessage: 'Square returned no payment' };
    const meta = { paymentId: p.id, cardBrand: p.card_details?.card?.card_brand || null, last4: p.card_details?.card?.last_4 || null, public: { method: p.source_type?.toLowerCase() || 'card', last4: p.card_details?.card?.last_4 || null } };
    const amount = fromProviderMinor(Number(p.amount_money?.amount || 0), order.currencyCode);
    if (p.status === 'COMPLETED') return { state: 'Settled', amount, transactionId: p.id, metadata: meta };
    if (p.status === 'APPROVED') return { state: 'Authorized', amount, transactionId: p.id, metadata: { ...meta, capture: 'manual' } };
    if (p.status === 'PENDING') return { state: 'Authorized', amount, transactionId: p.id, metadata: { ...meta, pending: true } };
    return { state: 'Declined', amount: 0, transactionId: p.id, errorMessage: `Square payment ${p.status}`, metadata: meta };
}

export function normaliseSquareEvent(ev: any): NormalisedEvent {
    const o = ev?.data?.object || {};
    const base: NormalisedEvent = { id: String(ev?.event_id || ev?.id || ''), type: 'ignored', raw: ev };
    if (ev?.type === 'payment.updated') {
        const p = o.payment || {}; const cur = String(p.amount_money?.currency || 'GBP');
        const amt = fromProviderMinor(Number(p.amount_money?.amount || 0), cur);
        const type = p.status === 'COMPLETED' ? 'payment.settled' : p.status === 'APPROVED' ? 'payment.authorized' : p.status === 'FAILED' ? 'payment.failed' : p.status === 'CANCELED' ? 'payment.canceled' : 'ignored';
        return { ...base, id: `${p.id}:${p.status}`, type, orderCode: p.reference_id, paymentRef: p.id, amount: amt, currency: cur };
    }
    if (ev?.type === 'refund.updated') {
        const r = o.refund || {}; const cur = String(r.amount_money?.currency || 'GBP');
        return { ...base, id: `${r.id}:${r.status}`, type: r.status === 'COMPLETED' ? 'refund.settled' : r.status === 'FAILED' || r.status === 'REJECTED' ? 'refund.failed' : 'ignored', paymentRef: r.payment_id, amount: fromProviderMinor(Number(r.amount_money?.amount || 0), cur), currency: cur, reason: r.reason };
    }
    if (ev?.type === 'dispute.created' || ev?.type === 'dispute.state.updated') {
        const d = o.dispute || {}; const cur = String(d.amount_money?.currency || 'GBP');
        const closed = ['WON', 'LOST', 'ACCEPTED'].includes(d.state);
        return { ...base, id: `${d.id}:${d.state}`, type: closed ? 'dispute.closed' : 'dispute.opened', paymentRef: d.disputed_payment?.payment_id, amount: fromProviderMinor(Number(d.amount_money?.amount || 0), cur), currency: cur, reason: d.state === 'WON' ? 'won' : d.reason || d.state };
    }
    return base;
}
