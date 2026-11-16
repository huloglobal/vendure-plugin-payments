import { TransactionalConnection, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, MysqlInitializer, testConfig } from '@vendure/testing';
import { createHmac } from 'crypto';
import gql from 'graphql-tag';
import { initialData } from '../../../e2e-shared/initial-data';
import { HuloPaymentsPlugin } from '../src/plugin';
import { LedgerService } from '../src/core/ledger.service';
import { SubscriptionService } from '../src/subscriptions/subscription.service';
import { configureRuntime, getRuntime } from '../src/core/runtime';
import { PayLinkService } from '../src/core/pay-link.service';
import { PaymentsService } from '../src/core/payments.service';

/**
 * Boots a real Vendure server with the plugin on MariaDB and exercises the
 * pieces that need no provider account: schema, handlers and checker
 * registration, admin guards, webhook verification + idempotency, the
 * ledger, settings and the subscription tables. Provider round-trips are
 * covered by the unit suite against recorded shapes.
 *   PAY_E2E_DB_HOST PAY_E2E_DB_PORT PAY_E2E_DB_USER PAY_E2E_DB_PASS (PAY_E2E_DB_NAME, default hulo_pay_e2e)
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
        dbConnectionOptions: { type: 'mysql' as const, host: DB?.host, port: DB?.port, username: DB?.username, password: DB?.password, database: process.env.PAY_E2E_DB_NAME || 'hulo_pay_e2e', synchronize: true },
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

        // 0.2.9: the GET is read-only (link previews must not freeze a cart); the order enters
        // ArrangingPayment on the first /session call. A new basket in this session:
        await shop(`mutation($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 2) { ... on Order { code state } ... on ErrorResult { errorCode message } } }`, { id: variant.createProductVariants[0].id });
        await shop(`mutation { setCustomerForOrder(input: { emailAddress: "hosted2@example.test", firstName: "Hosted", lastName: "Two" }) { ... on Order { code } ... on ErrorResult { errorCode message } } }`);
        await shop(`mutation { setOrderShippingAddress(input: { fullName: "Hosted Two", streetLine1: "2 Test St", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" }) { ... on Order { code } ... on ErrorResult { errorCode message } } }`);
        await shop(`mutation($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ... on Order { code } ... on ErrorResult { errorCode message } } }`, { id: [m.eligibleShippingMethods[0].id] });
        const h2: any = await shop(`mutation { huloHostedCheckout(returnUrl: "https://shop.test/checkout/return") { url } }`);
        const page2 = await fetch(h2.huloHostedCheckout.url);
        expect(page2.status).toBe(200);
        expect(page2.headers.get('content-security-policy-report-only')).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+' https:\/\/js\.stripe\.com/);
        expect(page2.headers.get('content-security-policy')).toBe("frame-ancestors 'none'; base-uri 'none'");
        const html2 = await page2.text();
        const nonce = (html2.match(/<script nonce="([^"]+)">/) || [])[1];
        expect(nonce).toBeTruthy();
        expect(page2.headers.get('content-security-policy-report-only')).toContain(`'nonce-${nonce}'`);
        expect(html2).toContain('Bank transfer');
        expect((await shop(`{ activeOrder { state } }`)).activeOrder.state).toBe('AddingItems');
        const sess2 = await fetch(`${h2.huloHostedCheckout.url}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methodCode: 'bank' }) });
        expect(sess2.status).toBe(200);
        expect((await shop(`{ activeOrder { state } }`)).activeOrder.state).toBe('ArrangingPayment');
        // The CSP report endpoint answers 204 to a browser's application/csp-report body.
        const rep = await fetch(`${BASE}/hulo-payments/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'document-uri': h2.huloHostedCheckout.url, 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.test/x.js' } }) });
        expect(rep.status).toBe(204);
        // hulo_hosted_session.orderId is stored as text (UUID id strategies).
        const [col]: any[] = await (server as any).app.get(TransactionalConnection).rawConnection.query(`SELECT DATA_TYPE AS dt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'hulo_hosted_session' AND column_name = 'orderId'`);
        expect(String(col.dt).toLowerCase()).toBe('varchar');
    });

    it('adds a provider to a channel as a disabled, named placeholder method', async () => {
        const adminToken = (adminClient as any).getAuthToken?.() as string | undefined;
        const r = await fetch(`${BASE}/hulo-payments/methods`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ provider: 'hulo-adyen', channelId: 1 }) });
        expect(r.status).toBe(200);
        const j: any = await r.json();
        expect(j).toMatchObject({ ok: true, created: true, method: { code: 'hulo-adyen' } });
        const pm: any = await adminClient.query(gql`query($id: ID!) { paymentMethod(id: $id) { code name enabled description handler { code args { name value } } } }`, { id: j.method.id });
        expect(pm.paymentMethod).toMatchObject({ code: 'hulo-adyen', enabled: false, name: 'Adyen · cards, wallets & 100+ local methods' });
        expect(pm.paymentMethod.handler.code).toBe('hulo-adyen');
        expect(pm.paymentMethod.handler.args.find((a: any) => a.name === 'environment').value).toBe('test');
        expect(pm.paymentMethod.description).toContain('Not set up yet');
        // Idempotent: a second call reports the existing method.
        const again: any = await (await fetch(`${BASE}/hulo-payments/methods`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ provider: 'hulo-adyen', channelId: 1 }) })).json();
        expect(again).toMatchObject({ ok: true, created: false, method: { code: 'hulo-adyen' } });
        // And the providers endpoint shows it as a method of Adyen on channel 1.
        const prov: any = await (await fetch(`${BASE}/hulo-payments/providers`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
        const adyen = prov.providers.find((p: any) => p.code === 'hulo-adyen');
        expect(adyen.methods.map((m: any) => m.code)).toContain('hulo-adyen');
    });

    it('unknown providers are refused', async () => {
        expect((await fetch(`${BASE}/hulo-payments/webhook/hulo-nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    });

    it('stores per-channel settings and lists subscriptions', async () => {
        await ledger().saveSettings({ channelId: 1, providerOrder: ['hulo-adyen', 'hulo-stripe'], fallbackOnFailure: false, reconcileRefunds: false, saveCardsDefault: true, surcharges: { 'hulo-paypal': { type: 'percent', value: 2.5 } }, opsEmail: 'ops@example.test', dunningDays: 5, hostedBrandName: 'Staging shop', hostedAccent: '#1d4ed8', hostedLogoUrl: '' });
        const s = await ledger().getSettings(1);
        expect(s.providerOrder[0]).toBe('hulo-adyen');
        expect(s.surcharges['hulo-paypal']).toMatchObject({ type: 'percent', value: 2.5 });
        expect(s.dunningDays).toBe(5);
        const list = await subs().list({});
        expect(list.totalItems).toBe(0);
        expect((await subs().stats()).active).toBe(0);
    });

    it('0.5.0: subscriptions are listed per channel and alerts take the channel branding', async () => {
        const conn = (server as any).app.get(TransactionalConnection) as TransactionalConnection;
        await conn.rawConnection.query(
            `INSERT INTO hulo_subscription (provider, providerSubscriptionRef, channelId, customerEmail, orderCode, variantId, variantName, amount, currency, status, createdAt, updatedAt)
             VALUES ('hulo-stripe', 'sub_ch2', 2, 'two@example.test', 'CH2ORDER', 1, 'Plan', 1000, 'GBP', 'active', NOW(), NOW())`);
        expect((await subs().list({ channelId: 1 })).items.map(i => i.providerSubscriptionRef)).not.toContain('sub_ch2');
        expect((await subs().list({ channelId: 2 })).items.map(i => i.providerSubscriptionRef)).toEqual(['sub_ch2']);
        expect((await subs().stats(2)).active).toBe(1);
        expect((await subs().stats(1)).active).toBe(0);
        const b = await getRuntime().channelBranding(1);
        expect(b).toEqual({ storeName: 'Staging shop', accentColor: null, logoUrl: null });
        await conn.rawConnection.query(`DELETE FROM hulo_subscription WHERE providerSubscriptionRef = 'sub_ch2'`);
    });
    // ── 0.3.3: surcharge follows the method charged; provider confirmations bound to the payment ──
    const shopClient = () => {
        let token = '';
        return async (query: string, variables?: any) => {
            const res = await fetch(`${BASE}/shop-api`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
            const t = res.headers.get('vendure-auth-token'); if (t) token = t;
            const json: any = await res.json(); if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join('; '));
            return json.data;
        };
    };
    const orderToArrangingPayment = async (shop: ReturnType<typeof shopClient>, email: string) => {
        const v: any = await adminClient.query(gql`{ productVariants(options: { filter: { sku: { eq: "STG-1" } } }) { items { id } } }`);
        await shop(`mutation($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { code } } }`, { id: v.productVariants.items[0].id });
        await shop(`mutation($e: String!) { setCustomerForOrder(input: { emailAddress: $e, firstName: "Fee", lastName: "Tester" }) { ... on Order { code } } }`, { e: email });
        await shop(`mutation { setOrderShippingAddress(input: { fullName: "Fee Tester", streetLine1: "1 Test St", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" }) { ... on Order { code } } }`);
        const m: any = await shop(`{ eligibleShippingMethods { id } }`);
        await shop(`mutation($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ... on Order { code } } }`, { id: [m.eligibleShippingMethods[0].id] });
        const t: any = await shop(`mutation { transitionOrderToState(state: "ArrangingPayment") { ... on Order { state code totalWithTax currencyCode } ... on ErrorResult { errorCode message } } }`);
        expect(t.transitionOrderToState.state).toBe('ArrangingPayment');
        return t.transitionOrderToState as { code: string; totalWithTax: number; currencyCode: string };
    };
    /** Surcharges and Adyen are licensed features: run these with premium access on. */
    let licensed: (() => boolean) | null = null;
    beforeEach(() => { licensed = getRuntime().hasPremiumAccess; configureRuntime({ hasPremiumAccess: () => true }); });
    afterEach(() => { if (licensed) configureRuntime({ hasPremiumAccess: licensed }); });
    const ADD_PAYMENT = `mutation($m: String!, $md: JSON!) { addPaymentToOrder(input: { method: $m, metadata: $md }) {
        ... on Order { state totalWithTax payments { amount state method } } ... on ErrorResult { errorCode message } ... on PaymentFailedError { paymentErrorMessage } } }`;

    it('charges the fee of the method actually used, not the one the client applied', async () => {
        await adminClient.query(gql`mutation { createPaymentMethod(input: { code: "later", enabled: true, translations: [{ languageCode: en, name: "Pay later" }], handler: { code: "hulo-pay-later", arguments: [{ name: "termsDays", value: "30" }, { name: "instructions", value: "" }] } }) { id } }`);
        const base = await ledger().getSettings(1);
        await ledger().saveSettings({ ...base, channelId: 1, surcharges: { 'hulo-bank-transfer': { type: 'fixed', value: 250, label: 'Bank handling fee' } } } as any);
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'fee@example.test');
        // Client applies the fee-free method's surcharge, then pays by bank transfer.
        const applied: any = await shop(`mutation { huloApplyPaymentSurcharge(methodCode: "later") { totalWithTax surcharges { sku priceWithTax } } }`);
        expect(applied.huloApplyPaymentSurcharge.totalWithTax).toBe(order.totalWithTax);
        const bypass: any = await shop(ADD_PAYMENT, { m: 'bank', md: {} });
        expect(bypass.addPaymentToOrder.errorCode).toBe('PAYMENT_FAILED_ERROR');
        expect(bypass.addPaymentToOrder.paymentErrorMessage).toMatch(/payment fee/);
        // Creating the session for the method puts its fee on the order; the payment then covers it.
        const sess: any = await shop(`mutation { huloCreatePaymentSession(methodCode: "bank") { amount provider } }`);
        expect(sess.huloCreatePaymentSession.amount).toBe(order.totalWithTax + 250);
        const paid: any = await shop(ADD_PAYMENT, { m: 'bank', md: {} });
        expect(paid.addPaymentToOrder.state).toBe('PaymentAuthorized');
        expect(paid.addPaymentToOrder.totalWithTax).toBe(order.totalWithTax + 250);
        expect(paid.addPaymentToOrder.payments.find((p: any) => p.state === 'Authorized').amount).toBe(order.totalWithTax + 250);
        await ledger().saveSettings({ ...base, channelId: 1, surcharges: {} } as any);
    });

    it('an Adyen AUTHORISATION for less than the payment does not settle it', async () => {
        const hmacKey = '44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056';
        await adminClient.query(gql`mutation($h: String!) { createPaymentMethod(input: { code: "adyen", enabled: true, translations: [{ languageCode: en, name: "Adyen" }], handler: { code: "hulo-adyen", arguments: [
            { name: "apiKey", value: "test_key" }, { name: "merchantAccount", value: "HuloECOM" }, { name: "clientKey", value: "test_ck" }, { name: "hmacKey", value: $h },
            { name: "environment", value: "test" }, { name: "liveUrlPrefix", value: "" }, { name: "captureMode", value: "immediate" }, { name: "webhookUser", value: "" }, { name: "webhookPassword", value: "" } ] } }) { id } }`, { h: hmacKey });
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'adyen@example.test');
        const realFetch = globalThis.fetch;
        // Adyen test API stub: the session is this order's and completed, with no payments list.
        (globalThis as any).fetch = async (url: any, init: any) => String(url).startsWith('https://checkout-test.adyen.com/')
            ? new Response(JSON.stringify({ id: 'CS_E2E', status: 'completed', reference: order.code }), { status: 200 })
            : realFetch(url, init);
        try {
            const r: any = await shop(ADD_PAYMENT, { m: 'adyen', md: { sessionId: 'CS_E2E', sessionResult: 'res' } });
            expect(r.addPaymentToOrder.state).toBe('PaymentAuthorized');
        } finally { (globalThis as any).fetch = realFetch; }
        const notify = async (value: number, psp: string) => {
            const it: any = { pspReference: psp, originalReference: '', merchantAccountCode: 'HuloECOM', merchantReference: order.code, amount: { value, currency: order.currencyCode }, eventCode: 'AUTHORISATION', success: 'true', additionalData: {} };
            it.additionalData.hmacSignature = createHmac('sha256', Buffer.from(hmacKey, 'hex')).update([it.pspReference, it.originalReference, it.merchantAccountCode, it.merchantReference, it.amount.value, it.amount.currency, it.eventCode, it.success].join(':')).digest('base64');
            const res = await fetch(`${BASE}/hulo-payments/webhook/hulo-adyen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ live: 'false', notificationItems: [{ NotificationRequestItem: it }] }) });
            expect(res.status).toBe(200);
        };
        await notify(100, 'PSP_SMALL');
        const byCode = async () => (await adminClient.query(gql`query($c: String!) { orders(options: { filter: { code: { eq: $c } } }) { items { state payments { state transactionId amount } } } }`, { c: order.code }) as any).orders.items[0];
        expect((await byCode()).state).toBe('PaymentAuthorized');
        expect((await byCode()).payments[0].state).toBe('Authorized');
        expect((await ledger().list({ kind: 'failure' })).items.some((x: any) => x.orderCode === order.code && /amount mismatch/.test(x.reason || ''))).toBe(true);
        // The AUTHORISATION for the full amount settles it.
        await notify(order.totalWithTax, 'PSP_FULL');
        const after = await byCode();
        expect(after.state).toBe('PaymentSettled');
        expect(after.payments[0]).toMatchObject({ state: 'Settled', transactionId: 'PSP_FULL' });
    });

    // ── 0.4.0: parity wave ───────────────────────────────────────────────
    const adminHeaders = () => { const t = (adminClient as any).getAuthToken?.() as string | undefined; return { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }; };
    const orderByCode = async (code: string) => (await adminClient.query(gql`query($c: String!) { orders(options: { filter: { code: { eq: $c } } }) { items { id state payments { id state transactionId amount refunds { id total state transactionId reason } } } } }`, { c: code }) as any).orders.items[0];
    const stripeSig = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', 'whsec_e2e').update(`${t}.${body}`).digest('hex')}`; };
    const stripeWebhook = (event: any) => { const body = JSON.stringify(event); return fetch(`${BASE}/hulo-payments/webhook/hulo-stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(body) }, body }); };

    it('pay links are free: a hosted-page link takes any unpaid order to paid and the ledger row to ok', async () => {
        configureRuntime({ hasPremiumAccess: () => false });
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'paylink@example.test');
        const r = await fetch(`${BASE}/hulo-payments/pay-link`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ orderCode: order.code, expiresInHours: 48 }) });
        expect(r.ok).toBe(true);
        const link: any = await r.json();
        expect(link).toMatchObject({ ok: true, mode: 'hosted', provider: 'hulo-hosted', amount: order.totalWithTax, orderCode: order.code });
        expect(link.url).toMatch(new RegExp(`^${BASE}/hulo-payments/pay/[a-f0-9]{48}$`));
        expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
        expect((await fetch(link.url)).status).toBe(200);
        const done: any = await (await fetch(`${link.url}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methodCode: 'bank', metadata: {} }) })).json();
        expect(done.paid).toBe(true);
        const list: any = await (await fetch(`${BASE}/hulo-payments/pay-links?orderCode=${order.code}`, { headers: adminHeaders() })).json();
        expect(list.items[0]).toMatchObject({ mode: 'hosted', status: 'ok', amount: order.totalWithTax });
        // A provider link with a licensed provider still needs the licence.
        const shop2 = shopClient();
        const o2 = await orderToArrangingPayment(shop2, 'paylink2@example.test');
        const lic = await fetch(`${BASE}/hulo-payments/pay-link`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ orderCode: o2.code, mode: 'provider', methodCode: 'adyen' }) });
        expect(lic.status).toBe(402);
        expect(((await lic.json()) as any).code).toBe('licence-required');
        const missing = await fetch(`${BASE}/hulo-payments/pay-link`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ orderCode: 'NOPE0000' }) });
        expect(missing.status).toBe(404);
    });

    it('weekly report and set-up checklist are licensed', async () => {
        configureRuntime({ hasPremiumAccess: () => false });
        const free: any = await (await fetch(`${BASE}/hulo-payments/setup`, { headers: adminHeaders() })).json();
        expect(free).toMatchObject({ premium: false, items: [], complete: true });
        const test = await fetch(`${BASE}/hulo-payments/digest/send-test`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ to: 'me@example.test' }) });
        expect(test.status).toBe(402);
        expect(((await (await fetch(`${BASE}/hulo-payments/digest/settings`, { headers: adminHeaders() })).json()) as any)).toMatchObject({ premium: false, nextDueAt: null });
    });

    it('B9: after a decline the hosted page and the shop API offer the next provider (licensed, channel switch on)', async () => {
        const saved = await fetch(`${BASE}/hulo-payments/settings`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ channelId: 1, fallbackOnFailure: true }) });
        expect(saved.ok).toBe(true);
        const after: any = await saved.json();
        expect(after.settings).toMatchObject({ fallbackOnFailure: true, opsEmail: 'ops@example.test', dunningDays: 5 }); // fields not sent are kept
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'fallback@example.test');
        const h: any = await shop(`mutation { huloHostedCheckout(returnUrl: "https://shop.test/r") { url } }`);
        const realFetch = globalThis.fetch;
        (globalThis as any).fetch = async (url: any, init: any) => String(url).startsWith('https://api.stripe.com/v1/payment_intents/pi_declined')
            ? new Response(JSON.stringify({ id: 'pi_declined', status: 'requires_payment_method', amount: order.totalWithTax, currency: order.currencyCode.toLowerCase(), metadata: { orderCode: order.code, vendureOrderId: '1' }, last_payment_error: { message: 'Your card was declined.' } }), { status: 200 })
            : realFetch(url, init);
        let dj: any;
        try {
            dj = await (await realFetch(`${h.huloHostedCheckout.url}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ methodCode: 'stripe', metadata: { paymentIntentId: 'pi_declined' } }) })).json();
        } finally { (globalThis as any).fetch = realFetch; }
        expect(dj.paid).toBe(false);
        expect(dj.fallback.map((f: any) => f.methodCode)).not.toContain('stripe');
        expect(dj.fallback.length).toBeGreaterThan(0);
        const p: any = await shop(`{ huloPaymentProviders(failedMethodCode: "stripe") { methodCode preferred } }`);
        expect(p.huloPaymentProviders[p.huloPaymentProviders.length - 1].methodCode).toBe('stripe');
        expect(p.huloPaymentProviders[0].preferred).toBe(true);
        // Unlicensed: the order stays the routing order and no fallback is offered.
        configureRuntime({ hasPremiumAccess: () => false });
        const p2: any = await shop(`{ huloPaymentProviders(failedMethodCode: "stripe") { methodCode } }`);
        expect(p2.huloPaymentProviders[0].methodCode).toBe('stripe');
    });

    it('dashboard refunds become Vendure refunds once each (channel switch on), own refunds are not counted twice', async () => {
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'refund@example.test');
        const cur = order.currencyCode.toLowerCase();
        const pi = { id: 'pi_e2erefund', status: 'succeeded', amount: order.totalWithTax, amount_received: order.totalWithTax, currency: cur, metadata: { orderCode: order.code, vendureOrderId: '1' } };
        const realFetch = globalThis.fetch;
        let listed: any[] = [];
        (globalThis as any).fetch = async (url: any, init: any) => {
            const u = String(url);
            if (u.startsWith('https://api.stripe.com/v1/payment_intents/pi_e2erefund')) return new Response(JSON.stringify(pi), { status: 200 });
            if (u.startsWith('https://api.stripe.com/v1/refunds?payment_intent=')) return new Response(JSON.stringify({ data: listed }), { status: 200 });
            if (u === 'https://api.stripe.com/v1/refunds') return new Response(JSON.stringify({ id: 're_own', status: 'succeeded', amount: 100, currency: cur }), { status: 200 });
            return realFetch(url, init);
        };
        try {
            const paid: any = await shop(ADD_PAYMENT, { m: 'stripe', md: { paymentIntentId: 'pi_e2erefund' } });
            expect(paid.addPaymentToOrder.state).toBe('PaymentSettled');
            const refundEvent = (id: string, refundId: string, amount: number) => ({ id, type: 'refund.updated', data: { object: { id: refundId, object: 'refund', status: 'succeeded', amount, currency: cur, payment_intent: 'pi_e2erefund' } } });
            // Off (the default): the event leaves the payment alone, as before 0.4.0.
            expect((await stripeWebhook(refundEvent('evt_rf_off', 're_dash0', 50))).status).toBe(200);
            expect((await orderByCode(order.code)).payments[0].refunds).toHaveLength(0);
            await fetch(`${BASE}/hulo-payments/settings`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ channelId: 1, reconcileRefunds: true }) });
            // On: a dashboard refund is recorded once, under its Stripe id.
            expect((await stripeWebhook(refundEvent('evt_rf_1', 're_dash1', 500))).status).toBe(200);
            expect((await stripeWebhook(refundEvent('evt_rf_1b', 're_dash1', 500))).status).toBe(200);
            const chargeRefunded = { id: 'evt_rf_2', type: 'charge.refunded', data: { object: { payment_intent: 'pi_e2erefund', currency: cur, amount_refunded: 500, metadata: pi.metadata, refunds: { data: [{ id: 're_dash1', status: 'succeeded', amount: 500, created: 1 }] } } } };
            expect((await stripeWebhook(chargeRefunded)).status).toBe(200);
            let p = (await orderByCode(order.code)).payments[0];
            expect(p.refunds).toHaveLength(1);
            expect(p.refunds[0]).toMatchObject({ total: 500, state: 'Settled', transactionId: 're_dash1' });
            // An event that names no refund (newer Stripe API versions): the refunds are read back, only the new one is added.
            listed = [{ id: 're_dash1', amount: 500, currency: cur, status: 'succeeded', created: 1 }, { id: 're_dash2', amount: 300, currency: cur, status: 'succeeded', created: 2 }];
            const noRef = { id: 'evt_rf_3', type: 'charge.refunded', data: { object: { payment_intent: 'pi_e2erefund', currency: cur, amount_refunded: 800, metadata: pi.metadata } } };
            expect((await stripeWebhook(noRef)).status).toBe(200);
            p = (await orderByCode(order.code)).payments[0];
            expect(p.refunds.map((r: any) => r.transactionId).sort()).toEqual(['re_dash1', 're_dash2']);
            // A refund made from Vendure, then its webhook: still one refund.
            const ord = await orderByCode(order.code);
            const own: any = await adminClient.query(gql`mutation($p: ID!) { refundOrder(input: { paymentId: $p, amount: 100, reason: "requested_by_customer" }) { ... on Refund { id state transactionId } ... on ErrorResult { errorCode message } } }`, { p: ord.payments[0].id });
            expect(own.refundOrder).toMatchObject({ state: 'Settled', transactionId: 're_own' });
            expect((await stripeWebhook(refundEvent('evt_rf_4', 're_own', 100))).status).toBe(200);
            p = (await orderByCode(order.code)).payments[0];
            expect(p.refunds).toHaveLength(3);
            const rows = (await ledger().list({ kind: 'refund', orderCode: order.code, perPage: 50 })).items;
            expect(rows.filter((x: any) => x.paymentRef === 're_dash1' && x.status === 'ok')).toHaveLength(1);
            expect(rows.filter((x: any) => x.paymentRef === 're_own')).toHaveLength(1);
        } finally { (globalThis as any).fetch = realFetch; }
        await fetch(`${BASE}/hulo-payments/settings`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ channelId: 1, reconcileRefunds: false }) });
    });

    it('public routes are rate limited per client IP', async () => {
        const url = `${BASE}/hulo-payments/pay/${'c'.repeat(48)}`;
        const statuses: number[] = [];
        for (let i = 0; i < 125; i++) statuses.push((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.77' } })).status);
        expect(statuses.slice(0, 120).every(s => s === 404)).toBe(true);
        const last = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.77' } });
        expect(last.status).toBe(429);
        expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
        // Another client is unaffected.
        expect((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.78' } })).status).toBe(404);
    });

    it('PayLinkService.createPayLink: a deposit and a balance are two partial payments; PaymentSettled only once covered', async () => {
        configureRuntime({ hasPremiumAccess: () => false }); // free tier
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'deposit@example.test');
        const cur = order.currencyCode.toLowerCase();
        const deposit = 500;
        const balance = order.totalWithTax - deposit;
        const svc = (server as any).app.get(PayLinkService) as PayLinkService;
        const ctx = await ((server as any).app.get(PaymentsService) as PaymentsService).adminCtx(1);
        const realFetch = globalThis.fetch;
        const sessions: any[] = [];
        const intents: Record<string, any> = {};
        (globalThis as any).fetch = async (url: any, init: any) => {
            const u = String(url);
            if (u === 'https://api.stripe.com/v1/checkout/sessions') {
                const body = new URLSearchParams(String(init.body));
                sessions.push(body);
                return new Response(JSON.stringify({ id: `cs_${sessions.length}`, url: `https://checkout.stripe.test/${sessions.length}` }), { status: 200 });
            }
            const m = u.match(/^https:\/\/api\.stripe\.com\/v1\/payment_intents\/(pi_[a-z0-9]+)/);
            if (m) return new Response(JSON.stringify(intents[m[1]]), { status: 200 });
            return realFetch(url, init);
        };
        const pay = async (n: number, amount: number) => {
            const pi = `pi_part${n}`;
            intents[pi] = { id: pi, status: 'succeeded', amount, amount_received: amount, currency: cur, metadata: { orderCode: order.code, huloPayLink: '1', huloPartial: '1' } };
            const ev = { id: `evt_part_${n}`, type: 'checkout.session.completed', data: { object: { id: `cs_${n}`, payment_intent: pi, amount_total: amount, currency: cur, metadata: { orderCode: order.code, huloPayLink: '1', huloPartial: '1' } } } };
            const body = JSON.stringify(ev);
            const t = Math.floor(Date.now() / 1000);
            const sig = `t=${t},v1=${createHmac('sha256', 'whsec_e2e').update(`${t}.${body}`).digest('hex')}`;
            const res = await fetch(`${BASE}/hulo-payments/webhook/hulo-stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
            expect(res.status).toBe(200);
        };
        const state = async () => (await adminClient.query(gql`query($c: String!) { orders(options: { filter: { code: { eq: $c } } }) { items { state payments { state amount } } } }`, { c: order.code }) as any).orders.items[0];
        try {
            // Over the remaining amount, or another currency: refused.
            await expect(svc.createPayLink(ctx, { orderCode: order.code, amount: order.totalWithTax + 1, currency: order.currencyCode, description: 'Too much' })).rejects.toMatchObject({ code: 'invalid-input' });
            await expect(svc.createPayLink(ctx, { orderCode: order.code, amount: deposit, currency: 'XXX', description: 'Bad' })).rejects.toMatchObject({ code: 'invalid-input' });
            const dep = await svc.createPayLink(ctx, { orderCode: order.code, amount: deposit, currency: order.currencyCode, description: 'Deposit for Q-1', reference: 'Q-1', metadata: { quotation: 'Q-1' } });
            expect(dep).toMatchObject({ url: 'https://checkout.stripe.test/1', ref: 'cs_1' });
            expect(sessions[0].get('line_items[0][price_data][unit_amount]')).toBe(String(deposit));
            expect(sessions[0].get('payment_intent_data[metadata][huloPartial]')).toBe('1');
            expect(sessions[0].get('payment_intent_data[metadata][quotation]')).toBe('Q-1');
            await pay(1, deposit);
            let o = await state();
            expect(o.state).toBe('ArrangingPayment');
            expect(o.payments.filter((p: any) => p.state === 'Settled').map((p: any) => p.amount)).toEqual([deposit]);
            // The balance: no amount left to over-pay.
            await expect(svc.createPayLink(ctx, { orderCode: order.code, amount: balance + 1, currency: order.currencyCode, description: 'Balance' })).rejects.toMatchObject({ code: 'invalid-input' });
            const bal = await svc.createPayLink(ctx, { orderCode: order.code, amount: balance, currency: order.currencyCode, description: 'Balance for Q-1', reference: 'Q-1' });
            expect(bal.ref).toBe('cs_2');
            await pay(2, balance);
            o = await state();
            expect(o.state).toBe('PaymentSettled');
            expect(o.payments.filter((p: any) => p.state === 'Settled').map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([deposit, balance].sort((a, b) => a - b));
            await expect(svc.createPayLink(ctx, { orderCode: order.code, currency: order.currencyCode, description: 'Again' })).rejects.toMatchObject({ code: 'order-not-payable' });
        } finally { (globalThis as any).fetch = realFetch; }
    });

    it('PayLinkService.createPayLink without an amount is a hosted-page link for the whole order', async () => {
        configureRuntime({ hasPremiumAccess: () => false });
        const shop = shopClient();
        const order = await orderToArrangingPayment(shop, 'whole@example.test');
        const svc = (server as any).app.get(PayLinkService) as PayLinkService;
        const ctx = await ((server as any).app.get(PaymentsService) as PaymentsService).adminCtx(1);
        const r = await svc.createPayLink(ctx, { orderCode: order.code, currency: order.currencyCode, description: 'Quote Q-2', reference: 'Q-2' });
        expect(r.url).toMatch(new RegExp(`^${BASE}/hulo-payments/pay/[a-f0-9]{48}$`));
        expect(r.ref).toMatch(/^hosted:\d+$/);
    });
});
