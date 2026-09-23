import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, MysqlInitializer, testConfig } from '@vendure/testing';
import { createHmac } from 'crypto';
import gql from 'graphql-tag';
import { initialData } from '../../../e2e-shared/initial-data';
import { HuloPaymentsPlugin } from '../src/plugin';
import { LedgerService } from '../src/core/ledger.service';
import { SubscriptionService } from '../src/subscriptions/subscription.service';

/**
 * Boots a real Vendure server with the plugin on MariaDB and exercises the
 * pieces that need no provider account: schema, handlers and checker
 * registration, admin guards, webhook verification + idempotency, the
 * ledger, settings and the subscription tables. Provider round-trips are
 * covered by the unit suite against recorded shapes.
 *   PAY_E2E_DB_HOST PAY_E2E_DB_PORT PAY_E2E_DB_USER PAY_E2E_DB_PASS
 */
const DB = process.env.PAY_E2E_DB_HOST
    ? { host: process.env.PAY_E2E_DB_HOST, port: Number(process.env.PAY_E2E_DB_PORT || 3306), username: process.env.PAY_E2E_DB_USER || 'root', password: process.env.PAY_E2E_DB_PASS || '' }
    : null;

const PORT = 3068;
const BASE = `http://localhost:${PORT}`;
const run = DB ? describe : describe.skip;

run('@huloglobal/vendure-plugin-payments (MariaDB)', () => {
    registerInitializer('mysql', new MysqlInitializer());
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        dbConnectionOptions: { type: 'mysql' as const, host: DB?.host, port: DB?.port, username: DB?.username, password: DB?.password, database: 'hulo_pay_e2e', synchronize: true },
        plugins: [HuloPaymentsPlugin.init({ publicBaseUrl: BASE, disableScheduler: true })],
    });
    const { server, adminClient } = createTestEnvironment(config);
    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
        await adminClient.asSuperAdmin();
    }, 120_000);
    afterAll(async () => { await server.destroy(); });
    const ledger = () => (server as any).app.get(LedgerService) as LedgerService;
    const subs = () => (server as any).app.get(SubscriptionService) as SubscriptionService;

    it('registers all eleven handlers and the rules checker', async () => {
        const r: any = await adminClient.query(gql`query { paymentMethodHandlers { code } paymentMethodEligibilityCheckers { code } }`);
        const codes = r.paymentMethodHandlers.map((h: any) => h.code);
        expect(codes).toEqual(expect.arrayContaining(['hulo-stripe', 'hulo-adyen', 'hulo-paypal', 'hulo-mollie', 'hulo-square', 'hulo-braintree', 'hulo-gocardless', 'hulo-checkout-com', 'hulo-coinbase', 'hulo-bank-transfer', 'hulo-pay-later']));
        expect(r.paymentMethodEligibilityCheckers.map((c: any) => c.code)).toContain('hulo-payment-rules');
    });

    it('adds the subscription custom fields to product variants', async () => {
        const r: any = await adminClient.query(gql`query { globalSettings { serverConfig { customFieldConfig { ProductVariant { ... on StringCustomFieldConfig { name } ... on IntCustomFieldConfig { name } } } } } }`);
        const names = r.globalSettings.serverConfig.customFieldConfig.ProductVariant.map((f: any) => f.name);
        expect(names).toEqual(expect.arrayContaining(['huloSubscriptionInterval', 'huloSubscriptionIntervalCount', 'huloSubscriptionTrialDays']));
    });

    it('admin endpoints reject anonymous callers', async () => {
        for (const p of ['dashboard', 'transactions', 'providers', 'settings', 'subscriptions', 'events', 'meta']) {
            expect([401, 403]).toContain((await fetch(`${BASE}/hulo-payments/${p}`)).status);
        }
    });

    it('creates a Stripe payment method and exposes its webhook URL to admins', async () => {
        const created: any = await adminClient.query(gql`mutation {
            createPaymentMethod(input: { code: "stripe", enabled: true, translations: [{ languageCode: en, name: "Card (Stripe)" }],
                handler: { code: "hulo-stripe", arguments: [
                    { name: "secretKey", value: "sk_test_x" }, { name: "publishableKey", value: "pk_test_x" }, { name: "webhookSecret", value: "whsec_e2e" },
                    { name: "captureMethod", value: "automatic" }, { name: "paymentMethodTypes", value: "" }, { name: "statementDescriptorSuffix", value: "" } ] } }) { id code } }`);
        expect(created.createPaymentMethod.code).toBe('stripe');
        const token = (adminClient as any).getAuthToken?.() as string | undefined;
        const res = await fetch(`${BASE}/hulo-payments/providers`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        expect(res.status).toBe(200);
        const body: any = await res.json();
        const stripe = body.providers.find((p: any) => p.code === 'hulo-stripe');
        expect(stripe.webhookUrl).toBe(`${BASE}/hulo-payments/webhook/hulo-stripe`);
        expect(stripe.methods[0].args.secretKey).not.toBe('sk_test_x'); // redacted
    });

    it('rejects unsigned webhooks and accepts signed ones exactly once', async () => {
        const body = JSON.stringify({ id: 'evt_e2e_1', type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_none', amount: 1234, currency: 'gbp', reason: 'fraudulent' } } });
        const bad = await fetch(`${BASE}/hulo-payments/webhook/hulo-stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body });
        expect(bad.status).toBe(400);
        const t = Math.floor(Date.now() / 1000);
        const sig = `t=${t},v1=${createHmac('sha256', 'whsec_e2e').update(`${t}.${body}`).digest('hex')}`;
        const ok = await fetch(`${BASE}/hulo-payments/webhook/hulo-stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
        expect(ok.status).toBe(200);
        expect((await ok.json()).events).toBe(1);
        const again = await fetch(`${BASE}/hulo-payments/webhook/hulo-stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
        expect(again.status).toBe(200);
        const txns = await ledger().list({ kind: 'dispute' });
        expect(txns.totalItems).toBe(1); // second delivery was deduplicated
        expect(txns.items[0]).toMatchObject({ provider: 'hulo-stripe', status: 'open', amount: 1234, currency: 'GBP' });
        expect((await ledger().stats(null, 30)).totals.disputes).toBe(1);
    });

    it('connect validates keys before touching the provider and exposes connect metadata', async () => {
        const token = (adminClient as any).getAuthToken?.() as string | undefined;
        const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
        const test = await fetch(`${BASE}/hulo-payments/connect/hulo-stripe/test`, { method: 'POST', headers, body: JSON.stringify({ args: { secretKey: 'nope', publishableKey: 'pk_test_x' } }) });
        expect(test.status).toBe(200);
        const body: any = await test.json();
        expect(body.ok).toBe(false);
        expect(body.message).toMatch(/sk_live_ or sk_test_/);
        const connect = await fetch(`${BASE}/hulo-payments/connect/hulo-stripe`, { method: 'POST', headers, body: JSON.stringify({ channelId: 1, args: { secretKey: 'sk_test_x', publishableKey: 'pk_live_x' } }) });
        expect(connect.status).toBe(400);
        expect(((await connect.json()) as any).message).toMatch(/same mode/);
        const providers: any = await (await fetch(`${BASE}/hulo-payments/providers`, { headers })).json();
        const stripe = providers.providers.find((p: any) => p.code === 'hulo-stripe');
        expect(stripe.connectFields.map((f: any) => f.name)).toEqual(['secretKey', 'publishableKey', 'captureMethod']);
        expect(stripe.links.keys).toContain('dashboard.stripe.com');
        expect(providers.channels[0].id).toBe(1);
    });

    it('hosted checkout takes an order from basket to PaymentAuthorized with bank transfer', async () => {
        // Catalogue + shipping so a shop order can reach ArrangingPayment.
        const tax: any = await adminClient.query(gql`mutation { createTaxCategory(input: { name: "Standard" }) { id } }`);
        const product: any = await adminClient.query(gql`mutation($tax: ID!) { createProduct(input: { translations: [{ languageCode: en, name: "Staging licence", slug: "staging-licence", description: "" }] }) { id } }`, { tax: tax.createTaxCategory.id }).catch(async () => adminClient.query(gql`mutation { createProduct(input: { translations: [{ languageCode: en, name: "Staging licence", slug: "staging-licence", description: "" }] }) { id } }`));
        const variant: any = await adminClient.query(gql`mutation($pid: ID!, $tax: ID!) { createProductVariants(input: [{ productId: $pid, sku: "STG-1", price: 1999, taxCategoryId: $tax, trackInventory: FALSE, stockOnHand: 100, translations: [{ languageCode: en, name: "Staging licence" }] }]) { id } }`, { pid: product.createProduct.id, tax: tax.createTaxCategory.id });
        await adminClient.query(gql`mutation { createShippingMethod(input: { code: "email", fulfillmentHandler: "manual-fulfillment", checker: { code: "default-shipping-eligibility-checker", arguments: [{ name: "orderMinimum", value: "0" }] }, calculator: { code: "default-shipping-calculator", arguments: [{ name: "rate", value: "0" }, { name: "includesTax", value: "auto" }, { name: "taxRate", value: "0" }] }, translations: [{ languageCode: en, name: "Email delivery", description: "" }] }) { id } }`);
        await adminClient.query(gql`mutation { createPaymentMethod(input: { code: "bank", enabled: true, translations: [{ languageCode: en, name: "Bank transfer" }], handler: { code: "hulo-bank-transfer", arguments: [{ name: "accountName", value: "HULO Ltd" }, { name: "sortCode", value: "00-00-00" }, { name: "accountNumber", value: "12345678" }, { name: "iban", value: "" }, { name: "bic", value: "" }, { name: "instructions", value: "Quote {{orderCode}}" }] } }) { id } }`);
        // Shop side: basket → customer → shipping → ArrangingPayment → hosted checkout.
        const shop = async (query: string, variables?: any) => {
            const res = await fetch(`${BASE}/shop-api`, { method: 'POST', headers: { 'content-type': 'application/json', ...(shopToken ? { authorization: `Bearer ${shopToken}` } : {}) }, body: JSON.stringify({ query, variables }) });
            const t = res.headers.get('vendure-auth-token'); if (t) shopToken = t;
            const json: any = await res.json(); if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join('; '));
            for (const v of Object.values(json.data || {}) as any[]) if (v && typeof v === 'object' && v.errorCode) throw new Error(`${v.errorCode}: ${v.message}`);
            return json.data;
        };
        let shopToken = '';
        await shop(`mutation($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { code } ... on ErrorResult { errorCode message } } }`, { id: variant.createProductVariants[0].id });
        await shop(`mutation { setCustomerForOrder(input: { emailAddress: "hosted@example.test", firstName: "Hosted", lastName: "Tester" }) { ... on Order { code } ... on ErrorResult { errorCode message } } }`);
        await shop(`mutation { setOrderShippingAddress(input: { fullName: "Hosted Tester", streetLine1: "1 Test St", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" }) { ... on Order { code } ... on ErrorResult { errorCode message } } }`);
        const m: any = await shop(`{ eligibleShippingMethods { id } }`);
        await shop(`mutation($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ... on Order { code } ... on ErrorResult { errorCode message } } }`, { id: [m.eligibleShippingMethods[0].id] });
        const t: any = await shop(`mutation { transitionOrderToState(state: "ArrangingPayment") { ... on Order { state code } ... on ErrorResult { errorCode message } } }`);
        expect(t.transitionOrderToState.state).toBe('ArrangingPayment');
        const h: any = await shop(`mutation { huloHostedCheckout(returnUrl: "https://shop.test/checkout/return", methodCode: "bank") { url expiresAt } }`);
        expect(h.huloHostedCheckout.url).toMatch(new RegExp(`^${BASE}/hulo-payments/pay/[a-f0-9]{48}$`));
        const page = await fetch(h.huloHostedCheckout.url);
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('Bank transfer');
        expect(html).toContain(t.transitionOrderToState.code);
        expect(html).toContain('var PRESELECT = "bank"');
        const sess = await fetch(`${h.huloHostedCheckout.url}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methodCode: 'bank' }) });
        expect(sess.status).toBe(200);
        const sj: any = await sess.json();
        expect(sj.flow).toBe('instructions');
        expect(sj.instructions).toContain(`Reference: ${t.transitionOrderToState.code}`);
        expect(sj.instructions).toContain(`Quote ${t.transitionOrderToState.code}`);
        const done = await fetch(`${h.huloHostedCheckout.url}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methodCode: 'bank', metadata: {} }) });
        const dj: any = await done.json();
        expect({ status: done.status, ...dj }).toMatchObject({ paid: true });
        expect(dj.state).toBe('PaymentAuthorized');
        expect(dj.redirect).toBe(`https://shop.test/checkout/return?order=${t.transitionOrderToState.code}&result=pending`);
        // Page now redirects to the return URL, and the token is spent.
        const again = await fetch(h.huloHostedCheckout.url, { redirect: 'manual' });
        expect(again.status).toBe(302);
        const ledgerRows = await ledger().list({ kind: 'authorize' });
        expect(ledgerRows.items[0]).toMatchObject({ provider: 'hulo-bank-transfer', orderCode: t.transitionOrderToState.code, amount: 1999 });
    });

    it('unknown providers are refused', async () => {
        expect((await fetch(`${BASE}/hulo-payments/webhook/hulo-nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    });

    it('stores per-channel settings and lists subscriptions', async () => {
        await ledger().saveSettings({ channelId: 1, providerOrder: ['hulo-adyen', 'hulo-stripe'], fallbackOnFailure: false, saveCardsDefault: true, surcharges: { 'hulo-paypal': { type: 'percent', value: 2.5 } }, opsEmail: 'ops@example.test', dunningDays: 5, hostedBrandName: 'Staging shop', hostedAccent: '#1d4ed8', hostedLogoUrl: '' });
        const s = await ledger().getSettings(1);
        expect(s.providerOrder[0]).toBe('hulo-adyen');
        expect(s.surcharges['hulo-paypal']).toMatchObject({ type: 'percent', value: 2.5 });
        expect(s.dunningDays).toBe(5);
        const list = await subs().list({});
        expect(list.totalItems).toBe(0);
        expect((await subs().stats()).active).toBe(0);
    });
});
