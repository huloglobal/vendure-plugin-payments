import { createHmac } from 'crypto';
import { Order, RequestContext } from '@vendure/core';
import { ClientSession, CredentialCheck, NormalisedEvent, PaymentOutcome, PaymentProvider, ProviderArgs, SessionOptions, SubscriptionCreateInput, SubscriptionOutcome, WebhookVerification } from '../core/provider';
import { idem, request, safeEqual } from '../core/rest';
import { fromProviderMinor, toProviderMinor } from '../core/money';

export const GOCARDLESS_CODE = 'hulo-gocardless' as const;
const base = (args: ProviderArgs) => (String(args.environment) === 'live' ? 'https://api.gocardless.com' : 'https://api-sandbox.gocardless.com');
async function gc<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; json?: any; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${args.accessToken}`, 'gocardless-version': '2015-07-06' };
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    return request<T>('GoCardless', `${base(args)}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers, json: opts.json });
}
const unit: Record<string, string> = { day: 'weekly', week: 'weekly', month: 'monthly', year: 'yearly' };

/**
 * GoCardless: bank debit (Bacs, SEPA, ACH, PAD, BECS) and Instant Bank Pay
 * through Billing Request Flows — the customer authorises on GoCardless's
 * hosted page, funds confirm by webhook a few days later, and a mandate
 * powers native subscriptions. Refunds, failure and chargeback events.
 */
export const gocardlessProvider: PaymentProvider = {
    code: GOCARDLESS_CODE,
    name: 'GoCardless',
    freeTier: false,
    capabilities: { session: true, manualCapture: false, partialCapture: false, refund: true, partialRefund: true, savedMethods: false, subscriptions: true, payByLink: false, disputes: true, wallets: ['bacs', 'sepa', 'ach', 'instant_bank_pay'] },
    connectFields: ['environment', 'accessToken'],
    publicConfig(args) { return { environment: String(args.environment) === 'live' ? 'live' : 'sandbox' }; },
    dashboardLinks(args) {
        const live = String(args?.environment) === 'live';
        const d = live ? 'https://manage.gocardless.com' : 'https://manage-sandbox.gocardless.com';
        return { dashboard: d, keys: `${d}/developers/access-tokens`, webhooks: `${d}/developers/webhook-endpoints`, docs: 'https://developer.gocardless.com/getting-started/api/introduction/' };
    },
    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.accessToken) return { ok: false, message: 'Access token is required (Developers → Access tokens, read-write).' };
        try {
            const r = await gc(args, '/creditors?limit=1');
            const c = r.creditors?.[0];
            return { ok: true, message: `Connected to ${c?.name || 'GoCardless'} (${String(args.environment) === 'live' ? 'live' : 'sandbox'}).`, account: c?.name, environment: String(args.environment) === 'live' ? 'live' : 'sandbox' };
        } catch (e: any) { return { ok: false, message: e.status === 401 ? 'GoCardless rejected the access token.' : e.message }; }
    },
    async ensureWebhook(args, url) {
        // Webhook endpoints can only be created in the dashboard; the secret is set there.
        return { args: {}, note: args.webhookSecret ? 'Webhook secret kept.' : `Add a webhook endpoint at ${url} in the GoCardless dashboard (Developers → Webhook endpoints) and paste its secret into the payment method's webhookSecret.` };
    },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const br = await gc(args, '/billing_requests', { json: { billing_requests: { payment_request: { amount: toProviderMinor(order.totalWithTax, order.currencyCode), currency: order.currencyCode, description: `Order ${order.code}`, app_fee: undefined }, mandate_request: opts.subscription || opts.savePaymentMethod ? { currency: order.currencyCode, scheme: undefined } : undefined, metadata: { orderCode: order.code } } }, idempotencyKey: idem('hulo-gc-br', order.code, order.totalWithTax, opts.subscription ? 'sub' : '') });
        const id = br.billing_requests.id;
        const flow = await gc(args, '/billing_request_flows', { json: { billing_request_flows: { redirect_uri: opts.returnUrl || 'https://example.com/return', exit_uri: opts.returnUrl || 'https://example.com/cancel', links: { billing_request: id }, prefilled_customer: order.customer ? { email: order.customer.emailAddress, given_name: order.customer.firstName || undefined, family_name: order.customer.lastName || undefined } : undefined, lock_currency: true } } });
        return { provider: GOCARDLESS_CODE, flow: 'redirect', sessionId: id, checkoutUrl: flow.billing_request_flows.authorisation_url, environment: this.publicConfig(args).environment, amount: order.totalWithTax, currency: order.currencyCode };
    },
    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const id = String(metadata?.billingRequestId || metadata?.sessionId || '');
        if (!/^BRQ/.test(id)) return { state: 'Error', amount: 0, errorMessage: 'Missing GoCardless billing request id' };
        const r = await gc(args, `/billing_requests/${id}`);
        const br = r.billing_requests;
        if (br.metadata?.orderCode && br.metadata.orderCode !== order.code) return { state: 'Error', amount: 0, errorMessage: 'Billing request belongs to a different order' };
        const meta = { billingRequestId: id, paymentId: br.payment_request?.links?.payment || null, mandateId: br.mandate_request?.links?.mandate || br.links?.mandate_request_mandate || null, customerId: br.links?.customer || null, public: { method: 'bank-debit' } };
        if (br.status === 'fulfilled' && meta.paymentId) {
            const p = await gc(args, `/payments/${meta.paymentId}`);
            const st = p.payments?.status;
            if (['confirmed', 'paid_out'].includes(st)) return { state: 'Settled', amount: fromProviderMinor(Number(p.payments.amount), order.currencyCode), transactionId: meta.paymentId, metadata: meta };
            if (['pending_submission', 'submitted', 'pending_customer_approval'].includes(st)) return { state: 'Authorized', amount: order.totalWithTax, transactionId: meta.paymentId, metadata: { ...meta, pending: true } };
            return { state: 'Declined', amount: 0, transactionId: meta.paymentId, errorMessage: `GoCardless payment ${st}`, metadata: meta };
        }
        if (br.status === 'fulfilled') return { state: 'Authorized', amount: order.totalWithTax, transactionId: id, metadata: { ...meta, pending: true } };
        return { state: 'Error', amount: 0, transactionId: id, errorMessage: `Billing request is ${br.status} — the customer has not completed the GoCardless page yet` };
    },
    async capture() { return { success: false, errorMessage: 'GoCardless payments settle by webhook when the bank confirms them' }; },
    async cancel(args, paymentRef) { try { await gc(args, `/payments/${paymentRef}/actions/cancel`, { json: {} }); return { success: true }; } catch (e: any) { return { success: false, errorMessage: e.message }; } },
    async refund(args, paymentRef, amount, currency, reason) {
        const r = await gc(args, '/refunds', { json: { refunds: { amount: toProviderMinor(amount, currency), total_amount_confirmation: undefined, reference: String(reason || 'refund').slice(0, 18), links: { payment: paymentRef } } }, idempotencyKey: idem('hulo-gc-ref', paymentRef, amount, Date.now().toString(36).slice(0, 6)) });
        return { state: 'Pending', transactionId: r.refunds?.id, metadata: { status: r.refunds?.status } };
    },
    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        if (!args.webhookSecret) return { ok: false, events: [], error: 'webhookSecret not configured' };
        const expected = createHmac('sha256', String(args.webhookSecret)).update(body).digest('hex');
        if (!safeEqual(expected, String(headers['webhook-signature'] || ''))) return { ok: false, events: [], error: 'signature mismatch' };
        let payload: any; try { payload = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        return { ok: true, events: (payload.events || []).map(normaliseGoCardlessEvent) };
    },
    async createSubscription(args, input: SubscriptionCreateInput): Promise<SubscriptionOutcome> {
        const mandate = input.providerPaymentRef;
        if (!mandate) return { providerSubscriptionRef: `hulo-pending:${input.orderCode}:${input.variantId}`, status: 'pending' };
        const start = new Date(Date.now() + (input.trialDays > 0 ? input.trialDays : ({ day: 1, week: 7, month: 30, year: 365 } as any)[input.interval] * input.intervalCount) * 86400_000);
        const s = await gc(args, '/subscriptions', { json: { subscriptions: { amount: toProviderMinor(input.amount * input.quantity, input.currency), currency: input.currency, name: `${input.name} × ${input.quantity}`.slice(0, 255), interval_unit: unit[input.interval] || 'monthly', interval: input.interval === 'day' ? Math.max(1, Math.round(input.intervalCount / 7)) : input.intervalCount, start_date: start.toISOString().slice(0, 10), metadata: { orderCode: input.orderCode }, links: { mandate } } }, idempotencyKey: idem('hulo-gc-sub', input.orderCode, input.variantId) });
        return { providerSubscriptionRef: s.subscriptions.id, status: 'active', currentPeriodEnd: start.toISOString(), providerPaymentRef: mandate };
    },
    async cancelSubscription(args, ref, atPeriodEnd) { if (atPeriodEnd) return { status: 'active' }; await gc(args, `/subscriptions/${ref}/actions/cancel`, { json: {} }); return { status: 'canceled' }; },
    async pauseSubscription(args, ref, resume) { await gc(args, `/subscriptions/${ref}/actions/${resume ? 'resume' : 'pause'}`, { json: {} }); return { status: resume ? 'active' : 'paused' }; },
};

export function normaliseGoCardlessEvent(e: any): NormalisedEvent {
    const base: NormalisedEvent = { id: String(e.id), type: 'ignored', raw: e, paymentRef: e.links?.payment, subscriptionRef: e.links?.subscription, reason: e.details?.description };
    if (e.resource_type === 'payments') {
        const map: Record<string, NormalisedEvent['type']> = { confirmed: 'payment.settled', paid_out: 'payment.settled', failed: 'payment.failed', cancelled: 'payment.canceled', charged_back: 'dispute.opened', late_failure_settled: 'payment.failed', chargeback_settled: 'dispute.closed' };
        const type = map[e.action] || 'ignored';
        return { ...base, type: e.links?.subscription && type === 'payment.settled' ? 'subscription.renewed' : type };
    }
    if (e.resource_type === 'refunds') return { ...base, type: e.action === 'paid' ? 'refund.settled' : e.action === 'failed' ? 'refund.failed' : 'ignored' };
    if (e.resource_type === 'subscriptions') {
        const map: Record<string, NormalisedEvent['type']> = { cancelled: 'subscription.canceled', finished: 'subscription.canceled', paused: 'subscription.paused', resumed: 'subscription.active', payment_created: 'ignored' };
        return { ...base, type: map[e.action] || 'ignored' };
    }
    if (e.resource_type === 'mandates' && e.action === 'active') return { ...base, type: 'subscription.updated', subscription: { paymentRef: e.links?.mandate, customerRef: e.links?.customer } };
    return base;
}
