import { createHmac } from 'crypto';
import { Order, RequestContext } from '@vendure/core';
import {
    ClientSession, NormalisedEvent, PaymentOutcome, PaymentProvider, PayLinkInput, PayLinkOutcome, ProviderArgs, SessionOptions,
    SubscriptionCreateInput, SubscriptionOutcome, WebhookVerification,
} from '../core/provider';
import { idem, request, safeEqual } from '../core/rest';
import type { CredentialCheck, WebhookSetup } from '../core/provider';
import { fromProviderMinor, toProviderMinor } from '../core/money';

export const ADYEN_CODE = 'hulo-adyen' as const;
const VERSION = 'v71';

function baseUrl(args: ProviderArgs): string {
    if (String(args.environment) === 'live') {
        const prefix = String(args.liveUrlPrefix || '').trim();
        if (!prefix) throw new Error('Adyen live needs liveUrlPrefix (Customer Area → Developers → API URLs)');
        return `https://${prefix}-checkout-live.adyenpayments.com/checkout/${VERSION}`;
    }
    return `https://checkout-test.adyen.com/${VERSION}`;
}

async function adyen<T = any>(args: ProviderArgs, path: string, opts: { method?: 'GET' | 'POST' | 'PATCH'; json?: any; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { 'x-api-key': String(args.apiKey || '') };
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    return request<T>('Adyen', `${baseUrl(args)}${path}`, { method: opts.method || (opts.json ? 'POST' : 'GET'), headers, json: opts.json });
}

function intervalMs(interval: string, count: number): number {
    const unit: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    return (unit[interval] || 30) * Math.max(1, count) * 86400_000;
}

/**
 * Adyen through the Checkout API (Sessions + Drop-in): cards, Apple Pay,
 * Google Pay, iDEAL, Klarna, PayPal-via-Adyen and 100+ local methods with
 * one integration. Captures, cancels, refunds, tokenised recurring (the
 * plugin's scheduler bills stored payment details), Pay by Link, HMAC-signed
 * webhooks. Amounts and the authorisation itself are confirmed by webhook,
 * which is Adyen's source of truth.
 */
export const adyenProvider: PaymentProvider = {
    code: ADYEN_CODE,
    name: 'Adyen',
    freeTier: false,
    capabilities: {
        session: true, manualCapture: true, partialCapture: true, refund: true, partialRefund: true,
        savedMethods: true, subscriptions: true, payByLink: true, disputes: true,
        wallets: ['apple_pay', 'google_pay', 'paypal', 'ideal', 'klarna', 'bancontact', 'twint'],
    },

    publicConfig(args) {
        return { clientKey: args.clientKey, environment: String(args.environment) === 'live' ? 'live' : 'test' };
    },

    connectFields: ['environment', 'apiKey', 'merchantAccount', 'clientKey', 'liveUrlPrefix', 'captureMode'],

    dashboardLinks(args) {
        const live = String(args?.environment) === 'live';
        const base = live ? 'https://ca-live.adyen.com/ca/ca' : 'https://ca-test.adyen.com/ca/ca';
        return { dashboard: base, keys: `${base}/config/api_credentials_new.shtml`, webhooks: `${base}/config/showthirdparty.shtml`, docs: 'https://docs.adyen.com/development-resources/api-credentials/' };
    },

    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.apiKey || !args.merchantAccount) return { ok: false, message: 'API key and merchant account are both required.' };
        if (String(args.environment) === 'live' && !args.liveUrlPrefix) return { ok: false, message: 'Live needs the live URL prefix from Developers → API URLs.' };
        try {
            const r = await adyen(args, '/paymentMethods', { json: { merchantAccount: args.merchantAccount, channel: 'Web', amount: { value: 1000, currency: 'GBP' }, countryCode: 'GB' } });
            const n = (r.paymentMethods || []).length;
            return { ok: true, message: `Connected to merchant account ${args.merchantAccount} (${args.environment || 'test'}) — ${n} payment method${n === 1 ? '' : 's'} enabled.${args.clientKey ? '' : ' Add the client key so Drop-in can render.'}`, account: String(args.merchantAccount), environment: String(args.environment || 'test') };
        } catch (e: any) {
            return { ok: false, message: e.status === 401 ? 'Adyen rejected the API key.' : e.status === 403 ? 'The API credential is not allowed to use this merchant account.' : e.message };
        }
    },

    /** Uses the Management API (needs the "Management API — Webhooks read and write" role on the credential). */
    async ensureWebhook(args, url): Promise<WebhookSetup> {
        const mgmt = String(args.environment) === 'live' ? 'https://management-live.adyen.com/v3' : 'https://management-test.adyen.com/v3';
        const headers = { 'x-api-key': String(args.apiKey || '') };
        const manual = `Create a Standard webhook in the Customer Area pointing at ${url}, generate its HMAC key and paste it into the payment method.`;
        try {
            const list = await request('Adyen', `${mgmt}/merchants/${encodeURIComponent(args.merchantAccount)}/webhooks?pageSize=100`, { headers });
            let hook = (list.data || []).find((w: any) => w.url === url);
            if (!hook) {
                hook = await request('Adyen', `${mgmt}/merchants/${encodeURIComponent(args.merchantAccount)}/webhooks`, { headers, json: { type: 'standard', url, active: true, communicationFormat: 'json', description: 'HULO Payments for Vendure', sslVersion: 'TLSv1.3', additionalSettings: { includeEventCodes: [], properties: { recurringDetailReference: true, shopperReference: true } } } });
            } else if (args.hmacKey) {
                return { args: {}, ref: hook.id, note: 'Existing webhook kept.' };
            }
            const hmac = await request('Adyen', `${mgmt}/merchants/${encodeURIComponent(args.merchantAccount)}/webhooks/${hook.id}/generateHmac`, { headers, json: {} });
            return { args: { hmacKey: hmac.hmacKey }, ref: hook.id };
        } catch (e: any) {
            return { args: {}, note: `${e.status === 401 || e.status === 403 ? 'The API credential lacks the Management API webhook role, so the webhook was not created automatically.' : e.message} ${manual}` };
        }
    },

    async createSession(ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const shopperReference = order.customer?.id ? `cust-${order.customer.id}` : `guest-${order.code}`;
        const recurring = !!(opts.subscription || opts.savePaymentMethod);
        const json: any = {
            amount: { value: toProviderMinor(order.totalWithTax, order.currencyCode), currency: order.currencyCode },
            reference: order.code,
            merchantAccount: args.merchantAccount,
            returnUrl: opts.returnUrl || `${ctx.channel?.customFields ? '' : ''}https://example.com/return?order=${order.code}`,
            countryCode: opts.countryCode || order.shippingAddress?.countryCode || order.billingAddress?.countryCode || 'GB',
            shopperLocale: opts.locale || 'en-GB',
            shopperEmail: order.customer?.emailAddress || undefined,
            shopperReference,
            channel: 'Web',
            metadata: { orderCode: order.code, channelToken: ctx.channel?.token || '' },
            captureDelayHours: args.captureMode === 'manual' ? -1 : undefined,
            storePaymentMethod: recurring || undefined,
            recurringProcessingModel: recurring ? 'Subscription' : undefined,
            shopperInteraction: 'Ecommerce',
            lineItems: (order.lines || []).slice(0, 50).map(l => ({
                id: String(l.id), description: l.productVariant?.name?.slice(0, 120), quantity: l.quantity,
                amountIncludingTax: toProviderMinor(l.proratedUnitPriceWithTax ?? l.unitPriceWithTax, order.currencyCode),
            })),
        };
        const s = await adyen(args, '/sessions', { json, idempotencyKey: idem('hulo-ady-session', order.code, json.amount.value, order.currencyCode, recurring ? 'r' : '') });
        return {
            provider: ADYEN_CODE, flow: 'adyen-dropin', sessionId: s.id, sessionData: s.sessionData, publicKey: args.clientKey,
            environment: this.publicConfig(args).environment, amount: order.totalWithTax, currency: order.currencyCode,
            expiresAt: s.expiresAt, config: { countryCode: json.countryCode, locale: json.shopperLocale, shopperReference },
        };
    },

    /** Drop-in hands back `sessionId` + `sessionResult`; the session status is verified with Adyen. */
    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const sessionId = String(metadata?.sessionId || '');
        const sessionResult = String(metadata?.sessionResult || '');
        if (!sessionId || !sessionResult) return { state: 'Error', amount: 0, errorMessage: 'Missing sessionId / sessionResult from Adyen Drop-in' };
        const s = await adyen(args, `/sessions/${encodeURIComponent(sessionId)}?sessionResult=${encodeURIComponent(sessionResult)}`);
        const status = String(s.status || '');
        const meta = { sessionId, sessionStatus: status, captureMode: args.captureMode === 'manual' ? 'manual' : 'immediate', public: { method: metadata?.paymentMethodType || 'adyen' } };
        if (status === 'completed') {
            // pspReference + amount arrive on the AUTHORISATION webhook; until
            // then the payment is Authorized against the session.
            return { state: 'Authorized', amount: order.totalWithTax, transactionId: metadata?.pspReference ? String(metadata.pspReference) : `adyen-session:${sessionId}`, metadata: meta };
        }
        if (status === 'paymentPending') return { state: 'Authorized', amount: order.totalWithTax, transactionId: `adyen-session:${sessionId}`, metadata: { ...meta, pending: true } };
        return { state: 'Declined', amount: 0, transactionId: `adyen-session:${sessionId}`, errorMessage: `Adyen session ${status || 'unknown'}`, metadata: meta };
    },

    async capture(args, paymentRef, amount, currency) {
        if (paymentRef.startsWith('adyen-session:')) return { success: false, errorMessage: 'Waiting for the Adyen AUTHORISATION webhook before capture' };
        try {
            await adyen(args, `/payments/${encodeURIComponent(paymentRef)}/captures`, { json: { amount: { value: toProviderMinor(amount, currency), currency }, merchantAccount: args.merchantAccount, reference: `cap-${paymentRef}` }, idempotencyKey: idem('hulo-ady-cap', paymentRef, amount) });
            return { success: true };
        } catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async cancel(args, paymentRef) {
        if (paymentRef.startsWith('adyen-session:')) return { success: true };
        try { await adyen(args, `/payments/${encodeURIComponent(paymentRef)}/cancels`, { json: { merchantAccount: args.merchantAccount, reference: `cancel-${paymentRef}` } }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },

    async refund(args, paymentRef, amount, currency, reason) {
        const r = await adyen(args, `/payments/${encodeURIComponent(paymentRef)}/refunds`, {
            json: { amount: { value: toProviderMinor(amount, currency), currency }, merchantAccount: args.merchantAccount, reference: `refund-${paymentRef}-${Date.now().toString(36)}`, merchantRefundReason: reason ? String(reason).slice(0, 80) : undefined },
            idempotencyKey: idem('hulo-ady-ref', paymentRef, amount, Date.now().toString(36).slice(0, 6)),
        });
        // Adyen refunds are asynchronous: the REFUND webhook confirms them.
        return { state: 'Pending', transactionId: r.pspReference, metadata: { pspReference: r.pspReference, status: r.status } };
    },

    async verifyWebhook(args, rawBody, headers): Promise<WebhookVerification> {
        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        let payload: any;
        try { payload = JSON.parse(body); } catch { return { ok: false, events: [], error: 'invalid JSON' }; }
        if (args.webhookUser && args.webhookPassword) {
            const auth = String(headers.authorization || '');
            const expected = `Basic ${Buffer.from(`${args.webhookUser}:${args.webhookPassword}`).toString('base64')}`;
            if (!safeEqual(auth, expected)) return { ok: false, events: [], error: 'basic auth mismatch' };
        }
        const items: any[] = (payload.notificationItems || []).map((n: any) => n.NotificationRequestItem).filter(Boolean);
        if (!args.hmacKey) return { ok: false, events: [], error: 'hmacKey not configured on the payment method' };
        const events: NormalisedEvent[] = [];
        for (const it of items) {
            if (!verifyHmac(String(args.hmacKey), it)) return { ok: false, events: [], error: 'HMAC mismatch' };
            events.push(normaliseAdyenItem(it));
        }
        return { ok: true, events, reply: '[accepted]' };
    },

    async listSavedMethods(args, customerRef) {
        const r = await adyen(args, '/paymentMethods', { json: { merchantAccount: args.merchantAccount, shopperReference: customerRef, channel: 'Web' } });
        return (r.storedPaymentMethods || []).map((m: any) => ({ id: m.id, type: m.type, brand: m.brand, last4: m.lastFour, expiry: m.expiryMonth ? `${String(m.expiryMonth).padStart(2, '0')}/${String(m.expiryYear).slice(-2)}` : undefined, provider: ADYEN_CODE }));
    },

    async removeSavedMethod(args, customerRef, methodId) {
        await request('Adyen', `${baseUrl(args).replace(/\/checkout\/v\d+$|\/v\d+$/, '')}/${VERSION}/storedPaymentMethods/${encodeURIComponent(methodId)}?merchantAccount=${encodeURIComponent(args.merchantAccount)}&shopperReference=${encodeURIComponent(customerRef)}`, { method: 'DELETE', headers: { 'x-api-key': String(args.apiKey || '') } }).catch(() => undefined);
        return true;
    },

    /** Adyen has no plan objects: renewals are charged by the plugin's scheduler. */
    async createSubscription(_args, input: SubscriptionCreateInput): Promise<SubscriptionOutcome> {
        const first = Date.now() + (input.trialDays > 0 ? input.trialDays * 86400_000 : intervalMs(input.interval, input.intervalCount));
        return {
            providerSubscriptionRef: `hulo-sched:${input.orderCode}:${input.variantId}`,
            status: input.providerPaymentRef ? 'active' : 'pending',
            currentPeriodEnd: new Date(first).toISOString(),
            providerCustomerRef: input.providerCustomerRef, providerPaymentRef: input.providerPaymentRef,
            selfScheduled: true,
        };
    },

    async cancelSubscription(_args, _ref, atPeriodEnd) { return { status: atPeriodEnd ? 'active' : 'canceled' }; },
    async pauseSubscription(_args, _ref, resume) { return { status: resume ? 'active' : 'paused' }; },

    async chargeStored(args, input): Promise<PaymentOutcome> {
        try {
            const r = await adyen(args, '/payments', {
                json: {
                    amount: { value: toProviderMinor(input.amount, input.currency), currency: input.currency },
                    reference: input.reference, merchantAccount: args.merchantAccount,
                    paymentMethod: { type: 'scheme', storedPaymentMethodId: input.paymentRef },
                    shopperReference: input.customerRef, shopperInteraction: 'ContAuth', recurringProcessingModel: 'Subscription',
                    returnUrl: 'https://example.com/renewal',
                },
                idempotencyKey: idem('hulo-ady-renew', input.reference),
            });
            return r.resultCode === 'Authorised'
                ? { state: 'Settled', amount: input.amount, transactionId: r.pspReference }
                : { state: 'Declined', amount: 0, transactionId: r.pspReference, errorMessage: r.refusalReason || r.resultCode };
        } catch (e: any) { return { state: 'Declined', amount: 0, errorMessage: e.message }; }
    },

    async createPayLink(args, input: PayLinkInput): Promise<PayLinkOutcome> {
        const r = await adyen(args, '/paymentLinks', {
            json: {
                amount: { value: toProviderMinor(input.amount, input.currency), currency: input.currency },
                reference: input.orderCode, merchantAccount: args.merchantAccount, description: input.description.slice(0, 200),
                shopperEmail: input.customerEmail || undefined, returnUrl: input.returnUrl || undefined,
                expiresAt: input.expiresAt || undefined, metadata: { orderCode: input.orderCode },
            },
            idempotencyKey: idem('hulo-ady-link', input.orderCode, input.amount, Date.now().toString(36).slice(0, 5)),
        });
        return { url: r.url, ref: r.id, expiresAt: r.expiresAt };
    },
};

export function adyenSigningString(it: any): string {
    return [it.pspReference, it.originalReference, it.merchantAccountCode, it.merchantReference, it.amount?.value, it.amount?.currency, it.eventCode, it.success]
        .map(v => (v === undefined || v === null ? '' : String(v))).join(':');
}

export function verifyHmac(hmacKeyHex: string, it: any): boolean {
    const provided = String(it?.additionalData?.hmacSignature || '');
    if (!provided) return false;
    const expected = createHmac('sha256', Buffer.from(hmacKeyHex, 'hex')).update(adyenSigningString(it), 'utf8').digest('base64');
    return safeEqual(expected, provided);
}

export function normaliseAdyenItem(it: any): NormalisedEvent {
    const cur = it.amount?.currency ? String(it.amount.currency).toUpperCase() : undefined;
    const amount = cur && it.amount?.value != null ? fromProviderMinor(Number(it.amount.value), cur) : undefined;
    const ok = String(it.success) === 'true';
    const base = { id: `${it.eventCode}:${it.pspReference}:${it.success}`, orderCode: it.merchantReference, paymentRef: it.pspReference, amount, currency: cur, raw: it, reason: it.reason || undefined };
    const token = it.additionalData?.['recurring.recurringDetailReference'] || it.additionalData?.storedPaymentMethodId;
    switch (it.eventCode) {
        case 'AUTHORISATION':
            return { ...base, type: ok ? 'payment.authorized' : 'payment.failed', subscription: token ? { paymentRef: token, customerRef: it.additionalData?.['recurring.shopperReference'] || it.additionalData?.shopperReference } : undefined };
        case 'CAPTURE': return { ...base, type: ok ? 'payment.settled' : 'payment.failed', paymentRef: it.originalReference || it.pspReference };
        case 'CAPTURE_FAILED': return { ...base, type: 'payment.failed', paymentRef: it.originalReference || it.pspReference };
        case 'CANCELLATION': return { ...base, type: ok ? 'payment.canceled' : 'ignored', paymentRef: it.originalReference || it.pspReference };
        case 'REFUND': return { ...base, type: ok ? 'refund.settled' : 'refund.failed', paymentRef: it.originalReference || it.pspReference };
        case 'REFUND_FAILED': case 'REFUNDED_REVERSED': return { ...base, type: 'refund.failed', paymentRef: it.originalReference || it.pspReference };
        case 'CHARGEBACK': case 'NOTIFICATION_OF_CHARGEBACK': case 'REQUEST_FOR_INFORMATION': case 'SECOND_CHARGEBACK':
            return { ...base, type: 'dispute.opened', paymentRef: it.originalReference || it.pspReference };
        case 'CHARGEBACK_REVERSED': return { ...base, type: 'dispute.closed', paymentRef: it.originalReference || it.pspReference, reason: 'reversed' };
        case 'RECURRING_CONTRACT':
            return { ...base, type: 'subscription.updated', subscription: { paymentRef: token, customerRef: it.additionalData?.['recurring.shopperReference'] || it.additionalData?.shopperReference } };
        default: return { ...base, type: 'ignored' };
    }
}
