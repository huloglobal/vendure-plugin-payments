import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adyenProvider } from '../providers/adyen';
import { gocardlessProvider } from '../providers/gocardless';
import { coinbaseProvider } from '../providers/coinbase';
import { squareProvider } from '../providers/square';
import { paypalProvider } from '../providers/paypal';
import { mollieProvider } from '../providers/mollie';
import { braintreeProvider } from '../providers/braintree';
import { checkoutComProvider } from '../providers/checkout-com';
import { stripeProvider } from '../providers/stripe';
import { bankTransferProvider } from '../providers/offline';
import { makeHandler } from './handlers';
import { configureRuntime } from './runtime';
import { LedgerService } from './ledger.service';

/**
 * 0.3.3 regression suite: a provider confirmation must be bound to the exact
 * order (reference), amount and currency before a Vendure payment is recorded,
 * and a payment surcharge must match the method actually charged.
 */

const ctx: any = { channelId: 1, channel: { token: 't' } };
/** The order an attacker wants marked paid: £500. */
const big: any = { id: 2, code: 'BIGORDER0002', currencyCode: 'GBP', totalWithTax: 50000, lines: [], surcharges: [] };

type Route = [RegExp, any];
function stubFetch(routes: Route[]) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        const hit = routes.find(([re]) => re.test(url));
        if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ message: `no stub for ${url}` }) };
        const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }));
    return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('session / payment replay is refused', () => {
    it('Adyen: a completed Drop-in session of another order cannot pay this one', async () => {
        stubFetch([[/\/sessions\/CS_SMALL/, { id: 'CS_SMALL', status: 'completed', reference: 'SMALLORDER01', payments: [{ pspReference: 'PSP1', resultCode: 'Authorised', amount: { value: 100, currency: 'GBP' } }] }]]);
        const o = await adyenProvider.confirmPayment(ctx, big, { apiKey: 'k', merchantAccount: 'M' }, { sessionId: 'CS_SMALL', sessionResult: 'res' });
        expect(o.state).toBe('Error');
    });
    it('Adyen: a session of this order that authorised a smaller amount is refused', async () => {
        stubFetch([[/\/sessions\/CS_OLD/, { id: 'CS_OLD', status: 'completed', reference: big.code, payments: [{ pspReference: 'PSP2', resultCode: 'Authorised', amount: { value: 100, currency: 'GBP' } }] }]]);
        const o = await adyenProvider.confirmPayment(ctx, big, { apiKey: 'k', merchantAccount: 'M' }, { sessionId: 'CS_OLD', sessionResult: 'res' });
        expect(o.state).toBe('Error');
    });
    it('Adyen: the matching session still confirms (Authorized, bound to its pspReference)', async () => {
        stubFetch([[/\/sessions\/CS_OK/, { id: 'CS_OK', status: 'completed', reference: big.code, payments: [{ pspReference: 'PSP3', resultCode: 'Authorised', amount: { value: 50000, currency: 'GBP' } }] }]]);
        const o = await adyenProvider.confirmPayment(ctx, big, { apiKey: 'k', merchantAccount: 'M' }, { sessionId: 'CS_OK', sessionResult: 'res' });
        expect(o).toMatchObject({ state: 'Authorized', amount: 50000 });
    });

    it('GoCardless: a billing request for a smaller amount is not authorised at the order total', async () => {
        stubFetch([
            [/\/billing_requests\/BRQ1/, { billing_requests: { id: 'BRQ1', status: 'fulfilled', metadata: { orderCode: big.code }, payment_request: { amount: 100, currency: 'GBP', links: { payment: 'PM1' } } } }],
            [/\/payments\/PM1/, { payments: { id: 'PM1', status: 'pending_submission', amount: 100, currency: 'GBP' } }],
        ]);
        const o = await gocardlessProvider.confirmPayment(ctx, big, { accessToken: 'x' }, { billingRequestId: 'BRQ1' });
        expect(o.state).toBe('Error');
    });
    it('GoCardless: a billing request without our order reference is refused', async () => {
        stubFetch([
            [/\/billing_requests\/BRQ2/, { billing_requests: { id: 'BRQ2', status: 'fulfilled', metadata: {}, payment_request: { amount: 50000, currency: 'GBP', links: { payment: 'PM2' } } } }],
            [/\/payments\/PM2/, { payments: { id: 'PM2', status: 'confirmed', amount: 50000, currency: 'GBP' } }],
        ]);
        const o = await gocardlessProvider.confirmPayment(ctx, big, { accessToken: 'x' }, { billingRequestId: 'BRQ2' });
        expect(o.state).toBe('Error');
    });

    it('Coinbase: a completed charge priced below the order total is refused', async () => {
        stubFetch([[/\/charges\/CHG1/, { data: { code: 'CHG1', metadata: { orderCode: big.code }, pricing: { local: { amount: '1.00', currency: 'GBP' } }, timeline: [{ status: 'NEW' }, { status: 'COMPLETED' }] } }]]);
        const o = await coinbaseProvider.confirmPayment(ctx, big, { apiKey: 'x' }, { chargeCode: 'CHG1' });
        expect(o.state).toBe('Error');
    });
    it('Coinbase: a charge without our order reference is refused', async () => {
        stubFetch([[/\/charges\/CHG2/, { data: { code: 'CHG2', metadata: {}, pricing: { local: { amount: '500.00', currency: 'GBP' } }, timeline: [{ status: 'COMPLETED' }] } }]]);
        const o = await coinbaseProvider.confirmPayment(ctx, big, { apiKey: 'x' }, { chargeCode: 'CHG2' });
        expect(o.state).toBe('Error');
    });

    it('Square: an existing payment of another order cannot be claimed by id', async () => {
        stubFetch([[/\/v2\/payments\/SQ1/, { payment: { id: 'SQ1', status: 'COMPLETED', reference_id: 'OTHERORDER01', amount_money: { amount: 50000, currency: 'GBP' } } }]]);
        const o = await squareProvider.confirmPayment(ctx, big, { accessToken: 'x', locationId: 'L' }, { paymentId: 'SQ1' });
        expect(o.state).toBe('Error');
    });

    it('PayPal: a captured PayPal order without our custom_id is refused', async () => {
        stubFetch([
            [/oauth2\/token/, { access_token: 'tok', expires_in: 3000 }],
            [/\/v2\/checkout\/orders\/PP1/, { id: 'PP1', intent: 'CAPTURE', status: 'COMPLETED', purchase_units: [{ amount: { currency_code: 'GBP', value: '500.00' }, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '500.00' } }] } }] }],
        ]);
        const o = await paypalProvider.confirmPayment(ctx, big, { clientId: 'replay-test', clientSecret: 's' }, { paypalOrderId: 'PP1' });
        expect(o.state).toBe('Error');
    });

    it('Mollie: a paid payment (no metadata) of another order is refused', async () => {
        stubFetch([[/\/payments\/tr_X/, { id: 'tr_X', status: 'paid', description: 'Order OTHERORDER01 — pay link', amount: { currency: 'GBP', value: '500.00' } }]]);
        const o = await mollieProvider.confirmPayment(ctx, big, { apiKey: 'test_x' }, { molliePaymentId: 'tr_X' });
        expect(o.state).toBe('Error');
    });

    it('Braintree: a transaction without our order id cannot be claimed by id', async () => {
        stubFetch([[/braintree-api/, { data: { node: { id: 'T1', status: 'SETTLED', amount: { value: '500.00', currencyCode: 'GBP' }, orderId: null } } }]]);
        const o = await braintreeProvider.confirmPayment(ctx, big, { publicKey: 'p', privateKey: 'k' }, { transactionId: 'T1' });
        expect(o.state).toBe('Error');
    });

    it('Checkout.com: a payment without our reference is refused', async () => {
        stubFetch([[/\/payments\/pay_1/, { id: 'pay_1', status: 'Captured', amount: 50000, currency: 'GBP' }]]);
        const o = await checkoutComProvider.confirmPayment(ctx, big, { secretKey: 'sk' }, { paymentId: 'pay_1' });
        expect(o.state).toBe('Error');
    });

    it('Stripe: a PaymentIntent without our order code is refused', async () => {
        stubFetch([[/\/payment_intents\/pi_renewal/, { id: 'pi_renewal', status: 'succeeded', amount: 50000, amount_received: 50000, currency: 'gbp', metadata: { reference: 'X-R20261101-1-a1', huloRenewal: '1' } }]]);
        const o = await stripeProvider.confirmPayment(ctx, big, { secretKey: 'sk_test_x' }, { paymentIntentId: 'pi_renewal' });
        expect(o.state).toBe('Error');
    });
});

describe('surcharge follows the method actually charged', () => {
    const settings = { surcharges: { 'hulo-bank-transfer': { type: 'fixed', value: 500, label: 'Bank fee' } } };
    let handler: any;
    beforeEach(() => {
        configureRuntime({ hasPremiumAccess: () => true });
        handler = makeHandler(bankTransferProvider);
        const ledgerStub: any = { getSettings: async () => settings, record: async () => 1 };
        handler.init({ get: (t: any) => (t === LedgerService ? ledgerStub : undefined) });
    });
    afterEach(() => configureRuntime({ hasPremiumAccess: () => false }));

    it('refuses a payment when the fee of the chosen method was never applied', async () => {
        const order: any = { id: 3, code: 'NOFEEORDER03', currencyCode: 'GBP', totalWithTax: 10000, surcharges: [] };
        const r = await handler.createPayment(ctx, order, 10000, [], {}, { code: 'bank' });
        expect(r.state).toBe('Error');
    });
    it('refuses a payment carrying another method\'s (smaller) fee', async () => {
        const order: any = { id: 4, code: 'WRONGFEE0004', currencyCode: 'GBP', totalWithTax: 10000, surcharges: [{ id: 9, sku: 'hulo-surcharge:paylater', priceWithTax: 0 }] };
        const r = await handler.createPayment(ctx, order, 10000, [], {}, { code: 'bank' });
        expect(r.state).toBe('Error');
    });
    it('accepts the payment when the fee for this method is on the order', async () => {
        const order: any = { id: 5, code: 'RIGHTFEE0005', currencyCode: 'GBP', totalWithTax: 10500, surcharges: [{ id: 9, sku: 'hulo-surcharge:bank', priceWithTax: 500 }] };
        const r = await handler.createPayment(ctx, order, 10500, [], {}, { code: 'bank' });
        expect(r.state).toBe('Authorized');
    });
});
