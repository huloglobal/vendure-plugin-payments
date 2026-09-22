import { Order, RequestContext } from '@vendure/core';
import {
    ClientSession, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs, SessionOptions,
    SubscriptionCreateInput, SubscriptionOutcome, WebhookVerification,
} from '../core/provider';
import { idem, request } from '../core/rest';
import type { CredentialCheck } from '../core/provider';
import { fromDecimalString, toDecimalString } from '../core/money';
import { getRuntime } from '../core/runtime';

export const MOLLIE_CODE = 'hulo-mollie' as const;
const API = 'https://api.mollie.com/v2';

async function mollie<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'; json?: any; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${args.apiKey}` };
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    return request<T>('Mollie', `${API}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers, json: opts.json });
}

function webhookUrl(): string { return `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/hulo-payments/webhook/${MOLLIE_CODE}`; }

function mollieInterval(interval: string, count: number): string {
    const unit: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'month' };
    const n = interval === 'year' ? 12 * Math.max(1, count) : Math.max(1, count);
    return `${n} ${unit[interval] || 'month'}${n === 1 ? '' : 's'}`;
}

/**
 * Mollie through the Payments API: iDEAL, cards, Bancontact, SEPA, Klarna,
 * PayPal-via-Mollie, Apple Pay and the rest of the Mollie catalogue on a
 * hosted checkout page, plus manual capture (where the method supports
 * authorisation), refunds, chargebacks, native subscriptions on customer
 * mandates and Payment Links. Mollie webhooks carry only an id, so every
 * webhook is verified by fetching the payment from the API.
 */
export const mollieProvider: PaymentProvider = {
    code: MOLLIE_CODE,
    name: 'Mollie',
    freeTier: false,
    capabilities: {
        session: true, manualCapture: true, partialCapture: true, refund: true, partialRefund: true,
        savedMethods: false, subscriptions: true, payByLink: true, disputes: true,
        wallets: ['ideal', 'apple_pay', 'bancontact', 'klarna', 'paypal', 'sepa', 'twint'],
    },

    publicConfig(args) {
        return { profileId: args.profileId || null, environment: String(args.apiKey || '').startsWith('live_') ? 'live' : 'test' };
    },

    connectFields: ['apiKey', 'captureMode'],

    dashboardLinks() {
        return { dashboard: 'https://my.mollie.com/dashboard/', keys: 'https://my.mollie.com/dashboard/developers/api-keys', docs: 'https://docs.mollie.com/reference/authentication' };
    },

    async verifyCredentials(args): Promise<CredentialCheck> {
        const key = String(args.apiKey || '');
        if (!/^(live|test)_/.test(key)) return { ok: false, message: 'The API key should start with live_ or test_ (Developers → API keys).' };
        try {
            const r = await mollie(args, '/methods');
            const n = (r._embedded?.methods || []).length;
            return { ok: true, message: `Connected to Mollie (${key.startsWith('live_') ? 'live' : 'test'}) — ${n} payment method${n === 1 ? '' : 's'} active on the profile. Webhooks need no setup with Mollie.`, environment: key.startsWith('live_') ? 'live' : 'test' };
        } catch (e: any) {
            return { ok: false, message: e.status === 401 ? 'Mollie rejected the API key.' : e.message };
        }
    },

    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const recurring = !!(opts.subscription || opts.savePaymentMethod);
        const json: any = {
            amount: { currency: order.currencyCode, value: toDecimalString(order.totalWithTax, order.currencyCode) },
            description: `Order ${order.code}`,
            redirectUrl: opts.returnUrl || 'https://example.com/return',
            webhookUrl: webhookUrl(),
            metadata: { orderCode: order.code, orderId: String(order.id) },
            locale: opts.locale && /^[a-z]{2}_[A-Z]{2}$/.test(opts.locale) ? opts.locale : undefined,
            method: args.method ? String(args.method).split(',').map(s => s.trim()).filter(Boolean) : undefined,
            captureMode: args.captureMode === 'manual' ? 'manual' : undefined,
        };
        if (recurring && opts.providerCustomerRef) { json.customerId = opts.providerCustomerRef; json.sequenceType = 'first'; }
        const p = await mollie(args, '/payments', { json, idempotencyKey: idem('hulo-mol', order.code, json.amount.value, order.currencyCode, recurring ? 'r' : '') });
        return { provider: MOLLIE_CODE, flow: 'redirect', sessionId: p.id, checkoutUrl: p._links?.checkout?.href, environment: this.publicConfig(args).environment, amount: order.totalWithTax, currency: order.currencyCode, expiresAt: p.expiresAt };
    },

    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const id = String(metadata?.molliePaymentId || metadata?.sessionId || '');
        if (!/^tr_[A-Za-z0-9]+$/.test(id)) return { state: 'Error', amount: 0, errorMessage: 'Missing or invalid Mollie payment id' };
        const p = await mollie(args, `/payments/${id}`);
        if (p.metadata?.orderCode && p.metadata.orderCode !== order.code) return { state: 'Error', amount: 0, errorMessage: 'Mollie payment belongs to a different order' };
        if (p.amount?.currency !== order.currencyCode) return { state: 'Error', amount: 0, errorMessage: 'Currency mismatch' };
        if (toDecimalString(order.totalWithTax, order.currencyCode) !== String(p.amount?.value)) return { state: 'Error', amount: 0, errorMessage: 'Amount mismatch' };
        const meta = { molliePaymentId: p.id, method: p.method || null, customerId: p.customerId || null, mandateId: p.mandateId || null, public: { method: p.method || 'mollie', last4: p.details?.cardNumber?.slice(-4) || null } };
        switch (p.status) {
            case 'paid': return { state: 'Settled', amount: fromDecimalString(p.amount.value, order.currencyCode), transactionId: p.id, metadata: meta };
            case 'authorized': return { state: 'Authorized', amount: order.totalWithTax, transactionId: p.id, metadata: { ...meta, capture: 'manual' } };
            case 'pending': return { state: 'Authorized', amount: order.totalWithTax, transactionId: p.id, metadata: { ...meta, pending: true } };
            case 'open': return { state: 'Error', amount: 0, transactionId: p.id, errorMessage: 'Payment not completed yet — finish it on the Mollie page', metadata: meta };
            default: return { state: 'Declined', amount: 0, transactionId: p.id, errorMessage: `Mollie payment ${p.status}${p.details?.failureReason ? ` (${p.details.failureReason})` : ''}`, metadata: meta };
        }
    },

    async capture(args, paymentRef, amount, currency) {
        try { await mollie(args, `/payments/${paymentRef}/captures`, { json: { amount: { currency, value: toDecimalString(amount, currency) } }, idempotencyKey: idem('hulo-mol-cap', paymentRef, amount) }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async cancel(args, paymentRef) {
        try { await mollie(args, `/payments/${paymentRef}`, { method: 'DELETE' }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async refund(args, paymentRef, amount, currency, reason) {
        const r = await mollie(args, `/payments/${paymentRef}/refunds`, { json: { amount: { currency, value: toDecimalString(amount, currency) }, description: reason ? String(reason).slice(0, 140) : undefined }, idempotencyKey: idem('hulo-mol-ref', paymentRef, amount, Date.now().toString(36).slice(0, 6)) });
        return { state: r.status === 'refunded' ? 'Settled' : r.status === 'failed' ? 'Failed' : 'Pending', transactionId: r.id, metadata: { refundId: r.id, status: r.status } };
    },

    /** Mollie posts `id=tr_…` with no signature; fetching the object from the API is the verification. */
    async verifyWebhook(args, rawBody, _headers, query): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        const id = String(new URLSearchParams(body).get('id') || query?.id || '');
        if (!/^(tr|sub|re|chb)_[A-Za-z0-9]+$/.test(id)) return { ok: false, events: [], error: 'no Mollie id in webhook' };
        if (!id.startsWith('tr_')) return { ok: true, events: [] };
        const p = await mollie(args, `/payments/${id}`);
        const cur = String(p.amount?.currency || '').toUpperCase();
        const amount = fromDecimalString(p.amount?.value, cur);
        const orderCode = p.metadata?.orderCode || (String(p.description || '').match(/Order ([A-Z0-9]{8,32})/) || [])[1];
        const refunded = p.amountRefunded?.value ? fromDecimalString(p.amountRefunded.value, cur) : 0;
        const charged = p.amountChargedBack?.value ? fromDecimalString(p.amountChargedBack.value, cur) : 0;
        const events: NormalisedEvent[] = [];
        const base = { orderCode, paymentRef: p.id, currency: cur, raw: p };
        if (p.subscriptionId) {
            events.push({ ...base, id: `${p.id}:${p.status}`, type: p.status === 'paid' ? 'subscription.renewed' : ['failed', 'expired', 'canceled'].includes(p.status) ? 'subscription.payment_failed' : 'ignored', subscriptionRef: p.subscriptionId, amount, reason: p.details?.failureReason });
        } else {
            const type = p.status === 'paid' ? 'payment.settled' : p.status === 'authorized' ? 'payment.authorized' : ['failed', 'expired'].includes(p.status) ? 'payment.failed' : p.status === 'canceled' ? 'payment.canceled' : 'ignored';
            events.push({ ...base, id: `${p.id}:${p.status}`, type, amount, reason: p.details?.failureReason,
                subscription: p.mandateId ? { paymentRef: p.mandateId, customerRef: p.customerId } : undefined });
        }
        if (refunded > 0) events.push({ ...base, id: `${p.id}:refunded:${refunded}`, type: 'refund.settled', amount: refunded });
        if (charged > 0) events.push({ ...base, id: `${p.id}:chargeback:${charged}`, type: 'dispute.opened', amount: charged, reason: 'chargeback' });
        return { ok: true, events };
    },

    async createSubscription(args, input: SubscriptionCreateInput): Promise<SubscriptionOutcome> {
        let customer = input.providerCustomerRef || '';
        let mandate = input.providerPaymentRef || '';
        if (input.initialPaymentRef && (!customer || !mandate)) {
            const p = await mollie(args, `/payments/${input.initialPaymentRef}`);
            customer = customer || p.customerId || ''; mandate = mandate || p.mandateId || '';
        }
        if (!customer) throw new Error('Mollie subscriptions need the first payment to be created for a customer with sequenceType=first (enable saved cards or subscriptions on the session)');
        if (!mandate) {
            const m = await mollie(args, `/customers/${customer}/mandates`);
            mandate = (m._embedded?.mandates || []).find((x: any) => x.status === 'valid')?.id || '';
        }
        if (!mandate) return { providerSubscriptionRef: `hulo-pending:${input.orderCode}:${input.variantId}`, status: 'pending', providerCustomerRef: customer };
        const unit: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
        const start = new Date(Date.now() + (input.trialDays > 0 ? input.trialDays : unit[input.interval] * input.intervalCount) * 86400_000);
        const s = await mollie(args, `/customers/${customer}/subscriptions`, {
            json: {
                amount: { currency: input.currency, value: toDecimalString(input.amount * input.quantity, input.currency) },
                interval: mollieInterval(input.interval, input.intervalCount), startDate: start.toISOString().slice(0, 10),
                description: `${input.name} × ${input.quantity} (order ${input.orderCode})`.slice(0, 200), mandateId: mandate,
                webhookUrl: webhookUrl(), metadata: { orderCode: input.orderCode, variantId: String(input.variantId) },
            },
            idempotencyKey: idem('hulo-mol-sub', input.orderCode, input.variantId),
        });
        return { providerSubscriptionRef: s.id, status: s.status === 'active' ? 'active' : 'pending', currentPeriodEnd: start.toISOString(), providerCustomerRef: customer, providerPaymentRef: mandate };
    },

    async cancelSubscription(args, ref, atPeriodEnd) {
        if (atPeriodEnd) return { status: 'active' }; // scheduler cancels at currentPeriodEnd
        const customer = await findSubscriptionCustomer(args, ref);
        if (customer) await mollie(args, `/customers/${customer}/subscriptions/${ref}`, { method: 'DELETE' });
        return { status: 'canceled' };
    },

    async pauseSubscription() { throw new Error('Mollie subscriptions cannot be paused — cancel and re-subscribe instead'); },

    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const r = await mollie(args, '/payment-links', {
            json: { amount: { currency: input.currency, value: toDecimalString(input.amount, input.currency) }, description: `Order ${input.orderCode} — ${input.description}`.slice(0, 200), redirectUrl: input.returnUrl || undefined, webhookUrl: webhookUrl(), expiresAt: input.expiresAt || undefined },
            idempotencyKey: idem('hulo-mol-link', input.orderCode, input.amount, Date.now().toString(36).slice(0, 5)),
        });
        return { url: r._links?.paymentLink?.href, ref: r.id, expiresAt: r.expiresAt };
    },
};

async function findSubscriptionCustomer(args: ProviderArgs, subscriptionRef: string): Promise<string | null> {
    const r = await mollie(args, `/subscriptions?limit=250`).catch(() => null);
    const s = (r?._embedded?.subscriptions || []).find((x: any) => x.id === subscriptionRef);
    return s?.customerId || null;
}

/** Ensure a Mollie customer exists for a Vendure customer (needed for mandates). */
export async function ensureMollieCustomer(args: ProviderArgs, email: string, name?: string): Promise<string> {
    const c = await mollie(args, '/customers', { json: { email, name: name || undefined }, idempotencyKey: idem('hulo-mol-cus', email) });
    return c.id;
}
