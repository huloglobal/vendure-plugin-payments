import { createHmac } from 'crypto';
import { Order, RequestContext } from '@vendure/core';
import {
    ClientSession, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs,
    SavedMethod, SessionOptions, SubscriptionCreateInput, SubscriptionOutcome, SubscriptionPlanInput, WebhookVerification,
} from '../core/provider';
import { idem, request, safeEqual } from '../core/rest';
import type { CredentialCheck, WebhookSetup } from '../core/provider';
import { fromProviderMinor, toProviderMinor } from '../core/money';

const API = 'https://api.stripe.com/v1';
const API_VERSION = '2024-06-20';
export const STRIPE_CODE = 'hulo-stripe' as const;

function headers(args: ProviderArgs, idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${args.secretKey}`, 'stripe-version': API_VERSION };
    if (idempotencyKey) h['idempotency-key'] = idempotencyKey;
    return h;
}

async function stripe<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; form?: Record<string, unknown>; idempotencyKey?: string } = {}): Promise<T> {
    return request<T>('Stripe', `${API}${path}`, { method: opts.method || (opts.form ? 'POST' : 'GET'), headers: headers(args, opts.idempotencyKey), form: opts.form });
}

function intervalSeconds(interval: string, count: number): number {
    const unit: Record<string, number> = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
    return (unit[interval] || unit.month) * Math.max(1, count);
}

/**
 * Stripe through the Payment Intents API: cards, Apple Pay, Google Pay,
 * Link, Klarna, bank debits — whatever the Stripe dashboard enables —
 * rendered by the Payment Element from a client secret. Manual capture,
 * partial capture and refunds, saved cards on Stripe Customers, native
 * subscriptions, Checkout Sessions as pay-by-link, signed webhooks.
 */
export const stripeProvider: PaymentProvider = {
    code: STRIPE_CODE,
    name: 'Stripe',
    freeTier: true,
    capabilities: {
        session: true, manualCapture: true, partialCapture: true, refund: true, partialRefund: true,
        savedMethods: true, subscriptions: true, payByLink: true, disputes: true,
        wallets: ['apple_pay', 'google_pay', 'link'],
    },

    publicConfig(args) {
        return { publishableKey: args.publishableKey, environment: String(args.secretKey || '').startsWith('sk_live') ? 'live' : 'test' };
    },

    connectFields: ['secretKey', 'publishableKey', 'captureMethod'],

    dashboardLinks(args) {
        const test = !String(args?.secretKey || '').startsWith('sk_live');
        const base = test ? 'https://dashboard.stripe.com/test' : 'https://dashboard.stripe.com';
        return { dashboard: base, keys: `${base}/apikeys`, webhooks: `${base}/webhooks`, docs: 'https://docs.stripe.com/keys' };
    },

    async verifyCredentials(args): Promise<CredentialCheck> {
        const sk = String(args.secretKey || ''); const pk = String(args.publishableKey || '');
        if (!/^(sk|rk)_(live|test)_/.test(sk)) return { ok: false, message: 'The secret key should start with sk_live_ or sk_test_ (Developers → API keys).' };
        if (pk && !/^pk_(live|test)_/.test(pk)) return { ok: false, message: 'The publishable key should start with pk_live_ or pk_test_.' };
        const env = sk.includes('_live_') ? 'live' : 'test';
        if (pk && !pk.includes(`_${env}_`)) return { ok: false, message: `The publishable key is for ${pk.includes('_live_') ? 'live' : 'test'} mode but the secret key is ${env} — use the pair from the same mode.` };
        try {
            const acct = await stripe(args, '/account');
            const name = acct.business_profile?.name || acct.settings?.dashboard?.display_name || acct.email || acct.id;
            return { ok: true, message: `Connected to ${name} (${env})${acct.charges_enabled === false ? ' — charges are not enabled on this account yet' : ''}.`, account: name, environment: env };
        } catch (e: any) {
            return { ok: false, message: e.status === 401 ? 'Stripe rejected the secret key.' : e.message };
        }
    },

    async ensureWebhook(args, url): Promise<WebhookSetup> {
        const events = ['payment_intent.succeeded', 'payment_intent.amount_capturable_updated', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.refund.updated', 'charge.dispute.created', 'charge.dispute.closed', 'checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused'];
        const list = await stripe(args, '/webhook_endpoints?limit=100');
        // A secret can only be read at creation, so an existing endpoint for our URL is replaced.
        for (const ep of (list.data || []).filter((e: any) => e.url === url)) {
            if (args.webhookSecret && ep.metadata?.hulo === '1') return { args: {}, ref: ep.id, note: 'Existing webhook kept.' };
            await stripe(args, `/webhook_endpoints/${ep.id}`, { method: 'DELETE' }).catch(() => undefined);
        }
        const ep = await stripe(args, '/webhook_endpoints', { form: { url, description: 'HULO Payments for Vendure', enabled_events: events, metadata: { hulo: '1' } } });
        return { args: { webhookSecret: ep.secret }, ref: ep.id };
    },

    async createSession(ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const amount = toProviderMinor(order.totalWithTax, order.currencyCode);
        const form: Record<string, unknown> = {
            amount,
            currency: order.currencyCode.toLowerCase(),
            capture_method: args.captureMethod === 'manual' ? 'manual' : 'automatic',
            metadata: { orderCode: order.code, channelToken: ctx.channel?.token || '', vendureOrderId: String(order.id) },
            description: `Order ${order.code}`,
        };
        const types = String(args.paymentMethodTypes || '').split(',').map(s => s.trim()).filter(Boolean);
        if (types.length) form.payment_method_types = types; else form.automatic_payment_methods = { enabled: true };
        if (args.statementDescriptorSuffix) form.statement_descriptor_suffix = String(args.statementDescriptorSuffix).slice(0, 22);
        if (order.customer?.emailAddress) form.receipt_email = order.customer.emailAddress;
        if (opts.providerCustomerRef) form.customer = opts.providerCustomerRef;
        if (opts.savePaymentMethod || opts.subscription) form.setup_future_usage = 'off_session';
        if (opts.savedMethodId) form.payment_method = opts.savedMethodId;
        const pi = await stripe(args, '/payment_intents', { form, idempotencyKey: idem('hulo-pi', order.code, amount, order.currencyCode, opts.savedMethodId, opts.providerCustomerRef) });
        return {
            provider: STRIPE_CODE, flow: 'stripe-element', clientSecret: pi.client_secret, sessionId: pi.id, publicKey: args.publishableKey,
            environment: this.publicConfig(args).environment, amount: order.totalWithTax, currency: order.currencyCode,
        };
    },

    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const id = String(metadata?.paymentIntentId || metadata?.sessionId || '');
        if (!/^pi_[A-Za-z0-9]+$/.test(id)) return { state: 'Error', amount: 0, errorMessage: 'Missing or invalid paymentIntentId' };
        const pi = await stripe(args, `/payment_intents/${id}?expand[]=latest_charge`);
        if (pi.metadata?.orderCode && pi.metadata.orderCode !== order.code) {
            return { state: 'Error', amount: 0, errorMessage: 'PaymentIntent belongs to a different order' };
        }
        if (String(pi.currency).toUpperCase() !== order.currencyCode) return { state: 'Error', amount: 0, errorMessage: 'Currency mismatch' };
        const expected = toProviderMinor(order.totalWithTax, order.currencyCode);
        if (Number(pi.amount) !== expected) return { state: 'Error', amount: 0, errorMessage: `Amount mismatch (intent ${pi.amount}, order ${expected})` };
        const meta = {
            paymentIntentId: pi.id, customer: pi.customer || null, paymentMethod: pi.payment_method || null,
            paymentMethodType: pi.latest_charge?.payment_method_details?.type || null,
            cardBrand: pi.latest_charge?.payment_method_details?.card?.brand || null,
            last4: pi.latest_charge?.payment_method_details?.card?.last4 || null,
            public: { method: pi.latest_charge?.payment_method_details?.type || 'card', last4: pi.latest_charge?.payment_method_details?.card?.last4 || null },
        };
        switch (pi.status) {
            case 'succeeded':
                return { state: 'Settled', amount: fromProviderMinor(Number(pi.amount_received || pi.amount), order.currencyCode), transactionId: pi.id, metadata: meta };
            case 'requires_capture':
                return { state: 'Authorized', amount: order.totalWithTax, transactionId: pi.id, metadata: { ...meta, capture: 'manual' } };
            case 'processing':
                return { state: 'Authorized', amount: order.totalWithTax, transactionId: pi.id, metadata: { ...meta, processing: true } };
            default:
                return { state: 'Declined', amount: 0, transactionId: pi.id, errorMessage: pi.last_payment_error?.message || `PaymentIntent is ${pi.status}`, metadata: meta };
        }
    },

    async capture(args, paymentRef, amount, currency) {
        try {
            await stripe(args, `/payment_intents/${paymentRef}/capture`, { form: { amount_to_capture: toProviderMinor(amount, currency) }, idempotencyKey: idem('hulo-cap', paymentRef, amount) });
            return { success: true };
        } catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async cancel(args, paymentRef) {
        try { await stripe(args, `/payment_intents/${paymentRef}/cancel`, { form: {} }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async refund(args, paymentRef, amount, currency, reason) {
        const stripeReason = ['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason) ? reason : undefined;
        const r = await stripe(args, '/refunds', {
            form: { payment_intent: paymentRef, amount: toProviderMinor(amount, currency), reason: stripeReason, metadata: { note: reason || '' } },
            idempotencyKey: idem('hulo-ref', paymentRef, amount, reason, Date.now().toString(36).slice(0, 6)),
        });
        return { state: r.status === 'succeeded' ? 'Settled' : r.status === 'failed' ? 'Failed' : 'Pending', transactionId: r.id, metadata: { refundId: r.id, status: r.status } };
    },

    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const sig = String(headers['stripe-signature'] || '');
        const parts = Object.fromEntries(sig.split(',').map(p => p.split('=') as [string, string]));
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        if (!args.webhookSecret) return { ok: false, events: [], error: 'webhookSecret not configured on the payment method' };
        if (!parts.t || !parts.v1) return { ok: false, events: [], error: 'missing Stripe-Signature' };
        if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return { ok: false, events: [], error: 'signature timestamp outside tolerance' };
        const expected = createHmac('sha256', String(args.webhookSecret)).update(`${parts.t}.${body}`).digest('hex');
        if (!safeEqual(expected, parts.v1)) return { ok: false, events: [], error: 'signature mismatch' };
        let ev: any;
        try { ev = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        return { ok: true, events: [normaliseStripeEvent(ev)] };
    },

    async listSavedMethods(args, customerRef): Promise<SavedMethod[]> {
        const r = await stripe(args, `/customers/${customerRef}/payment_methods?type=card&limit=20`);
        return (r.data || []).map((pm: any) => ({
            id: pm.id, type: pm.type, brand: pm.card?.brand, last4: pm.card?.last4,
            expiry: pm.card ? `${String(pm.card.exp_month).padStart(2, '0')}/${String(pm.card.exp_year).slice(-2)}` : undefined, provider: STRIPE_CODE,
        }));
    },

    async removeSavedMethod(args, _customerRef, methodId) {
        await stripe(args, `/payment_methods/${methodId}/detach`, { form: {} });
        return true;
    },

    async ensurePlan(args, plan: SubscriptionPlanInput): Promise<string> {
        const search = await stripe(args, `/prices/search?query=${encodeURIComponent(`metadata['huloVariantId']:'${plan.variantId}' AND active:'true'`)}&limit=5`).catch(() => ({ data: [] }));
        const match = (search.data || []).find((p: any) =>
            Number(p.unit_amount) === toProviderMinor(plan.amount, plan.currency) && p.currency === plan.currency.toLowerCase()
            && p.recurring?.interval === plan.interval && Number(p.recurring?.interval_count) === plan.intervalCount);
        if (match) return match.id;
        const product = await stripe(args, '/products', { form: { name: plan.name, metadata: { huloVariantId: String(plan.variantId) } }, idempotencyKey: idem('hulo-prod', plan.variantId, plan.name) });
        const price = await stripe(args, '/prices', {
            form: {
                product: product.id, unit_amount: toProviderMinor(plan.amount, plan.currency), currency: plan.currency.toLowerCase(),
                recurring: { interval: plan.interval, interval_count: plan.intervalCount }, metadata: { huloVariantId: String(plan.variantId) },
            },
            idempotencyKey: idem('hulo-price', plan.variantId, plan.amount, plan.currency, plan.interval, plan.intervalCount),
        });
        return price.id;
    },

    async createSubscription(args, input: SubscriptionCreateInput): Promise<SubscriptionOutcome> {
        let customer = input.providerCustomerRef || '';
        let paymentMethod = input.providerPaymentRef || '';
        if (input.initialPaymentRef && (!customer || !paymentMethod)) {
            const pi = await stripe(args, `/payment_intents/${input.initialPaymentRef}`);
            customer = customer || pi.customer || '';
            paymentMethod = paymentMethod || pi.payment_method || '';
        }
        if (!customer) {
            const c = await stripe(args, '/customers', { form: { email: input.customerEmail, name: input.customerName || undefined, metadata: { orderCode: input.orderCode } }, idempotencyKey: idem('hulo-cus', input.customerEmail, input.orderCode) });
            customer = c.id;
        }
        if (!paymentMethod) throw new Error('No reusable payment method on the initial payment (set setup_future_usage by enabling saved cards or subscriptions on the session)');
        // Attach if the method was created without a customer (guest checkout).
        const pm = await stripe(args, `/payment_methods/${paymentMethod}`);
        if (!pm.customer) await stripe(args, `/payment_methods/${paymentMethod}/attach`, { form: { customer } });
        const price = input.providerPlanRef || await this.ensurePlan!(args, input);
        // The order already paid the first period: bill again after one
        // interval (or after the trial when the product has one).
        const firstCharge = Math.floor(Date.now() / 1000) + (input.trialDays > 0 ? input.trialDays * 86400 : intervalSeconds(input.interval, input.intervalCount));
        const sub = await stripe(args, '/subscriptions', {
            form: {
                customer, items: [{ price, quantity: input.quantity }], default_payment_method: paymentMethod,
                trial_end: firstCharge, proration_behavior: 'none', collection_method: 'charge_automatically',
                metadata: { orderCode: input.orderCode, huloVariantId: String(input.variantId) },
            },
            idempotencyKey: idem('hulo-sub', input.orderCode, input.variantId),
        });
        return {
            providerSubscriptionRef: sub.id, status: sub.status === 'trialing' ? 'trialing' : sub.status === 'active' ? 'active' : 'pending',
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : undefined,
            providerCustomerRef: customer, providerPaymentRef: paymentMethod,
        };
    },

    async cancelSubscription(args, ref, atPeriodEnd) {
        if (atPeriodEnd) {
            const s = await stripe(args, `/subscriptions/${ref}`, { form: { cancel_at_period_end: true } });
            return { status: 'active', currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : undefined };
        }
        await stripe(args, `/subscriptions/${ref}`, { method: 'DELETE' });
        return { status: 'canceled' };
    },

    async pauseSubscription(args, ref, resume) {
        await stripe(args, `/subscriptions/${ref}`, { form: resume ? { pause_collection: '' } : { pause_collection: { behavior: 'void' } } });
        return { status: resume ? 'active' : 'paused' };
    },

    async chargeStored(args, input): Promise<PaymentOutcome> {
        try {
            const pi = await stripe(args, '/payment_intents', {
                form: {
                    amount: toProviderMinor(input.amount, input.currency), currency: input.currency.toLowerCase(), customer: input.customerRef,
                    payment_method: input.paymentRef, off_session: true, confirm: true, description: input.description, metadata: { reference: input.reference },
                },
                idempotencyKey: idem('hulo-renew', input.reference),
            });
            return pi.status === 'succeeded'
                ? { state: 'Settled', amount: input.amount, transactionId: pi.id }
                : { state: 'Declined', amount: 0, transactionId: pi.id, errorMessage: pi.last_payment_error?.message || pi.status };
        } catch (e: any) {
            return { state: 'Declined', amount: 0, errorMessage: e.message };
        }
    },

    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const lines = (input.lines && input.lines.length ? input.lines : [{ name: input.description, quantity: 1, amount: input.amount }]);
        const session = await stripe(args, '/checkout/sessions', {
            form: {
                mode: 'payment',
                line_items: lines.map(l => ({ quantity: l.quantity, price_data: { currency: input.currency.toLowerCase(), unit_amount: toProviderMinor(l.amount, input.currency), product_data: { name: l.name.slice(0, 120) } } })),
                success_url: input.returnUrl ? `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}paid=1` : 'https://example.com/paid',
                cancel_url: input.returnUrl || 'https://example.com/cancelled',
                customer_email: input.customerEmail || undefined,
                metadata: { orderCode: input.orderCode, huloPayLink: '1' },
                payment_intent_data: { metadata: { orderCode: input.orderCode, huloPayLink: '1' }, description: input.description },
                expires_at: input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1000) : undefined,
            },
            idempotencyKey: idem('hulo-link', input.orderCode, input.amount, Date.now().toString(36).slice(0, 5)),
        });
        return { url: session.url, ref: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : undefined };
    },
};

export function normaliseStripeEvent(ev: any): NormalisedEvent {
    const o = ev?.data?.object || {};
    const base = { id: String(ev?.id || ''), raw: ev };
    const cur = o.currency ? String(o.currency).toUpperCase() : undefined;
    const money = (v: any) => cur && v != null ? fromProviderMinor(Number(v), cur) : undefined;
    // Our intents are stamped with vendureOrderId; an intent that names an order but was not created by
    // this plugin belongs to another integration sharing the account (Vendure's StripePlugin, Checkout Guard…).
    const md = o.metadata || {};
    const foreign = !md.vendureOrderId && !md.huloPayLink && !!(md.orderCode || md.orderId);
    switch (ev?.type) {
        case 'payment_intent.succeeded':
            return { ...base, foreign, type: 'payment.settled', orderCode: o.metadata?.orderCode, paymentRef: o.id, amount: money(o.amount_received ?? o.amount), currency: cur };
        case 'payment_intent.amount_capturable_updated':
            return { ...base, foreign, type: 'payment.authorized', orderCode: o.metadata?.orderCode, paymentRef: o.id, amount: money(o.amount_capturable), currency: cur };
        case 'payment_intent.payment_failed':
            return { ...base, foreign, type: 'payment.failed', orderCode: o.metadata?.orderCode, paymentRef: o.id, amount: money(o.amount), currency: cur, reason: o.last_payment_error?.message || o.last_payment_error?.decline_code };
        case 'payment_intent.canceled':
            return { ...base, foreign, type: 'payment.canceled', orderCode: o.metadata?.orderCode, paymentRef: o.id, amount: money(o.amount), currency: cur };
        case 'charge.refunded':
            return { ...base, foreign, type: 'refund.settled', orderCode: o.metadata?.orderCode, paymentRef: o.payment_intent, amount: money(o.amount_refunded), currency: cur };
        case 'charge.refund.updated':
            return { ...base, type: o.status === 'failed' ? 'refund.failed' : 'ignored', paymentRef: o.payment_intent, amount: money(o.amount), currency: cur, reason: o.failure_reason };
        case 'charge.dispute.created':
            return { ...base, type: 'dispute.opened', paymentRef: o.payment_intent, amount: money(o.amount), currency: cur, reason: o.reason };
        case 'charge.dispute.closed':
            return { ...base, type: 'dispute.closed', paymentRef: o.payment_intent, amount: money(o.amount), currency: cur, reason: o.status };
        case 'checkout.session.completed':
            return o.metadata?.huloPayLink
                ? { ...base, type: 'paylink.completed', orderCode: o.metadata?.orderCode, paymentRef: o.payment_intent, amount: money(o.amount_total), currency: cur }
                : { ...base, type: 'ignored' };
        case 'invoice.paid':
            return { ...base, type: o.billing_reason === 'subscription_create' ? 'subscription.active' : 'subscription.renewed', subscriptionRef: o.subscription, paymentRef: o.payment_intent, amount: money(o.amount_paid), currency: cur,
                subscription: { currentPeriodEnd: o.lines?.data?.[0]?.period?.end ? new Date(o.lines.data[0].period.end * 1000).toISOString() : undefined } };
        case 'invoice.payment_failed':
            return { ...base, type: 'subscription.payment_failed', subscriptionRef: o.subscription, paymentRef: o.payment_intent, amount: money(o.amount_due), currency: cur, reason: o.last_finalization_error?.message };
        case 'customer.subscription.updated':
            return { ...base, type: 'subscription.updated', subscriptionRef: o.id, subscription: { status: o.status, cancelAtPeriodEnd: !!o.cancel_at_period_end, currentPeriodEnd: o.current_period_end ? new Date(o.current_period_end * 1000).toISOString() : undefined } };
        case 'customer.subscription.deleted':
            return { ...base, type: 'subscription.canceled', subscriptionRef: o.id };
        case 'customer.subscription.paused':
            return { ...base, type: 'subscription.paused', subscriptionRef: o.id };
        default:
            return { ...base, type: 'ignored' };
    }
}
