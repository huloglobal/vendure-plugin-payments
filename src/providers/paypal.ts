import { Order, RequestContext } from '@vendure/core';
import {
    ClientSession, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs, SessionOptions,
    SubscriptionCreateInput, SubscriptionOutcome, SubscriptionPlanInput, WebhookVerification,
} from '../core/provider';
import { idem, request } from '../core/rest';
import type { CredentialCheck, WebhookSetup } from '../core/provider';
import { fromDecimalString, toDecimalString } from '../core/money';

export const PAYPAL_CODE = 'hulo-paypal' as const;

function baseUrl(args: ProviderArgs): string {
    return String(args.environment) === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(args: ProviderArgs): Promise<string> {
    const key = `${args.environment}|${args.clientId}`;
    const hit = tokens.get(key);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    const r = await request('PayPal', `${baseUrl(args)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString('base64')}` },
        form: { grant_type: 'client_credentials' },
    });
    tokens.set(key, { token: r.access_token, exp: Date.now() + Number(r.expires_in || 3000) * 1000 });
    return r.access_token;
}

async function paypal<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST' | 'PATCH'; json?: any; idempotencyKey?: string; okStatuses?: number[] } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await accessToken(args)}`, prefer: 'return=representation' };
    if (opts.idempotencyKey) headers['paypal-request-id'] = opts.idempotencyKey;
    return request<T>('PayPal', `${baseUrl(args)}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers, json: opts.json, okStatuses: opts.okStatuses });
}

const link = (o: any, rel: string) => (o?.links || []).find((l: any) => l.rel === rel)?.href;

/**
 * PayPal through the Orders v2 API (buttons, Pay Later, Venmo where
 * available, cards via the JS SDK), authorise-or-capture intents, refunds,
 * disputes, Subscriptions API plans, approve links as pay-by-link, and
 * signature-verified webhooks.
 */
export const paypalProvider: PaymentProvider = {
    code: PAYPAL_CODE,
    name: 'PayPal',
    freeTier: false,
    capabilities: {
        session: true, manualCapture: true, partialCapture: true, refund: true, partialRefund: true,
        savedMethods: false, subscriptions: true, payByLink: true, disputes: true, wallets: ['paypal', 'venmo', 'paylater'],
    },

    publicConfig(args) {
        return { clientId: args.clientId, environment: String(args.environment) === 'live' ? 'live' : 'sandbox', intent: String(args.intent || 'CAPTURE').toLowerCase() };
    },

    connectFields: ['environment', 'clientId', 'clientSecret', 'intent', 'brandName'],

    dashboardLinks(args) {
        const live = String(args?.environment) === 'live';
        return { dashboard: live ? 'https://www.paypal.com/businessmanage/account/aboutBusiness' : 'https://www.sandbox.paypal.com/', keys: 'https://developer.paypal.com/dashboard/applications/' + (live ? 'live' : 'sandbox'), webhooks: 'https://developer.paypal.com/dashboard/applications/' + (live ? 'live' : 'sandbox'), docs: 'https://developer.paypal.com/api/rest/' };
    },

    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.clientId || !args.clientSecret) return { ok: false, message: 'Client ID and secret are both required.' };
        try {
            tokens.delete(`${args.environment}|${args.clientId}`);
            await accessToken(args);
            return { ok: true, message: `Connected to the PayPal REST app (${String(args.environment) === 'live' ? 'live' : 'sandbox'}).`, environment: String(args.environment) === 'live' ? 'live' : 'sandbox' };
        } catch (e: any) {
            return { ok: false, message: e.status === 401 ? 'PayPal rejected the client ID / secret pair.' : e.message };
        }
    },

    async ensureWebhook(args, url): Promise<WebhookSetup> {
        const events = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED', 'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.RESOLVED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'PAYMENT.SALE.COMPLETED'];
        const list = await paypal(args, '/v1/notifications/webhooks');
        const hook = (list.webhooks || []).find((w: any) => w.url === url);
        if (hook) return { args: { webhookId: hook.id }, ref: hook.id, note: 'Existing webhook kept.' };
        const created = await paypal(args, '/v1/notifications/webhooks', { json: { url, event_types: events.map(name => ({ name })) } });
        return { args: { webhookId: created.id }, ref: created.id };
    },

    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const intent = String(args.intent || 'CAPTURE').toUpperCase() === 'AUTHORIZE' ? 'AUTHORIZE' : 'CAPTURE';
        const o = await paypal(args, '/v2/checkout/orders', {
            json: {
                intent,
                purchase_units: [{
                    reference_id: order.code, custom_id: order.code, invoice_id: `${order.code}-${Date.now().toString(36).slice(-4)}`,
                    description: `Order ${order.code}`.slice(0, 127),
                    amount: { currency_code: order.currencyCode, value: toDecimalString(order.totalWithTax, order.currencyCode) },
                }],
                payment_source: { paypal: { experience_context: {
                    brand_name: String(args.brandName || '').slice(0, 127) || undefined, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
                    return_url: opts.returnUrl || 'https://example.com/return', cancel_url: opts.returnUrl || 'https://example.com/cancel',
                    landing_page: 'LOGIN',
                } } },
            },
            idempotencyKey: idem('hulo-pp', order.code, order.totalWithTax, order.currencyCode, Date.now().toString(36).slice(0, 5)),
        });
        return { provider: PAYPAL_CODE, flow: 'paypal-buttons', sessionId: o.id, checkoutUrl: link(o, 'payer-action') || link(o, 'approve'), publicKey: args.clientId, environment: this.publicConfig(args).environment, amount: order.totalWithTax, currency: order.currencyCode, config: { intent: intent.toLowerCase() } };
    },

    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const id = String(metadata?.paypalOrderId || metadata?.sessionId || '');
        if (!id) return { state: 'Error', amount: 0, errorMessage: 'Missing paypalOrderId' };
        let o = await paypal(args, `/v2/checkout/orders/${encodeURIComponent(id)}`);
        const unit = o.purchase_units?.[0];
        if (unit?.custom_id && unit.custom_id !== order.code) return { state: 'Error', amount: 0, errorMessage: 'PayPal order belongs to a different order' };
        if (unit?.amount?.currency_code && unit.amount.currency_code !== order.currencyCode) return { state: 'Error', amount: 0, errorMessage: 'Currency mismatch' };
        if (unit?.amount?.value && toDecimalString(order.totalWithTax, order.currencyCode) !== String(unit.amount.value)) return { state: 'Error', amount: 0, errorMessage: 'Amount mismatch' };
        const intent = String(o.intent || 'CAPTURE');
        if (o.status === 'APPROVED') {
            o = await paypal(args, `/v2/checkout/orders/${encodeURIComponent(id)}/${intent === 'AUTHORIZE' ? 'authorize' : 'capture'}`, { json: {}, idempotencyKey: idem('hulo-pp-final', id) });
        }
        const pu = o.purchase_units?.[0]?.payments || {};
        const capture = pu.captures?.[0];
        const auth = pu.authorizations?.[0];
        const meta = { paypalOrderId: id, payerEmail: o.payer?.email_address || null, payerId: o.payer?.payer_id || null, public: { method: 'paypal' } };
        if (capture) {
            if (capture.status === 'COMPLETED') return { state: 'Settled', amount: fromDecimalString(capture.amount?.value, order.currencyCode), transactionId: capture.id, metadata: { ...meta, captureId: capture.id } };
            if (capture.status === 'PENDING') return { state: 'Authorized', amount: order.totalWithTax, transactionId: capture.id, metadata: { ...meta, captureId: capture.id, pending: true } };
            return { state: 'Declined', amount: 0, transactionId: capture.id, errorMessage: `Capture ${capture.status}${capture.status_details?.reason ? ` (${capture.status_details.reason})` : ''}`, metadata: meta };
        }
        if (auth) {
            if (['CREATED', 'PENDING'].includes(auth.status)) return { state: 'Authorized', amount: fromDecimalString(auth.amount?.value, order.currencyCode), transactionId: auth.id, metadata: { ...meta, authorizationId: auth.id, capture: 'manual' } };
            return { state: 'Declined', amount: 0, transactionId: auth.id, errorMessage: `Authorization ${auth.status}`, metadata: meta };
        }
        return { state: 'Declined', amount: 0, transactionId: id, errorMessage: `PayPal order is ${o.status}`, metadata: meta };
    },

    async capture(args, paymentRef, amount, currency) {
        try {
            const r = await paypal(args, `/v2/payments/authorizations/${encodeURIComponent(paymentRef)}/capture`, { json: { amount: { currency_code: currency, value: toDecimalString(amount, currency) }, final_capture: true }, idempotencyKey: idem('hulo-pp-cap', paymentRef, amount) });
            return { success: r.status === 'COMPLETED' || r.status === 'PENDING', errorMessage: r.status === 'DECLINED' ? 'Capture declined' : undefined, metadata: { captureId: r.id } };
        } catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async cancel(args, paymentRef) {
        try { await paypal(args, `/v2/payments/authorizations/${encodeURIComponent(paymentRef)}/void`, { json: {}, okStatuses: [204] }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async refund(args, paymentRef, amount, currency, reason, metadata) {
        const captureId = metadata?.captureId || paymentRef;
        const r = await paypal(args, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
            json: { amount: { currency_code: currency, value: toDecimalString(amount, currency) }, note_to_payer: reason ? String(reason).slice(0, 255) : undefined },
            idempotencyKey: idem('hulo-pp-ref', captureId, amount, Date.now().toString(36).slice(0, 6)),
        });
        return { state: r.status === 'COMPLETED' ? 'Settled' : r.status === 'PENDING' ? 'Pending' : 'Failed', transactionId: r.id, metadata: { refundId: r.id, status: r.status } };
    },

    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        let ev: any;
        try { ev = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        if (!args.webhookId) return { ok: false, events: [], error: 'webhookId not configured on the payment method' };
        const v = await paypal(args, '/v1/notifications/verify-webhook-signature', {
            json: {
                auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
                transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: args.webhookId, webhook_event: ev,
            },
        }).catch((e: any) => ({ verification_status: 'FAILURE', error: e.message }));
        if (v.verification_status !== 'SUCCESS') return { ok: false, events: [], error: `signature verification ${v.verification_status}${v.error ? `: ${v.error}` : ''}` };
        return { ok: true, events: [normalisePayPalEvent(ev)] };
    },

    async ensurePlan(args, plan: SubscriptionPlanInput): Promise<string> {
        const product = await paypal(args, '/v1/catalogs/products', { json: { name: plan.name.slice(0, 127), type: 'SERVICE' }, idempotencyKey: idem('hulo-pp-prod', plan.variantId, plan.name) });
        const unit: Record<string, string> = { day: 'DAY', week: 'WEEK', month: 'MONTH', year: 'YEAR' };
        const p = await paypal(args, '/v1/billing/plans', {
            json: {
                product_id: product.id, name: plan.name.slice(0, 127), status: 'ACTIVE',
                billing_cycles: [{ frequency: { interval_unit: unit[plan.interval] || 'MONTH', interval_count: plan.intervalCount }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
                    pricing_scheme: { fixed_price: { value: toDecimalString(plan.amount, plan.currency), currency_code: plan.currency } } }],
                payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 3 },
            },
            idempotencyKey: idem('hulo-pp-plan', plan.variantId, plan.amount, plan.currency, plan.interval, plan.intervalCount),
        });
        return p.id;
    },

    async createSubscription(args, input: SubscriptionCreateInput): Promise<SubscriptionOutcome> {
        const plan = input.providerPlanRef || await this.ensurePlan!(args, input);
        const unit: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
        const start = new Date(Date.now() + (input.trialDays > 0 ? input.trialDays : unit[input.interval] * input.intervalCount) * 86400_000);
        const s = await paypal(args, '/v1/billing/subscriptions', {
            json: {
                plan_id: plan, quantity: String(input.quantity), start_time: start.toISOString(), custom_id: input.orderCode,
                subscriber: { email_address: input.customerEmail, name: input.customerName ? { given_name: input.customerName.split(' ')[0], surname: input.customerName.split(' ').slice(1).join(' ') || undefined } : undefined },
                application_context: { brand_name: String(args.brandName || '').slice(0, 127) || undefined, user_action: 'SUBSCRIBE_NOW', return_url: input.returnUrl || 'https://example.com/subscribed', cancel_url: input.returnUrl || 'https://example.com/cancelled' },
            },
            idempotencyKey: idem('hulo-pp-sub', input.orderCode, input.variantId),
        });
        return { providerSubscriptionRef: s.id, status: s.status === 'ACTIVE' ? 'active' : 'pending', approveUrl: link(s, 'approve'), currentPeriodEnd: start.toISOString() };
    },

    async cancelSubscription(args, ref, atPeriodEnd) {
        if (atPeriodEnd) return { status: 'active' }; // PayPal has no period-end cancel: the scheduler cancels at currentPeriodEnd
        await paypal(args, `/v1/billing/subscriptions/${encodeURIComponent(ref)}/cancel`, { json: { reason: 'Cancelled by merchant' }, okStatuses: [204] });
        return { status: 'canceled' };
    },

    async pauseSubscription(args, ref, resume) {
        await paypal(args, `/v1/billing/subscriptions/${encodeURIComponent(ref)}/${resume ? 'activate' : 'suspend'}`, { json: { reason: resume ? 'Resumed by merchant' : 'Paused by merchant' }, okStatuses: [204] });
        return { status: resume ? 'active' : 'paused' };
    },

    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const o = await paypal(args, '/v2/checkout/orders', {
            json: {
                intent: 'CAPTURE',
                purchase_units: [{ reference_id: input.orderCode, custom_id: input.orderCode, description: input.description.slice(0, 127), amount: { currency_code: input.currency, value: toDecimalString(input.amount, input.currency) } }],
                payment_source: { paypal: { experience_context: { brand_name: String(args.brandName || '').slice(0, 127) || undefined, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: input.returnUrl || 'https://example.com/paid', cancel_url: input.returnUrl || 'https://example.com/cancelled' } } },
            },
            idempotencyKey: idem('hulo-pp-link', input.orderCode, input.amount, Date.now().toString(36).slice(0, 5)),
        });
        return { url: link(o, 'payer-action') || link(o, 'approve'), ref: o.id };
    },
};

export function normalisePayPalEvent(ev: any): NormalisedEvent {
    const r = ev?.resource || {};
    const cur = r.amount?.currency_code ? String(r.amount.currency_code).toUpperCase() : undefined;
    const amount = cur && r.amount?.value != null ? fromDecimalString(r.amount.value, cur) : undefined;
    const base = { id: String(ev?.id || ''), orderCode: r.custom_id || r.purchase_units?.[0]?.custom_id, paymentRef: r.id, amount, currency: cur, raw: ev };
    switch (ev?.event_type) {
        case 'CHECKOUT.ORDER.APPROVED': return { ...base, type: 'paylink.completed', paymentRef: r.id };
        case 'PAYMENT.CAPTURE.COMPLETED': return { ...base, type: 'payment.settled' };
        case 'PAYMENT.CAPTURE.PENDING': return { ...base, type: 'ignored' };
        case 'PAYMENT.CAPTURE.DENIED': case 'PAYMENT.CAPTURE.DECLINED': return { ...base, type: 'payment.failed', reason: r.status_details?.reason };
        case 'PAYMENT.AUTHORIZATION.CREATED': return { ...base, type: 'payment.authorized' };
        case 'PAYMENT.AUTHORIZATION.VOIDED': return { ...base, type: 'payment.canceled' };
        case 'PAYMENT.CAPTURE.REFUNDED': return { ...base, type: 'refund.settled' };
        case 'PAYMENT.CAPTURE.REVERSED': return { ...base, type: 'dispute.opened', reason: 'reversed' };
        case 'CUSTOMER.DISPUTE.CREATED': return { ...base, type: 'dispute.opened', paymentRef: r.disputed_transactions?.[0]?.seller_transaction_id, reason: r.reason, amount: r.dispute_amount?.value ? fromDecimalString(r.dispute_amount.value, r.dispute_amount.currency_code) : undefined, currency: r.dispute_amount?.currency_code };
        case 'CUSTOMER.DISPUTE.RESOLVED': return { ...base, type: 'dispute.closed', paymentRef: r.disputed_transactions?.[0]?.seller_transaction_id, reason: r.dispute_outcome?.outcome_code || r.status };
        case 'BILLING.SUBSCRIPTION.ACTIVATED': return { ...base, type: 'subscription.active', subscriptionRef: r.id, subscription: { status: 'active', currentPeriodEnd: r.billing_info?.next_billing_time } };
        case 'BILLING.SUBSCRIPTION.CANCELLED': case 'BILLING.SUBSCRIPTION.EXPIRED': return { ...base, type: 'subscription.canceled', subscriptionRef: r.id };
        case 'BILLING.SUBSCRIPTION.SUSPENDED': return { ...base, type: 'subscription.paused', subscriptionRef: r.id };
        case 'BILLING.SUBSCRIPTION.RE-ACTIVATED': case 'BILLING.SUBSCRIPTION.UPDATED': return { ...base, type: 'subscription.updated', subscriptionRef: r.id, subscription: { status: String(r.status || '').toLowerCase() === 'active' ? 'active' : undefined, currentPeriodEnd: r.billing_info?.next_billing_time } };
        case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': return { ...base, type: 'subscription.payment_failed', subscriptionRef: r.id };
        case 'PAYMENT.SALE.COMPLETED': return r.billing_agreement_id
            ? { ...base, type: 'subscription.renewed', subscriptionRef: r.billing_agreement_id, subscription: {} }
            : { ...base, type: 'ignored' };
        default: return { ...base, type: 'ignored' };
    }
}
