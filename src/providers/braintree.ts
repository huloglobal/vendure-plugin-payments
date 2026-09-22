import { Order, RequestContext } from '@vendure/core';
import { ClientSession, CredentialCheck, PaymentOutcome, PaymentProvider, ProviderArgs, SessionOptions, WebhookVerification } from '../core/provider';
import { request } from '../core/rest';
import { fromDecimalString, toDecimalString } from '../core/money';

export const BRAINTREE_CODE = 'hulo-braintree' as const;
const base = (args: ProviderArgs) => (String(args.environment) === 'live' ? 'https://payments.braintree-api.com/graphql' : 'https://payments.sandbox.braintree-api.com/graphql');

async function bt<T = any>(args: ProviderArgs, query: string, variables: any = {}): Promise<T> {
    const r = await request<any>('Braintree', base(args), { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${args.publicKey}:${args.privateKey}`).toString('base64')}`, 'braintree-version': '2024-06-01' }, json: { query, variables } });
    if (r.errors?.length) { const e: any = new Error(r.errors.map((x: any) => x.message).join('; ')); e.status = 400; e.body = r; throw e; }
    return r.data as T;
}

/**
 * Braintree (a PayPal service) through its GraphQL API: Drop-in UI with
 * cards, PayPal, Venmo, Apple Pay and Google Pay in the browser, charge or
 * authorise server-side, capture, void and refund. Transactions settle
 * synchronously so no webhook is required for the core flow.
 */
export const braintreeProvider: PaymentProvider = {
    code: BRAINTREE_CODE,
    name: 'Braintree',
    freeTier: false,
    capabilities: { session: true, manualCapture: true, partialCapture: true, refund: true, partialRefund: true, savedMethods: false, subscriptions: false, payByLink: false, disputes: false, wallets: ['paypal', 'venmo', 'apple_pay', 'google_pay'] },
    connectFields: ['environment', 'merchantId', 'publicKey', 'privateKey', 'captureMode'],
    publicConfig(args) { return { environment: String(args.environment) === 'live' ? 'production' : 'sandbox', merchantId: args.merchantId }; },
    dashboardLinks(args) {
        const live = String(args?.environment) === 'live';
        const d = live ? 'https://www.braintreegateway.com' : 'https://sandbox.braintreegateway.com';
        return { dashboard: d, keys: `${d}/login`, docs: 'https://developer.paypal.com/braintree/docs/start/hello-server' };
    },
    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.publicKey || !args.privateKey || !args.merchantId) return { ok: false, message: 'Merchant ID, public key and private key are all required (Settings → API keys).' };
        try {
            const d = await bt(args, `query { ping viewer { merchant { id name status } } }`);
            return { ok: true, message: `Connected to ${d.viewer?.merchant?.name || d.viewer?.merchant?.id || 'Braintree'} (${String(args.environment) === 'live' ? 'production' : 'sandbox'}).`, account: d.viewer?.merchant?.name, environment: String(args.environment) === 'live' ? 'production' : 'sandbox' };
        } catch (e: any) { return { ok: false, message: e.status === 401 ? 'Braintree rejected the API keys.' : e.message }; }
    },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession> {
        const d = await bt(args, `mutation ($input: CreateClientTokenInput) { createClientToken(input: $input) { clientToken } }`, { input: { clientToken: { merchantAccountId: args.merchantAccountId || undefined } } });
        return { provider: BRAINTREE_CODE, flow: 'braintree-dropin', clientSecret: d.createClientToken.clientToken, environment: this.publicConfig(args).environment, config: { currency: order.currencyCode, vault: !!opts.savePaymentMethod }, amount: order.totalWithTax, currency: order.currencyCode };
    },
    /** The browser hands back a payment method nonce; the transaction is created here. */
    async confirmPayment(_ctx, order, args, metadata): Promise<PaymentOutcome> {
        const nonce = String(metadata?.nonce || '');
        if (metadata?.transactionId && !nonce) {
            const d = await bt(args, `query ($id: ID!) { node(id: $id) { ... on Transaction { id status amount { value currencyCode } orderId } } }`, { id: metadata.transactionId });
            return outcome(d.node, order);
        }
        if (!nonce) return { state: 'Error', amount: 0, errorMessage: 'Missing Braintree payment nonce' };
        const manual = args.captureMode === 'manual';
        const q = manual
            ? `mutation ($input: AuthorizePaymentMethodInput!) { authorizePaymentMethod(input: $input) { transaction { id status amount { value currencyCode } orderId } } }`
            : `mutation ($input: ChargePaymentMethodInput!) { chargePaymentMethod(input: $input) { transaction { id status amount { value currencyCode } orderId } } }`;
        const d = await bt(args, q, { input: { paymentMethodId: nonce, transaction: { amount: toDecimalString(order.totalWithTax, order.currencyCode), orderId: order.code, merchantAccountId: args.merchantAccountId || undefined, riskData: metadata?.deviceData ? { deviceData: metadata.deviceData } : undefined } } });
        return outcome((d.authorizePaymentMethod || d.chargePaymentMethod).transaction, order);
    },
    async capture(args, paymentRef, amount, currency) {
        try { await bt(args, `mutation ($input: CaptureTransactionInput!) { captureTransaction(input: $input) { transaction { id status } } }`, { input: { transactionId: paymentRef, transaction: { amount: toDecimalString(amount, currency) } } }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },
    async cancel(args, paymentRef) {
        try { await bt(args, `mutation ($input: ReverseTransactionInput!) { reverseTransaction(input: $input) { reversal { ... on Transaction { id status } ... on Refund { id status } } } }`, { input: { transactionId: paymentRef } }); return { success: true }; }
        catch (e: any) { return { success: false, errorMessage: e.message }; }
    },
    async refund(args, paymentRef, amount, currency, reason) {
        const d = await bt(args, `mutation ($input: RefundTransactionInput!) { refundTransaction(input: $input) { refund { id status } } }`, { input: { transactionId: paymentRef, refund: { amount: toDecimalString(amount, currency), orderId: reason ? String(reason).slice(0, 50) : undefined } } });
        const st = d.refundTransaction?.refund?.status;
        return { state: ['SETTLED', 'SETTLING', 'SUBMITTED_FOR_SETTLEMENT'].includes(st) ? 'Settled' : st === 'FAILED' || st === 'GATEWAY_REJECTED' ? 'Failed' : 'Pending', transactionId: d.refundTransaction?.refund?.id, metadata: { status: st } };
    },
    async verifyWebhook(): Promise<WebhookVerification> {
        return { ok: false, events: [], error: 'Braintree transactions settle synchronously; disputes and settlement changes are visible in the Braintree control panel' };
    },
};

function outcome(t: any, order: Order): PaymentOutcome {
    if (!t) return { state: 'Error', amount: 0, errorMessage: 'Braintree returned no transaction' };
    if (t.orderId && t.orderId !== order.code) return { state: 'Error', amount: 0, errorMessage: 'Transaction belongs to a different order' };
    const amount = t.amount?.value ? fromDecimalString(t.amount.value, order.currencyCode) : order.totalWithTax;
    const meta = { transactionId: t.id, public: { method: 'braintree' } };
    if (['SUBMITTED_FOR_SETTLEMENT', 'SETTLING', 'SETTLED', 'SETTLEMENT_PENDING'].includes(t.status)) return { state: 'Settled', amount, transactionId: t.id, metadata: meta };
    if (t.status === 'AUTHORIZED') return { state: 'Authorized', amount, transactionId: t.id, metadata: { ...meta, capture: 'manual' } };
    return { state: 'Declined', amount: 0, transactionId: t.id, errorMessage: `Braintree transaction ${t.status}`, metadata: meta };
}
