import { PluginCommonModule, RuntimeVendureConfig, Type, VendurePlugin, TransactionalConnection } from '@vendure/core';
import {
    fingerprintPublicKey, Heartbeat, LicenceStatus, RevocationChecker, UpdateChecker, verifyLicence,
    warnIfIncompatibleVendure, EvaluationClient, EvaluationState, LicenceStore, adapterFor,
} from '@huloglobal/vendure-licence-sdk';

import { HuloPaymentsLicenceService, PLUGIN_ID } from './licence.service';
import { HuloPaymentsLicenceController } from './licence.controller';
import { LedgerService } from './core/ledger.service';
import { PaymentsService } from './core/payments.service';
import { WebhookController, webhookRawBodyMiddleware } from './core/webhook.controller';
import { HuloPaymentsAdminController } from './core/admin.controller';
import { HostedCheckoutController } from './core/hosted.controller';
import { HostedCheckoutService } from './core/hosted.service';
import { HuloPaymentsShopResolver, shopApiExtensions } from './core/shop-api';
import { huloPaymentRulesChecker } from './core/eligibility';
import { makeHandler } from './core/handlers';
import { allProviders, registerProvider } from './core/provider';
import { configureRuntime } from './core/runtime';
import { stripeProvider } from './providers/stripe';
import { adyenProvider } from './providers/adyen';
import { paypalProvider } from './providers/paypal';
import { mollieProvider } from './providers/mollie';
import { squareProvider } from './providers/square';
import { braintreeProvider } from './providers/braintree';
import { gocardlessProvider } from './providers/gocardless';
import { checkoutComProvider } from './providers/checkout-com';
import { coinbaseProvider } from './providers/coinbase';
import { bankTransferProvider, payLaterProvider } from './providers/offline';
import { SubscriptionService } from './subscriptions/subscription.service';
import { SubscriptionCron } from './subscriptions/subscription.cron';
import { registerSubscriptionCustomFields } from './subscriptions/custom-fields';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../package.json').version;
const PKG_NAME = '@huloglobal/vendure-plugin-payments';

export interface HuloPaymentsPluginOptions {
    /** Public origin of the Vendure server, e.g. https://shop.example.com — used for
     *  webhook URLs, pay-by-link return pages and licence domain matching. */
    publicBaseUrl: string;
    /** JWT licence key from huloglobal.com. Without it the plugin runs in the
     *  FREE tier after the 14-day evaluation: Stripe, the ledger and the
     *  dashboard stay on; Adyen, PayPal, Mollie, subscriptions, saved cards,
     *  pay-by-link, routing and surcharges need a licence. */
    licenceKey?: string;
    /** Where disputes and failed renewals are reported. */
    ops?: {
        /** Signed JSON POST (Slack/Discord/Teams-compatible payload: { text }). */
        webhookUrl?: string;
        /** Email via SMTP_* env (uses nodemailer when the host has it). */
        email?: string;
    };
    /** Disable the hourly renewal scheduler (e.g. hosts running it elsewhere). */
    disableScheduler?: boolean;
}

const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoLmNM5UljRqe71drM6lR
Ba5vXrLOcV3GAHkYvnVFQSqdE0avrge/jsD7WdA6x8qQFNRugxQcxDJa2l0+C+BH
SbU9TimGwhA1yusHHfuz9LAXks5IQ48+2e6Pulh7iThXPJUnIKqKZUN5HhL79aaK
vrZKIgSfVhwE5PMPXWZ+Ij5IRf74PLIUn1Er75qhBXlDJ4vF8y8/3owURNC1XiUB
DGElwV/LYNoqAQei4oixe4EAxPGvFi11pgHiGuRxuWckA88y6ZHLt6urfAY9sCkj
kF+2dc2yS3j7lD+SYAaV5LQYYjePP1CYvxCZ7HHRKqthHopxY1hsK2tBtni3f7/c
UwIDAQAB
-----END PUBLIC KEY-----`;

const REVOCATION_URL = process.env.HULO_LICENCE_REVOCATION_URL || 'https://elite.charity/licence/revoked.json';

let cachedOptions: HuloPaymentsPluginOptions = { publicBaseUrl: 'http://localhost:3000' };
export function getOptions(): HuloPaymentsPluginOptions { return cachedOptions; }

for (const p of [stripeProvider, adyenProvider, paypalProvider, mollieProvider, squareProvider, braintreeProvider, gocardlessProvider, checkoutComProvider, coinbaseProvider, bankTransferProvider, payLaterProvider]) registerProvider(p);

async function notifyOps(event: { kind: string; subject: string; text: string; orderCode?: string; channelId?: number | null }): Promise<void> {
    const ops = getOptions().ops || {};
    // eslint-disable-next-line no-console
    console.warn(`[${PKG_NAME}] ${event.kind}: ${event.subject} — ${event.text}`);
    if (ops.webhookUrl) {
        try {
            await (globalThis as any).fetch(ops.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*${event.subject}*\n${event.text}`, kind: event.kind, orderCode: event.orderCode, source: PKG_NAME }) });
        } catch { /* alerts never break payments */ }
    }
    if (ops.email && process.env.SMTP_SERVER && process.env.SMTP_USER) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const nodemailer = require('nodemailer');
            const port = Number(process.env.SMTP_PORT || 587);
            const transporter = nodemailer.createTransport({ host: process.env.SMTP_SERVER, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
            await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: ops.email, subject: `[Payments] ${event.subject}`, text: event.text });
        } catch { /* nodemailer missing or SMTP down */ }
    }
}

/**
 * `@huloglobal/vendure-plugin-payments`
 *
 * One payments plugin for Vendure. Stripe, Adyen, PayPal and Mollie behind
 * a single contract: hosted / embedded sessions with wallets and 3-D
 * Secure, automatic or manual capture, partial captures and refunds,
 * disputes, saved cards, subscriptions (native or scheduler-billed),
 * pay-by-link for any unpaid order, eligibility rules and surcharges,
 * provider routing with fallback, signed idempotent webhooks, and a ledger
 * every provider writes to — with a dashboard on top.
 *
 * @docsCategory Plugin
 * @category Plugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [HuloPaymentsLicenceController, WebhookController, HuloPaymentsAdminController, HostedCheckoutController],
    providers: [HuloPaymentsLicenceService, LedgerService, SubscriptionService, PaymentsService, SubscriptionCron, HostedCheckoutService],
    shopApiExtensions: { schema: shopApiExtensions, resolvers: [HuloPaymentsShopResolver] },
    compatibility: '>=3.5.0 <4.0.0',
    configuration: (config: RuntimeVendureConfig) => {
        const handlers = config.paymentOptions.paymentMethodHandlers;
        for (const p of allProviders()) {
            if (!handlers.some(h => h.code === p.code)) handlers.push(makeHandler(p));
        }
        const checkers = config.paymentOptions.paymentMethodEligibilityCheckers || [];
        if (!checkers.some(c => c.code === huloPaymentRulesChecker.code)) checkers.push(huloPaymentRulesChecker);
        config.paymentOptions.paymentMethodEligibilityCheckers = checkers;
        registerSubscriptionCustomFields(config);
        config.apiOptions.middleware = [...(config.apiOptions.middleware || []), webhookRawBodyMiddleware];
        return config;
    },
})
export class HuloPaymentsPlugin {
    private static evalClientInternal: EvaluationClient | null = null;
    static getEvalState(): EvaluationState | null { return HuloPaymentsPlugin.evalClientInternal?.getState() ?? null; }
    static getEvalInstanceId(): string | null { return HuloPaymentsPlugin.evalClientInternal?.getInstanceId() ?? null; }

    static hasPremiumAccess(): boolean {
        if (HuloPaymentsPlugin.licenceStatus?.valid) return true;
        return !!HuloPaymentsPlugin.evalClientInternal?.getState()?.active;
    }
    static isLicensed(): boolean { return !!HuloPaymentsPlugin.licenceStatus?.valid; }

    static startEvaluation(): void {
        if (!HuloPaymentsPlugin.evalClientInternal) {
            HuloPaymentsPlugin.evalClientInternal = new EvaluationClient({ packageName: PKG_NAME, packageVersion: PKG_VERSION });
            HuloPaymentsPlugin.evalClientInternal.start();
        }
    }

    private static licenceHost = '';

    static activateRuntimeLicence(key: string): LicenceStatus {
        const status = verifyLicence({ licenceKey: key, pluginId: PLUGIN_ID, host: HuloPaymentsPlugin.licenceHost, publicKey: HULO_PUBLIC_KEY, revokedIds: HuloPaymentsPlugin.revocation?.getRevokedIds() });
        if (status.valid) { HuloPaymentsPlugin.licenceStatus = status; HuloPaymentsPlugin.evalClientInternal?.stop(); }
        return status;
    }

    static deactivateRuntimeLicence(): void {
        HuloPaymentsPlugin.licenceStatus = { valid: false, message: 'No licence key configured. The plugin will run in the free tier.' } as LicenceStatus;
        HuloPaymentsPlugin.startEvaluation();
        HuloPaymentsPlugin.evalClientInternal?.start();
    }

    constructor(private connection: TransactionalConnection) {}

    async onApplicationBootstrap() {
        if (HuloPaymentsPlugin.licenceStatus?.valid) return;
        try {
            const store = new LicenceStore((sql, params) => adapterFor(this.connection.rawConnection).query(sql, params));
            await store.ensureTable();
            const stored = await store.load(PLUGIN_ID);
            if (stored) {
                const st = HuloPaymentsPlugin.activateRuntimeLicence(stored);
                // eslint-disable-next-line no-console
                if (st.valid) console.log(`[${PKG_NAME}] licence restored from admin activation — ${st.message}`);
            }
        } catch { /* store failures never affect boot */ }
    }

    private static revocation: RevocationChecker | null = null;
    private static updateChecker: UpdateChecker | null = null;
    private static heartbeat: Heartbeat | null = null;
    private static licenceStatus: LicenceStatus | null = null;

    static getUpdateChecker(): UpdateChecker | null { return HuloPaymentsPlugin.updateChecker; }
    static getPackageVersion(): string { return PKG_VERSION; }
    static getPackageName(): string { return PKG_NAME; }
    static getLicenceStatus(): LicenceStatus | null { return HuloPaymentsPlugin.licenceStatus; }

    static init(options: HuloPaymentsPluginOptions): Type<HuloPaymentsPlugin> {
        cachedOptions = { ...options };
        warnIfIncompatibleVendure({ pluginPackageName: PKG_NAME, pluginPackageVersion: PKG_VERSION, supportedRange: { min: '3.5.0', max: '4.0.0' } });
        if (!HuloPaymentsPlugin.revocation) { HuloPaymentsPlugin.revocation = new RevocationChecker(REVOCATION_URL); HuloPaymentsPlugin.revocation.start(); }
        if (!HuloPaymentsPlugin.updateChecker) { HuloPaymentsPlugin.updateChecker = new UpdateChecker(PKG_NAME, PKG_VERSION); HuloPaymentsPlugin.updateChecker.start(); }
        const host = (options.publicBaseUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        HuloPaymentsPlugin.licenceHost = host;
        const status = verifyLicence({ licenceKey: options.licenceKey, pluginId: PLUGIN_ID, host, publicKey: HULO_PUBLIC_KEY, revokedIds: HuloPaymentsPlugin.revocation.getRevokedIds() });
        HuloPaymentsPlugin.licenceStatus = status;
        if (!status.valid) {
            HuloPaymentsPlugin.startEvaluation();
            // eslint-disable-next-line no-console
            console.warn(`[${PKG_NAME}] ${status.message} — Running in FREE tier after the 14-day evaluation: Stripe, the ledger and the dashboard stay on; Adyen, PayPal, Mollie, subscriptions, saved cards, pay-by-link, routing and surcharges need a licence. Buy at https://elite.charity/licence/buy/${PLUGIN_ID}`);
        }
        if (!HuloPaymentsPlugin.heartbeat) {
            HuloPaymentsPlugin.heartbeat = new Heartbeat({ packageName: PKG_NAME, packageVersion: PKG_VERSION, licenceKey: options.licenceKey, publicKeyFingerprint: fingerprintPublicKey(HULO_PUBLIC_KEY) });
            HuloPaymentsPlugin.heartbeat.start();
        }
        configureRuntime({ hasPremiumAccess: () => HuloPaymentsPlugin.hasPremiumAccess(), publicBaseUrl: () => getOptions().publicBaseUrl, notifyOps });
        return HuloPaymentsPlugin;
    }

    static uiExtensions = {
        extensionPath: __dirname + '/../ui',
        ngModules: [
            { type: 'lazy' as const, route: 'hulo-payments', ngModuleFileName: 'hulo-payments.module.ts', ngModuleName: 'HuloPaymentsModule' },
            { type: 'shared' as const, ngModuleFileName: 'hulo-payments-shared.module.ts', ngModuleName: 'HuloPaymentsSharedModule' },
        ],
    };
}
