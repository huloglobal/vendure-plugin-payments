import { DigestStat } from '@huloglobal/vendure-licence-sdk';
import { ResolvedMethod } from './credentials';
import { getProvider } from './provider';

/**
 * Pure rules behind the set-up checklist, the usage stats and the weekly
 * report: no I/O, so they are unit-tested directly. The service gathers
 * the facts and calls these.
 */
export const PLUGIN_NAME = 'Payments';
export const ADMIN_ROUTE = 'hulo-payments';

/** What the free tier loses — shown in the trial/free banners and the weekly report. */
export const PREMIUM_FEATURES = [
    'All 11 providers (free tier: Stripe + bank transfer)',
    'Hosted checkout page and pay-by-link',
    'Subscriptions with dunning',
    'Routing rules and surcharges',
];

export interface StatDef {
    key: string;
    label: string;
    format: 'count' | 'pence';
    /** A point-in-time figure (active subscriptions, MRR) — no week-on-week delta. */
    snapshot?: boolean;
}

/** The usage keys the licence server, the weekly report and the admin banner share, in headline order. */
export const STAT_DEFS: StatDef[] = [
    { key: 'paymentsSettled', label: 'payments settled', format: 'count' },
    { key: 'volumePence', label: 'taken in payments', format: 'pence' },
    { key: 'refundedPence', label: 'refunded', format: 'pence' },
    { key: 'disputesOpened', label: 'disputes opened', format: 'count' },
    { key: 'subscriptionsActive', label: 'active subscriptions', format: 'count', snapshot: true },
    { key: 'mrrPence', label: 'monthly recurring revenue', format: 'pence', snapshot: true },
    { key: 'payLinkPaidPence', label: 'paid by link', format: 'pence' },
    { key: 'renewalsRecovered', label: 'failed renewals recovered', format: 'count' },
];

/** Mirrors `REQUIRED_KEYS` in ui/components/provider-copy.ts: a method with these args filled is "connected". */
const REQUIRED_ARGS: Record<string, string[]> = {
    'hulo-stripe': ['secretKey', 'publishableKey'],
    'hulo-adyen': ['apiKey', 'merchantAccount', 'clientKey'],
    'hulo-paypal': ['clientId', 'clientSecret'],
    'hulo-mollie': ['apiKey'],
    'hulo-square': ['accessToken', 'applicationId', 'locationId'],
    'hulo-braintree': ['merchantId', 'publicKey', 'privateKey'],
    'hulo-gocardless': ['accessToken'],
    'hulo-checkout-com': ['secretKey', 'publicKey', 'processingChannelId'],
    'hulo-coinbase': ['apiKey'],
    'hulo-bank-transfer': ['accountName'],
    'hulo-pay-later': [],
};

export function methodConnected(m: { handlerCode: string; args: Record<string, any> }): boolean {
    const req = REQUIRED_ARGS[m.handlerCode];
    if (!req) return false;
    return req.every(k => String(m.args?.[k] ?? '').trim() !== '');
}

export function webhookConfigured(m: { handlerCode: string; args: Record<string, any> }): boolean {
    const p = getProvider(m.handlerCode);
    if (!p || p.capabilities.offline || m.handlerCode === 'hulo-mollie') return true;
    return !!(m.args?.webhookSecret || m.args?.hmacKey || m.args?.webhookId);
}

export interface SetupItem { key: string; label: string; done: boolean; hint: string; tab?: string; url?: string }

/** The facts the checklist is computed from — gathered by the service, shaped here so the logic is unit-testable. */
export interface SetupFacts {
    methods: Array<Pick<ResolvedMethod, 'enabled' | 'args' | 'channelIds'> & { handlerCode: string }>;
    returnHosts: string[];
    opsEmailOption: string;
    channelOpsEmails: number;
    firstPayment: boolean;
}

export function setupItemsFrom(f: SetupFacts): { items: SetupItem[]; complete: boolean } {
    const connected = f.methods.filter(methodConnected);
    const missingWebhook = connected.filter(m => !webhookConfigured(m)).map(m => getProvider(m.handlerCode)?.name || m.handlerCode);
    const items: SetupItem[] = [
        {
            key: 'provider', label: 'Connect a payment provider', done: connected.length > 0,
            hint: 'Paste the keys on the Providers tab — the plugin checks them with the provider and registers the webhook for you.', tab: 'providers',
        },
        {
            key: 'method', label: 'Enable a payment method on a channel', done: f.methods.some(m => m.enabled && methodConnected(m)),
            hint: 'Connect switches the method on; a method added without keys stays disabled until it is connected or enabled under Settings → Payment methods.', tab: 'methods',
        },
        {
            key: 'returnHosts', label: 'Restrict where the hosted checkout may return customers', done: f.returnHosts.length > 0,
            hint: "Set hostedReturnHosts: ['shop.example.com'] in the plugin options so the hosted page only sends customers back to your storefront.",
            url: 'https://huloglobal.com/vendure-plugins/payments/docs/',
        },
        {
            key: 'opsEmail', label: 'Set an ops email for disputes and failed renewals', done: !!f.opsEmailOption || f.channelOpsEmails > 0,
            hint: 'Settings → Operations, per channel (the ops.email plugin option is the fallback for every channel). Needs SMTP_* in the host environment.', tab: 'settings',
        },
        {
            key: 'webhook',
            label: connected.length && missingWebhook.length ? `Save the webhook secret for ${missingWebhook.join(', ')}` : "Save each connected provider's webhook secret",
            done: connected.length > 0 && missingWebhook.length === 0,
            hint: 'Without the secret the provider\'s events are rejected and payments are never confirmed. Reconnect on the Providers tab or paste the secret into the payment method.', tab: 'providers',
        },
        {
            key: 'firstPayment', label: 'Take a first payment', done: f.firstPayment,
            hint: 'Use test-mode keys and pay through the hosted checkout (huloHostedCheckout) or your storefront flow — it shows up under Transactions.', tab: 'transactions',
        },
    ];
    return { items, complete: items.every(i => i.done) };
}

/** Money in the store's currency: the SDK's `pence` format is GBP-only, so other currencies render as text. */
export function toDigestStat(def: StatDef, value: number, previous: number | null | undefined, currency: string): DigestStat {
    const base: DigestStat = { key: def.key, label: def.label, value: Math.round(value || 0), previous: previous == null ? null : Math.round(previous) };
    if (def.format === 'count') return base;
    if (!currency || currency === 'GBP') return { ...base, format: 'pence' };
    let text: string;
    try { text = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(base.value / 100); }
    catch { text = `${(base.value / 100).toFixed(2)} ${currency}`; }
    return { ...base, format: 'text', text };
}
