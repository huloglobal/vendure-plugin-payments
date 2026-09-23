import {
    CancelPaymentErrorResult, CancelPaymentResult, CreatePaymentErrorResult, CreatePaymentResult, CreateRefundResult, Injector,
    LanguageCode, Logger, PaymentMethodHandler, SettlePaymentErrorResult, SettlePaymentResult,
} from '@vendure/core';
import { ConfigArgs } from '@vendure/core/dist/common/configurable-operation';
import { PaymentProvider, ProviderArgs, ProviderCode } from './provider';
import { LedgerService, loggerCtx } from './ledger.service';
import { getRuntime } from './runtime';

let ledger: LedgerService | null = null;

/** Payment ids a verified webhook has already confirmed as settled; the
 *  handler's settle step trusts these instead of re-capturing. */
const confirmedByWebhook = new Set<string>();
export function markSettledByWebhook(paymentId: string | number): void { confirmedByWebhook.add(String(paymentId)); }

const label = (v: string) => [{ languageCode: LanguageCode.en, value: v }];
const secret = (l: string, d?: string) => ({ type: 'string' as const, label: label(l), description: d ? label(d) : undefined, ui: { component: 'password-form-input' } });
const text = (l: string, d?: string, defaultValue = '') => ({ type: 'string' as const, label: label(l), description: d ? label(d) : undefined, defaultValue });
const select = (l: string, options: string[], defaultValue: string, d?: string) => ({
    type: 'string' as const, label: label(l), description: d ? label(d) : undefined, defaultValue,
    ui: { component: 'select-form-input', options: options.map(o => ({ value: o, label: label(o) })) },
});

/** What admins see in the "Payment handler" dropdown. */
export const HANDLER_DESCRIPTIONS: Record<ProviderCode, string> = {
    'hulo-stripe': 'HULO Payments — Stripe (cards, Apple Pay, Google Pay, Link, Klarna; refunds, holds, subscriptions)',
    'hulo-adyen': 'HULO Payments — Adyen (cards, wallets, iDEAL, Klarna + 100 local methods; captures, refunds, tokenised subscriptions)',
    'hulo-paypal': 'HULO Payments — PayPal (PayPal, Pay Later, Venmo; authorise or capture, refunds, subscriptions)',
    'hulo-mollie': 'HULO Payments — Mollie (iDEAL, cards, Bancontact, SEPA, Klarna; refunds, subscriptions)',
    'hulo-square': 'HULO Payments — Square (cards, Apple Pay, Google Pay, Cash App Pay, Afterpay; holds, refunds, payment links)',
    'hulo-braintree': 'HULO Payments — Braintree (cards, PayPal, Venmo, Apple Pay, Google Pay; holds, refunds)',
    'hulo-gocardless': 'HULO Payments — GoCardless (Bacs, SEPA, ACH direct debit, Instant Bank Pay; subscriptions)',
    'hulo-checkout-com': 'HULO Payments — Checkout.com (hosted page: cards, wallets, Klarna, iDEAL; holds, refunds, payment links)',
    'hulo-coinbase': 'HULO Payments — Coinbase Commerce (Bitcoin, Ethereum, USDC and other crypto)',
    'hulo-bank-transfer': 'HULO Payments — Bank transfer (customer pays by bank, settle from the order page)',
    'hulo-pay-later': 'HULO Payments — Pay later / invoice (on account, due in N days)',
};

/** Short names for payment methods the plugin creates itself ("Provider · what customers pay with"). */
export const HANDLER_SHORT_NAMES: Record<ProviderCode, string> = {
    'hulo-stripe': 'Stripe · cards, Apple Pay, Google Pay, Link',
    'hulo-adyen': 'Adyen · cards, wallets & 100+ local methods',
    'hulo-paypal': 'PayPal · PayPal, Pay Later, Venmo',
    'hulo-mollie': 'Mollie · iDEAL, cards, Bancontact, SEPA, Klarna',
    'hulo-square': 'Square · cards, Apple Pay, Google Pay, Cash App, Afterpay',
    'hulo-braintree': 'Braintree · cards, PayPal, Venmo, wallets',
    'hulo-gocardless': 'GoCardless · Bacs, SEPA & ACH direct debit',
    'hulo-checkout-com': 'Checkout.com · hosted page: cards, wallets, Klarna, iDEAL',
    'hulo-coinbase': 'Coinbase Commerce · Bitcoin, Ethereum, USDC',
    'hulo-bank-transfer': 'Bank transfer · pay from your bank, order reserved',
    'hulo-pay-later': 'Pay later / invoice · on account, due in 30 days',
};

/** Handler args per provider — these are the credentials admins fill in on the PaymentMethod. */
export const HANDLER_ARGS: Record<ProviderCode, ConfigArgs> = {
    'hulo-stripe': {
        secretKey: secret('Secret key', 'Stripe Dashboard → Developers → API keys. Starts sk_live_ (or sk_test_ for testing).'),
        publishableKey: text('Publishable key', 'Same page, starts pk_live_ / pk_test_. Safe to send to the browser.'),
        webhookSecret: secret('Webhook signing secret', 'Developers → Webhooks → add endpoint <your server>/hulo-payments/webhook/hulo-stripe, then copy its whsec_… secret here. The Payments page shows the exact URL.'),
        captureMethod: select('Capture', ['automatic', 'manual'], 'automatic', 'automatic = take the money immediately (most shops). manual = reserve now and settle from the order page within 7 days.'),
        paymentMethodTypes: text('Payment method types', 'Leave empty and Stripe shows whatever is enabled in your dashboard. Or restrict, e.g. card,link,klarna.'),
        statementDescriptorSuffix: text('Statement descriptor suffix', 'Optional. Up to 22 characters appended on the customer\'s card statement.'),
    },
    'hulo-adyen': {
        apiKey: secret('API key', 'Customer Area → Developers → API credentials → your web service user → API key.'),
        merchantAccount: text('Merchant account', 'Customer Area → Account → Merchant accounts (e.g. YourCompanyECOM).'),
        clientKey: text('Client key', 'Same API credential page → Client key. Add your storefront origin to its allowed origins. Safe to send to the browser.'),
        hmacKey: secret('Webhook HMAC key', 'Developers → Webhooks → Standard webhook → URL <your server>/hulo-payments/webhook/hulo-adyen → generate HMAC key and paste the hex here.'),
        environment: select('Environment', ['test', 'live'], 'test', 'test = test Customer Area credentials; live = production.'),
        liveUrlPrefix: text('Live URL prefix', 'Live only: Customer Area → Developers → API URLs, the part before -checkout-live.adyenpayments.com.'),
        captureMode: select('Capture', ['immediate', 'manual'], 'immediate', 'immediate = take the money on authorisation. manual = reserve now and settle from the order page.'),
        webhookUser: text('Webhook basic-auth user', 'Optional: if you set basic auth on the Adyen webhook, mirror it here.'),
        webhookPassword: secret('Webhook basic-auth password', 'Optional, pairs with the user above.'),
    },
    'hulo-paypal': {
        clientId: text('Client ID', 'developer.paypal.com → Apps & Credentials → your REST app → Client ID. Safe to send to the browser.'),
        clientSecret: secret('Client secret', 'Same app → Secret.'),
        environment: select('Environment', ['sandbox', 'live'], 'sandbox', 'sandbox = test credentials; live = production app.'),
        intent: select('Intent', ['CAPTURE', 'AUTHORIZE'], 'CAPTURE', 'CAPTURE = take the money immediately. AUTHORIZE = hold funds and settle from the order page.'),
        webhookId: text('Webhook ID', 'Same app → Webhooks → add <your server>/hulo-payments/webhook/hulo-paypal with all payment, dispute and billing events → paste its ID.'),
        brandName: text('Brand name', 'Shown to the customer on the PayPal approval page.'),
    },
    'hulo-square': {
        environment: select('Environment', ['sandbox', 'live'], 'sandbox', 'sandbox = developer.squareup.com sandbox credentials; live = production.'),
        accessToken: secret('Access token', 'developer.squareup.com → your application → Credentials → Access token.'),
        applicationId: text('Application ID', 'Same page → Application ID. Safe to send to the browser.'),
        locationId: text('Location ID', 'Same application → Locations, or Square Dashboard → Account & Settings → Locations.'),
        captureMode: select('Capture', ['automatic', 'manual'], 'automatic', 'automatic = take the money immediately. manual = reserve now and settle from the order page within 7 days.'),
        webhookSignatureKey: secret('Webhook signature key', 'Filled in by Connect; or Developer Dashboard → Webhooks → your subscription → Signature key.'),
    },
    'hulo-braintree': {
        environment: select('Environment', ['sandbox', 'live'], 'sandbox', 'sandbox = sandbox.braintreegateway.com keys; live = production.'),
        merchantId: text('Merchant ID', 'Braintree Control Panel → Settings → API → Merchant ID.'),
        publicKey: text('Public key', 'Same page → Public key.'),
        privateKey: secret('Private key', 'Same page → Private key.'),
        merchantAccountId: text('Merchant account ID', 'Optional: a specific merchant account (currency) to transact on.'),
        captureMode: select('Capture', ['automatic', 'manual'], 'automatic', 'automatic = charge immediately. manual = authorise and settle from the order page.'),
    },
    'hulo-gocardless': {
        environment: select('Environment', ['sandbox', 'live'], 'sandbox', 'sandbox = manage-sandbox.gocardless.com; live = production.'),
        accessToken: secret('Access token', 'GoCardless dashboard → Developers → Create → Access token (read-write).'),
        webhookSecret: secret('Webhook secret', 'Developers → Webhook endpoints → add <your server>/hulo-payments/webhook/hulo-gocardless → copy its secret here.'),
    },
    'hulo-checkout-com': {
        environment: select('Environment', ['sandbox', 'live'], 'sandbox', 'sandbox = dashboard.sandbox.checkout.com keys; live = production.'),
        secretKey: secret('Secret key', 'Dashboard → Developers → Keys → secret key (sk_…).'),
        publicKey: text('Public key', 'Same page → public key (pk_…). Safe to send to the browser.'),
        processingChannelId: text('Processing channel ID', 'Dashboard → Settings → Channels (pc_…).'),
        captureMode: select('Capture', ['automatic', 'manual'], 'automatic', 'automatic = capture on authorisation. manual = settle from the order page.'),
        webhookSecret: secret('Webhook signature key', 'Filled in by Connect (a workflow with an HMAC signature); or set it on the workflow webhook action yourself.'),
    },
    'hulo-coinbase': {
        apiKey: secret('API key', 'Coinbase Commerce → Settings → Security → API keys.'),
        webhookSharedSecret: secret('Webhook shared secret', 'Settings → Notifications → add <your server>/hulo-payments/webhook/hulo-coinbase → shared secret.'),
    },
    'hulo-bank-transfer': {
        accountName: text('Account name', 'The payee name customers should use.'),
        sortCode: text('Sort code', 'UK accounts; leave empty if using IBAN only.'),
        accountNumber: text('Account number', 'UK accounts; leave empty if using IBAN only.'),
        iban: text('IBAN', 'For international customers.'),
        bic: text('BIC / SWIFT', 'For international customers.'),
        instructions: text('Extra instructions', 'Optional text shown with the bank details. {{orderCode}} is replaced with the order code.'),
    },
    'hulo-pay-later': {
        termsDays: text('Payment terms (days)', 'How many days after the order the invoice is due.', '30'),
        instructions: text('Instructions', 'Optional text shown to the customer. {{orderCode}}, {{dueDate}} and {{termsDays}} are replaced.'),
    },
    'hulo-mollie': {
        apiKey: secret('API key', 'Mollie Dashboard → Developers → API keys. Starts live_ (or test_ for testing).'),
        profileId: text('Profile ID', 'Optional, pfl_… from the same page; only needed for Mollie Components.'),
        method: text('Restrict to methods', 'Leave empty to offer every method enabled in Mollie, or list some, e.g. ideal,creditcard,bancontact.'),
        captureMode: select('Capture', ['automatic', 'manual'], 'automatic', 'automatic = take the money immediately. manual = authorise (cards, Klarna) and settle from the order page.'),
    },
};

/**
 * One Vendure PaymentMethodHandler per provider, all delegating to the
 * provider contract. The handler is where the customer's client-side
 * result meets a server-side verification, and where every outcome is
 * written to the ledger.
 */
export function makeHandler(provider: PaymentProvider): PaymentMethodHandler {
    return new PaymentMethodHandler({
        code: provider.code,
        description: label(HANDLER_DESCRIPTIONS[provider.code]),
        args: HANDLER_ARGS[provider.code] as any,

        init(injector: Injector) {
            try { ledger = injector.get(LedgerService); } catch { ledger = null; }
        },

        async createPayment(ctx, order, amount, args, metadata): Promise<CreatePaymentResult | CreatePaymentErrorResult> {
            if (!provider.freeTier && !getRuntime().hasPremiumAccess()) {
                return { amount, state: 'Error', errorMessage: `${provider.name} needs a HULO Payments licence`, metadata };
            }
            let outcome;
            try {
                outcome = await provider.confirmPayment(ctx, order, args as ProviderArgs, metadata || {});
            } catch (e: any) {
                Logger.error(`${provider.code} confirmPayment failed for ${order.code}: ${e.message}`, loggerCtx);
                await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'failure', status: 'failed', orderId: order.id as number, orderCode: order.code, amount, currency: order.currencyCode, reason: e.message });
                return { amount, state: 'Error', errorMessage: e.message, metadata };
            }
            const meta: Record<string, any> = { ...(outcome.metadata || {}), provider: provider.code };
            if (outcome.state === 'Settled' || outcome.state === 'Authorized') {
                await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: outcome.state === 'Settled' ? 'capture' : 'authorize', status: 'ok', orderId: order.id as number, orderCode: order.code, paymentRef: outcome.transactionId, amount: outcome.amount, currency: order.currencyCode, meta: { method: meta.public?.method } });
                return { amount: outcome.amount, state: outcome.state, transactionId: outcome.transactionId, metadata: meta };
            }
            await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'failure', status: 'failed', orderId: order.id as number, orderCode: order.code, paymentRef: outcome.transactionId, amount, currency: order.currencyCode, reason: outcome.errorMessage });
            if (outcome.state === 'Declined') return { amount, state: 'Declined', transactionId: outcome.transactionId, errorMessage: outcome.errorMessage, metadata: meta };
            return { amount, state: 'Error', transactionId: outcome.transactionId, errorMessage: outcome.errorMessage || `${provider.name} could not confirm the payment`, metadata: meta };
        },

        async settlePayment(ctx, order, payment, args): Promise<SettlePaymentResult | SettlePaymentErrorResult> {
            const meta: any = payment.metadata || {};
            if (confirmedByWebhook.has(String(payment.id))) {
                confirmedByWebhook.delete(String(payment.id));
                await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'capture', status: 'ok', orderId: order.id as number, orderCode: order.code, paymentRef: payment.transactionId, amount: payment.amount, currency: order.currencyCode, meta: { via: 'webhook' } });
                return { success: true };
            }
            if (meta.capture === 'manual') {
                const r = await provider.capture(args as ProviderArgs, payment.transactionId, payment.amount, order.currencyCode, meta);
                await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'capture', status: r.success ? 'ok' : 'failed', orderId: order.id as number, orderCode: order.code, paymentRef: payment.transactionId, amount: payment.amount, currency: order.currencyCode, reason: r.errorMessage, meta: { via: 'manual-capture' } });
                return r.success ? { success: true } : { success: false, state: 'Authorized', errorMessage: r.errorMessage };
            }
            // Automatic-capture payment still marked pending/processing: ask the provider.
            const probe = { paymentIntentId: payment.transactionId, molliePaymentId: payment.transactionId, paypalOrderId: meta.paypalOrderId, sessionId: meta.sessionId, sessionResult: meta.sessionResult };
            try {
                const o = await provider.confirmPayment(ctx, order, args as ProviderArgs, probe);
                if (o.state === 'Settled') {
                    await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'capture', status: 'ok', orderId: order.id as number, orderCode: order.code, paymentRef: payment.transactionId, amount: payment.amount, currency: order.currencyCode, meta: { via: 'settle-check' } });
                    return { success: true };
                }
                return { success: false, state: 'Authorized', errorMessage: o.errorMessage || `${provider.name} has not settled this payment yet` };
            } catch (e: any) {
                return { success: false, state: 'Authorized', errorMessage: e.message };
            }
        },

        async cancelPayment(ctx, order, payment, args): Promise<CancelPaymentResult | CancelPaymentErrorResult> {
            const r = await provider.cancel(args as ProviderArgs, payment.transactionId, payment.metadata || {});
            await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'cancel', status: r.success ? 'ok' : 'failed', orderId: order.id as number, orderCode: order.code, paymentRef: payment.transactionId, amount: payment.amount, currency: order.currencyCode, reason: r.errorMessage });
            return r.success ? { success: true } : { success: false, errorMessage: r.errorMessage };
        },

        async createRefund(ctx, input, amount, order, payment, args): Promise<CreateRefundResult> {
            try {
                const r = await provider.refund(args as ProviderArgs, payment.transactionId, amount, order.currencyCode, String(input.reason || ''), payment.metadata || {});
                await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'refund', status: r.state === 'Settled' ? 'ok' : r.state === 'Failed' ? 'failed' : 'pending', orderId: order.id as number, orderCode: order.code, paymentRef: r.transactionId || payment.transactionId, amount, currency: order.currencyCode, reason: input.reason || null, meta: r.metadata || null });
                return { state: r.state, transactionId: r.transactionId, metadata: r.metadata };
            } catch (e: any) {
                await ledger?.record({ channelId: ctx.channelId as number, provider: provider.code, kind: 'refund', status: 'failed', orderId: order.id as number, orderCode: order.code, paymentRef: payment.transactionId, amount, currency: order.currencyCode, reason: e.message });
                return { state: 'Failed', metadata: { error: e.message } };
            }
        },
    });
}
