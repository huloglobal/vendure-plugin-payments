import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { amountsMatch, currencyExponent, fromDecimalString, fromProviderMinor, toDecimalString, toProviderMinor } from './money';
import { encodeForm, idem, safeEqual } from './rest';
import { normaliseStripeEvent, stripeProvider } from '../providers/stripe';
import { adyenSigningString, normaliseAdyenItem, verifyHmac } from '../providers/adyen';
import { normalisePayPalEvent } from '../providers/paypal';
import { huloPaymentRulesChecker } from './eligibility';

describe('money', () => {
    it('keeps two-decimal currencies as-is and rescales zero/three-decimal ones', () => {
        expect(toProviderMinor(1999, 'GBP')).toBe(1999);
        expect(toProviderMinor(150000, 'JPY')).toBe(1500);
        expect(fromProviderMinor(1500, 'JPY')).toBe(150000);
        expect(toProviderMinor(12345, 'KWD')).toBe(123450);
        expect(fromProviderMinor(123450, 'KWD')).toBe(12345);
        expect(currencyExponent('eur')).toBe(2);
    });
    it('formats decimal strings for PayPal / Mollie and back', () => {
        expect(toDecimalString(1250, 'EUR')).toBe('12.50');
        expect(toDecimalString(150000, 'JPY')).toBe('1500');
        expect(fromDecimalString('12.50', 'EUR')).toBe(1250);
        expect(fromDecimalString('0.10', 'GBP')).toBe(10);
        expect(amountsMatch(1000, 1000)).toBe(true);
        expect(amountsMatch(1000, 1001)).toBe(false);
    });
});

describe('rest helpers', () => {
    it('form-encodes nested objects the Stripe way', () => {
        expect(encodeForm({ amount: 100, metadata: { orderCode: 'ABC' }, items: [{ price: 'p_1', quantity: 2 }], skip: undefined }))
            .toBe('amount=100&metadata%5BorderCode%5D=ABC&items%5B0%5D%5Bprice%5D=p_1&items%5B0%5D%5Bquantity%5D=2');
    });
    it('compares strings in constant time and builds idempotency keys', () => {
        expect(safeEqual('abc', 'abc')).toBe(true);
        expect(safeEqual('abc', 'abd')).toBe(false);
        expect(safeEqual('abc', 'ab')).toBe(false);
        expect(idem('a', undefined, 1, '', 'b')).toBe('a:1:b');
    });
});

describe('Stripe', () => {
    it('verifies webhook signatures and rejects tampered bodies', async () => {
        const secret = 'whsec_test';
        const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 1000, amount_received: 1000, currency: 'gbp', metadata: { orderCode: 'ORDER1' } } } });
        const t = Math.floor(Date.now() / 1000);
        const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
        const ok = await stripeProvider.verifyWebhook({ webhookSecret: secret }, body, { 'stripe-signature': `t=${t},v1=${v1}` }, {});
        expect(ok.ok).toBe(true);
        expect(ok.events[0]).toMatchObject({ type: 'payment.settled', orderCode: 'ORDER1', paymentRef: 'pi_1', amount: 1000, currency: 'GBP' });
        const bad = await stripeProvider.verifyWebhook({ webhookSecret: secret }, body + ' ', { 'stripe-signature': `t=${t},v1=${v1}` }, {});
        expect(bad.ok).toBe(false);
        const stale = await stripeProvider.verifyWebhook({ webhookSecret: secret }, body, { 'stripe-signature': `t=${t - 900},v1=${createHmac('sha256', secret).update(`${t - 900}.${body}`).digest('hex')}` }, {});
        expect(stale.ok).toBe(false);
    });
    it('normalises the events the plugin cares about', () => {
        expect(normaliseStripeEvent({ id: 'e', type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_9', amount: 500, currency: 'eur', reason: 'fraudulent' } } })).toMatchObject({ type: 'dispute.opened', paymentRef: 'pi_9', amount: 500, currency: 'EUR', reason: 'fraudulent' });
        expect(normaliseStripeEvent({ id: 'e', type: 'invoice.paid', data: { object: { subscription: 'sub_1', billing_reason: 'subscription_cycle', amount_paid: 999, currency: 'gbp', lines: { data: [{ period: { end: 1800000000 } }] } } } })).toMatchObject({ type: 'subscription.renewed', subscriptionRef: 'sub_1', amount: 999 });
        expect(normaliseStripeEvent({ id: 'e', type: 'checkout.session.completed', data: { object: { metadata: { huloPayLink: '1', orderCode: 'X1' }, payment_intent: 'pi_2', amount_total: 100, currency: 'gbp' } } })).toMatchObject({ type: 'paylink.completed', orderCode: 'X1', paymentRef: 'pi_2' });
        expect(normaliseStripeEvent({ id: 'e', type: 'something.else', data: { object: {} } }).type).toBe('ignored');
    });
});

describe('Adyen', () => {
    it('validates HMAC signatures over the documented field order', () => {
        const key = '44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056';
        const item: any = { pspReference: 'P1', originalReference: '', merchantAccountCode: 'Acc', merchantReference: 'ORDER1', amount: { value: 1000, currency: 'GBP' }, eventCode: 'AUTHORISATION', success: 'true', additionalData: {} };
        expect(adyenSigningString(item)).toBe('P1::Acc:ORDER1:1000:GBP:AUTHORISATION:true');
        item.additionalData.hmacSignature = createHmac('sha256', Buffer.from(key, 'hex')).update(adyenSigningString(item)).digest('base64');
        expect(verifyHmac(key, item)).toBe(true);
        item.amount.value = 1001;
        expect(verifyHmac(key, item)).toBe(false);
    });
    it('normalises notification items', () => {
        expect(normaliseAdyenItem({ eventCode: 'AUTHORISATION', success: 'true', pspReference: 'P1', merchantReference: 'O1', amount: { value: 1000, currency: 'EUR' }, additionalData: { 'recurring.recurringDetailReference': 'TOKEN', 'recurring.shopperReference': 'cust-1' } }))
            .toMatchObject({ type: 'payment.authorized', orderCode: 'O1', paymentRef: 'P1', amount: 1000, subscription: { paymentRef: 'TOKEN', customerRef: 'cust-1' } });
        expect(normaliseAdyenItem({ eventCode: 'REFUND', success: 'false', pspReference: 'R1', originalReference: 'P1', merchantReference: 'O1', amount: { value: 100, currency: 'EUR' }, reason: 'insufficient' })).toMatchObject({ type: 'refund.failed', paymentRef: 'P1', reason: 'insufficient' });
        expect(normaliseAdyenItem({ eventCode: 'CHARGEBACK', success: 'true', pspReference: 'C1', originalReference: 'P1', merchantReference: 'O1', amount: { value: 1000, currency: 'EUR' } }).type).toBe('dispute.opened');
    });
});

describe('PayPal', () => {
    it('normalises capture, dispute and subscription events', () => {
        expect(normalisePayPalEvent({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1', custom_id: 'O1', amount: { currency_code: 'USD', value: '19.99' } } })).toMatchObject({ type: 'payment.settled', orderCode: 'O1', paymentRef: 'CAP1', amount: 1999, currency: 'USD' });
        expect(normalisePayPalEvent({ id: 'WH-2', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'D1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', disputed_transactions: [{ seller_transaction_id: 'CAP1' }], dispute_amount: { currency_code: 'USD', value: '19.99' } } })).toMatchObject({ type: 'dispute.opened', paymentRef: 'CAP1', amount: 1999 });
        expect(normalisePayPalEvent({ id: 'WH-3', event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'S1', billing_agreement_id: 'I-SUB', amount: { currency_code: 'GBP', value: '5.00' } } })).toMatchObject({ type: 'subscription.renewed', subscriptionRef: 'I-SUB', amount: 500 });
        expect(normalisePayPalEvent({ id: 'WH-4', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-SUB' } }).type).toBe('subscription.canceled');
    });
});

describe('eligibility rules', () => {
    const ctx: any = { activeUserId: undefined };
    const order: any = { totalWithTax: 5000, currencyCode: 'GBP', shippingAddress: { countryCode: 'GB' }, customer: { groups: [{ id: 3 }] } };
    const check = (args: any) => {
        const merged: Record<string, any> = { minAmount: 0, maxAmount: 0, currencies: '', countries: '', customerGroups: '', requireLogin: false, ...args };
        return huloPaymentRulesChecker.check(ctx, order, Object.entries(merged).map(([name, value]) => ({ name, value: String(value) })), {} as any);
    };
    it('applies amount bands, currencies, countries, groups and login', async () => {
        expect(await check({})).toBe(true);
        expect(await check({ minAmount: 6000 })).toBe(false);
        expect(await check({ maxAmount: 4000 })).toBe(false);
        expect(await check({ currencies: 'EUR' })).toBe(false);
        expect(await check({ currencies: 'gbp, eur' })).toBe(true);
        expect(await check({ countries: 'DE,FR' })).toBe(false);
        expect(await check({ countries: 'gb' })).toBe(true);
        expect(await check({ customerGroups: '3' })).toBe(true);
        expect(await check({ customerGroups: '4' })).toBe(false);
        expect(await check({ requireLogin: true })).toBe(false);
    });
});

describe('more providers', () => {
    it('Square verifies HMAC over notification URL + body and normalises payments', async () => {
        const { squareProvider, normaliseSquareEvent } = await import('../providers/square');
        const { configureRuntime } = await import('./runtime');
        configureRuntime({ publicBaseUrl: () => 'https://shop.test' });
        const body = JSON.stringify({ event_id: 'e1', type: 'payment.updated', data: { object: { payment: { id: 'P1', status: 'COMPLETED', reference_id: 'O1', amount_money: { amount: 1999, currency: 'GBP' } } } } });
        const sig = createHmac('sha256', 'sqkey').update('https://shop.test/hulo-payments/webhook/hulo-square' + body).digest('base64');
        const ok = await squareProvider.verifyWebhook({ webhookSignatureKey: 'sqkey' }, body, { 'x-square-hmacsha256-signature': sig }, {});
        expect(ok.ok).toBe(true);
        expect(ok.events[0]).toMatchObject({ type: 'payment.settled', orderCode: 'O1', paymentRef: 'P1', amount: 1999 });
        expect((await squareProvider.verifyWebhook({ webhookSignatureKey: 'sqkey' }, body, { 'x-square-hmacsha256-signature': 'nope' }, {})).ok).toBe(false);
        expect(normaliseSquareEvent({ event_id: 'e2', type: 'dispute.state.updated', data: { object: { dispute: { id: 'D1', state: 'WON', amount_money: { amount: 500, currency: 'GBP' }, disputed_payment: { payment_id: 'P1' } } } } })).toMatchObject({ type: 'dispute.closed', reason: 'won', paymentRef: 'P1' });
    });
    it('GoCardless verifies the Webhook-Signature header and maps events', async () => {
        const { gocardlessProvider } = await import('../providers/gocardless');
        const body = JSON.stringify({ events: [{ id: 'EV1', resource_type: 'payments', action: 'confirmed', links: { payment: 'PM1' } }, { id: 'EV2', resource_type: 'payments', action: 'charged_back', links: { payment: 'PM1' } }, { id: 'EV3', resource_type: 'subscriptions', action: 'cancelled', links: { subscription: 'SB1' } }] });
        const sig = createHmac('sha256', 'gcsecret').update(body).digest('hex');
        const ok = await gocardlessProvider.verifyWebhook({ webhookSecret: 'gcsecret' }, body, { 'webhook-signature': sig }, {});
        expect(ok.ok).toBe(true);
        expect(ok.events.map(e => e.type)).toEqual(['payment.settled', 'dispute.opened', 'subscription.canceled']);
    });
    it('Checkout.com verifies cko-signature and maps captures and disputes', async () => {
        const { checkoutComProvider } = await import('../providers/checkout-com');
        const body = JSON.stringify({ id: 'evt_1', type: 'payment_captured', data: { id: 'pay_1', reference: 'O1', amount: 2500, currency: 'GBP' } });
        const sig = createHmac('sha256', 'ckosecret').update(body).digest('hex');
        const ok = await checkoutComProvider.verifyWebhook({ webhookSecret: 'ckosecret' }, body, { 'cko-signature': sig }, {});
        expect(ok.ok).toBe(true);
        expect(ok.events[0]).toMatchObject({ type: 'payment.settled', orderCode: 'O1', paymentRef: 'pay_1', amount: 2500, currency: 'GBP' });
    });
    it('Coinbase Commerce verifies X-CC-Webhook-Signature and maps confirmations', async () => {
        const { coinbaseProvider } = await import('../providers/coinbase');
        const body = JSON.stringify({ event: { id: 'e1', type: 'charge:confirmed', data: { code: 'ABCD', metadata: { orderCode: 'O1' }, pricing: { local: { amount: '19.99', currency: 'GBP' } } } } });
        const sig = createHmac('sha256', 'cbsecret').update(body).digest('hex');
        const ok = await coinbaseProvider.verifyWebhook({ webhookSharedSecret: 'cbsecret' }, body, { 'x-cc-webhook-signature': sig }, {});
        expect(ok.ok).toBe(true);
        expect(ok.events[0]).toMatchObject({ type: 'payment.settled', orderCode: 'O1', paymentRef: 'ABCD', amount: 1999 });
    });
    it('offline methods authorise immediately with instructions and settle by hand', async () => {
        const { bankTransferProvider, payLaterProvider } = await import('../providers/offline');
        const order: any = { code: 'O1', totalWithTax: 5000, currencyCode: 'GBP', lines: [] };
        const s = await bankTransferProvider.createSession({} as any, order, { accountName: 'HULO Ltd', sortCode: '00-00-00', accountNumber: '12345678' }, {});
        expect(s.flow).toBe('instructions');
        expect(s.instructions).toContain('Reference: O1');
        const p = await bankTransferProvider.confirmPayment({} as any, order, { accountName: 'HULO Ltd' }, {});
        expect(p).toMatchObject({ state: 'Authorized', amount: 5000 });
        const pl = await payLaterProvider.confirmPayment({} as any, order, { termsDays: 14 }, {});
        expect(pl.state).toBe('Authorized');
        expect((pl.metadata as any).public.termsDays).toBe(14);
    });
});
