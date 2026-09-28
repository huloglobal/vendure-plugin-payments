import { afterEach, describe, expect, it, vi } from 'vitest';
import { adyenLineItems, adyenProvider, normaliseAdyenItem } from '../providers/adyen';
import { normaliseStripeEvent } from '../providers/stripe';
import { mollieProvider } from '../providers/mollie';
import { makeHandler, markSettledByWebhook, registerWebhookPayment, takeWebhookPayment } from './handlers';
import { configureRuntime } from './runtime';
import { renderHostedPage } from './hosted-page';
import { hostedCsp, hostedCspMode } from './hosted.controller';

const ctx: any = { channelId: 1 };
const order: any = { id: 9, code: 'ORDER9', totalWithTax: 2500, currencyCode: 'GBP', lines: [] };
const adyenArgs = [{ name: 'captureMode', value: 'immediate' }] as any;

describe('Adyen pay-by-link confirmation', () => {
    afterEach(() => configureRuntime({ hasPremiumAccess: () => false }));

    it('confirms from registered webhook facts and refuses a client-supplied pspReference', async () => {
        configureRuntime({ hasPremiumAccess: () => true });
        const h = makeHandler(adyenProvider);
        // A storefront sending pspReference through addPaymentToOrder: nothing was registered → not trusted.
        const forged: any = await h.createPayment(ctx, order, 2500, adyenArgs, { pspReference: 'PSP1' }, {} as any);
        expect(forged.state).toBe('Error');
        expect(forged.errorMessage).toMatch(/Missing sessionId/);
        // The webhook path registered the facts a moment ago.
        registerWebhookPayment('ORDER9', { paymentRef: 'PSP1', type: 'payment.settled', amount: 2500, currency: 'GBP' });
        const ok: any = await h.createPayment(ctx, order, 2500, adyenArgs, { pspReference: 'PSP1', webhook: { type: 'forged' } }, {} as any);
        expect(ok).toMatchObject({ state: 'Settled', amount: 2500, transactionId: 'PSP1' });
        expect(ok.metadata.viaWebhook).toBe('payment.settled');
        // Registration is single-use.
        expect(takeWebhookPayment('ORDER9', 'PSP1')).toBeNull();
    });

    it('authorises on AUTHORISATION and rejects a notification whose amount differs from the order', async () => {
        const auth = await adyenProvider.confirmPayment(ctx, order, { captureMode: 'manual' }, { pspReference: 'PSP2', webhook: { paymentRef: 'PSP2', type: 'payment.authorized', amount: 2500, currency: 'GBP' } });
        expect(auth).toMatchObject({ state: 'Authorized', transactionId: 'PSP2', metadata: { captureMode: 'manual' } });
        const bad = await adyenProvider.confirmPayment(ctx, order, {}, { pspReference: 'PSP3', webhook: { paymentRef: 'PSP3', type: 'payment.settled', amount: 2400, currency: 'GBP' } });
        expect(bad.state).toBe('Error');
        expect(bad.errorMessage).toMatch(/Amount mismatch/);
    });

    it('registrations expire after 60 s', () => {
        vi.useFakeTimers();
        registerWebhookPayment('ORDER9', { paymentRef: 'OLD', type: 'payment.settled' });
        vi.advanceTimersByTime(61_000);
        expect(takeWebhookPayment('ORDER9', 'OLD')).toBeNull();
        vi.useRealTimers();
    });
});

describe('settle-by-webhook mark', () => {
    const payment: any = { id: 77, transactionId: 'PSP77', amount: 2500, metadata: {} };
    it('is trusted once, then the handler asks the provider again', async () => {
        const h = makeHandler(adyenProvider);
        markSettledByWebhook(77);
        expect(await h.settlePayment(ctx, order, payment, adyenArgs, {} as any)).toEqual({ success: true });
        const again: any = await h.settlePayment(ctx, order, payment, adyenArgs, {} as any);
        expect(again.success).toBe(false); // no session to re-probe → provider says no
    });
    it('expires after 60 s', async () => {
        vi.useFakeTimers();
        const h = makeHandler(adyenProvider);
        markSettledByWebhook(78);
        vi.advanceTimersByTime(61_000);
        const r: any = await h.settlePayment(ctx, order, { ...payment, id: 78 }, adyenArgs, {} as any);
        expect(r.success).toBe(false);
        vi.useRealTimers();
    });
});

describe('renewal webhooks are not a second capture', () => {
    it('Stripe intents stamped huloRenewal are ignored', () => {
        const ev = normaliseStripeEvent({ id: 'evt', type: 'payment_intent.succeeded', data: { object: { id: 'pi_r', currency: 'gbp', amount_received: 999, metadata: { reference: 'ORD-R20260928-5-a0', huloRenewal: '1' } } } });
        expect(ev.type).toBe('ignored');
        expect(normaliseStripeEvent({ id: 'evt', type: 'payment_intent.succeeded', data: { object: { id: 'pi_n', currency: 'gbp', amount_received: 999, metadata: { orderCode: 'ORD', vendureOrderId: '1' } } } }).type).toBe('payment.settled');
    });
    it('Adyen notifications for a scheduler reference are ignored, other references flow', () => {
        const item = (merchantReference: string, eventCode = 'AUTHORISATION') => normaliseAdyenItem({ eventCode, success: 'true', pspReference: 'P', merchantReference, amount: { value: 999, currency: 'GBP' } });
        expect(item('ORDER9-R20260928-5-a0').type).toBe('ignored');
        expect(item('ORDER9-R20260928-5-a1', 'CAPTURE').type).toBe('ignored');
        expect(item('ORDER9').type).toBe('payment.authorized');
        expect(item('ORDER9', 'CAPTURE').type).toBe('payment.settled');
    });
});

describe('refund events name the specific refund', () => {
    it('Stripe: the newest succeeded refund of a charge, or the refund object itself', () => {
        const charge = normaliseStripeEvent({ id: 'e', type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', currency: 'gbp', amount_refunded: 1500, metadata: { orderCode: 'O1' }, refunds: { data: [{ id: 're_old', amount: 500, status: 'succeeded', created: 10 }, { id: 're_new', amount: 1000, status: 'succeeded', created: 20 }] } } } });
        expect(charge).toMatchObject({ type: 'refund.settled', paymentRef: 'pi_1', refundRef: 're_new', refundAmount: 1000, amount: 1000 });
        const bare = normaliseStripeEvent({ id: 'e', type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', currency: 'gbp', amount_refunded: 1500 } } });
        expect(bare).toMatchObject({ type: 'refund.settled', amount: 1500 });
        expect(bare.refundRef).toBeUndefined();
        expect(normaliseStripeEvent({ id: 'e', type: 'refund.updated', data: { object: { id: 're_x', payment_intent: 'pi_1', currency: 'gbp', amount: 700, status: 'succeeded' } } })).toMatchObject({ type: 'refund.settled', refundRef: 're_x', refundAmount: 700 });
        expect(normaliseStripeEvent({ id: 'e', type: 'charge.refund.updated', data: { object: { id: 're_y', payment_intent: 'pi_1', currency: 'gbp', amount: 700, status: 'failed', failure_reason: 'expired_or_canceled_card' } } })).toMatchObject({ type: 'refund.failed', refundRef: 're_y', reason: 'expired_or_canceled_card' });
        expect(normaliseStripeEvent({ id: 'e', type: 'refund.updated', data: { object: { id: 're_z', payment_intent: 'pi_1', currency: 'gbp', amount: 700, status: 'pending' } } }).type).toBe('ignored');
    });
    it('Adyen: the REFUND pspReference is the refund id, originalReference the payment', () => {
        expect(normaliseAdyenItem({ eventCode: 'REFUND', success: 'true', pspReference: 'R1', originalReference: 'P1', merchantReference: 'O1', amount: { value: 300, currency: 'EUR' } })).toMatchObject({ type: 'refund.settled', paymentRef: 'P1', refundRef: 'R1', refundAmount: 300 });
    });
});

describe('Adyen session line items', () => {
    const o: any = { currencyCode: 'GBP', totalWithTax: 2640, lines: [{ id: 1, quantity: 2, unitPriceWithTax: 1000, productVariant: { name: 'Widget' } }, { id: 2, quantity: 1, unitPriceWithTax: 250, productVariant: { name: 'Gadget' } }] };
    it('adds a closing line for shipping, surcharges and rounding so lines sum to the amount', () => {
        const lines = adyenLineItems(o);
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatchObject({ id: 'shipping-fees', description: 'Shipping & fees', quantity: 1, amountIncludingTax: 390 });
        expect(lines.reduce((n, l) => n + l.amountIncludingTax * l.quantity, 0)).toBe(2640);
    });
    it('adds nothing when the lines already match', () => {
        expect(adyenLineItems({ ...o, totalWithTax: 2250 })).toHaveLength(2);
    });
});

describe('Mollie cancelSubscription', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('uses the stored customer reference instead of listing every subscription', async () => {
        const calls: Array<{ url: string; method: string }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, method: init?.method }); return { ok: true, status: 200, text: async () => '{}' }; }));
        expect(await mollieProvider.cancelSubscription!({ apiKey: 'test_x' }, 'sub_1', false, 'cst_abc')).toEqual({ status: 'canceled' });
        expect(calls).toEqual([{ url: 'https://api.mollie.com/v2/customers/cst_abc/subscriptions/sub_1', method: 'DELETE' }]);
    });
    it('falls back to the listing when no customer is known', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ _embedded: { subscriptions: [{ id: 'sub_1', customerId: 'cst_found' }] } }) }; }));
        await mollieProvider.cancelSubscription!({ apiKey: 'test_x' }, 'sub_1', false);
        expect(calls[0]).toContain('/subscriptions?limit=250');
        expect(calls[1]).toBe('https://api.mollie.com/v2/customers/cst_found/subscriptions/sub_1');
    });
});

describe('hosted page CSP', () => {
    it('lists every provider client host, the nonce and the report endpoint', () => {
        const csp = hostedCsp('abc123');
        expect(csp).toContain("script-src 'nonce-abc123' https://js.stripe.com");
        for (const host of ['https://hooks.stripe.com', 'https://api.stripe.com', 'https://cdn.jsdelivr.net', 'https://*.adyen.com', 'https://www.paypal.com', 'https://*.paypal.com', 'https://web.squarecdn.com', 'https://sandbox.web.squarecdn.com', 'https://*.squareup.com', 'https://js.braintreegateway.com', 'https://*.braintree-api.com', 'https://*.braintreegateway.com']) expect(csp).toContain(host);
        expect(csp).toMatch(/img-src \* data:/);
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).toContain("frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        expect(csp).toContain('report-uri /hulo-payments/csp-report');
        expect(csp).not.toContain("'unsafe-eval'");
        expect(hostedCspMode()).toBe('report-only');
    });
    it('puts the nonce on the inline script and ignores a malformed one', () => {
        const model: any = { token: 'a'.repeat(48), orderCode: 'O', amount: 1, currency: 'GBP', locale: 'en-GB', customerEmail: '', brand: 'B', accent: '#000', logoUrl: '', cancelUrl: '', providers: [], returned: false, lines: [] };
        expect(renderHostedPage(model, 'n0nce+/=')).toContain('<script nonce="n0nce+/=">');
        expect(renderHostedPage(model, 'bad"nonce')).toContain('<script>');
        expect(renderHostedPage(model)).toContain('<script>');
    });
});
