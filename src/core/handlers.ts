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

/** Handler args per provider — these are the credentials admins fill in on the PaymentMethod. */
export const HANDLER_ARGS: Record<ProviderCode, ConfigArgs> = {
    'hulo-stripe': {
        secretKey: secret('Secret key', 'sk_live_… / sk_test_…'),
        publishableKey: text('Publishable key', 'pk_live_… / pk_test_… (sent to the browser)'),
        webhookSecret: secret('Webhook signing secret', 'whsec_… for the endpoint /hulo-payments/webhook/hulo-stripe'),
        captureMethod: select('Capture', ['automatic', 'manual'], 'automatic', 'manual = authorise now, settle later from the order'),
        paymentMethodTypes: text('Payment method types', 'Leave empty for automatic (Stripe dashboard decides); or e.g. card,link,klarna'),
        statementDescriptorSuffix: text('Statement descriptor suffix', 'Up to 22 characters shown on card statements'),
    },
    'hulo-adyen': {
        apiKey: secret('API key', 'Checkout API key from the Customer Area'),
        merchantAccount: text('Merchant account'),
        clientKey: text('Client key', 'Public key for Drop-in / Components (sent to the browser)'),
        hmacKey: secret('Webhook HMAC key', 'Hex key from the standard webhook settings'),
        environment: select('Environment', ['test', 'live'], 'test'),
        liveUrlPrefix: text('Live URL prefix', 'e.g. 1797a841fbb37ca7-AdyenDemo (live only)'),
        captureMode: select('Capture', ['immediate', 'manual'], 'immediate', 'manual = captureDelayHours −1; settle from the order'),
        webhookUser: text('Webhook basic-auth user', 'Optional'),
        webhookPassword: secret('Webhook basic-auth password', 'Optional'),
    },
    'hulo-paypal': {
        clientId: text('Client ID', 'REST app client id (sent to the browser)'),
        clientSecret: secret('Client secret'),
        environment: select('Environment', ['sandbox', 'live'], 'sandbox'),
        intent: select('Intent', ['CAPTURE', 'AUTHORIZE'], 'CAPTURE', 'AUTHORIZE = hold funds, capture from the order'),
        webhookId: text('Webhook ID', 'From the REST app webhook for /hulo-payments/webhook/hulo-paypal'),
        brandName: text('Brand name', 'Shown on the PayPal approval page'),
    },
    'hulo-mollie': {
        apiKey: secret('API key', 'live_… / test_…'),
        profileId: text('Profile ID', 'pfl_… (optional, for Mollie Components)'),
        method: text('Restrict to methods', 'Optional comma list, e.g. ideal,creditcard,bancontact'),
        captureMode: select('Capture', ['automatic', 'manual'], 'automatic', 'manual = authorise (cards/Klarna) and capture from the order'),
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
        description: label(`${provider.name} (HULO Payments)`),
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
