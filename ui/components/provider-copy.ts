/**
 * Plain-language copy about each provider, shared by the Payments page, the
 * payment-method list column and the payment-method detail panel.
 */
export interface ProviderGroup { id: string; title: string; hint: string; codes: string[] }

/** How the Providers tab groups the catalogue — a shop owner's categories, not ours. */
export const PROVIDER_GROUPS: ProviderGroup[] = [
    { id: 'cards', title: 'Cards & wallets', hint: 'Take Visa, Mastercard, Amex, Apple Pay and Google Pay. Most shops need exactly one of these.', codes: ['hulo-stripe', 'hulo-adyen', 'hulo-checkout-com', 'hulo-square', 'hulo-braintree'] },
    { id: 'local', title: 'PayPal, bank & local methods', hint: 'Add these next to a card provider for customers who prefer PayPal, iDEAL, Bancontact or direct debit.', codes: ['hulo-paypal', 'hulo-mollie', 'hulo-gocardless'] },
    { id: 'crypto', title: 'Crypto', hint: 'Bitcoin, Ethereum and stablecoins, settled to your Coinbase Commerce account.', codes: ['hulo-coinbase'] },
    { id: 'offline', title: 'Offline & on account', hint: 'No keys, no fees: the order is placed and you mark it paid when the money arrives.', codes: ['hulo-bank-transfer', 'hulo-pay-later'] },
];

/** One line: what the customer sees as the ways to pay. */
export const PAY_WITH: Record<string, string[]> = {
    'hulo-stripe': ['Visa', 'Mastercard', 'Amex', 'Apple Pay', 'Google Pay', 'Link', 'Klarna', '3-D Secure'],
    'hulo-adyen': ['Cards', 'Apple Pay', 'Google Pay', 'iDEAL', 'Klarna', 'Bancontact', '100+ local methods'],
    'hulo-paypal': ['PayPal', 'Pay Later', 'Venmo (US)', 'Cards via PayPal'],
    'hulo-mollie': ['iDEAL', 'Cards', 'Bancontact', 'SEPA', 'Klarna'],
    'hulo-square': ['Cards', 'Apple Pay', 'Google Pay', 'Cash App Pay', 'Afterpay'],
    'hulo-braintree': ['Cards', 'PayPal', 'Venmo', 'Apple Pay', 'Google Pay'],
    'hulo-gocardless': ['Bacs', 'SEPA', 'ACH', 'Instant Bank Pay'],
    'hulo-checkout-com': ['Cards', 'Apple Pay', 'Google Pay', 'Klarna', 'iDEAL'],
    'hulo-coinbase': ['Bitcoin', 'Ethereum', 'USDC', 'Other crypto'],
    'hulo-bank-transfer': ['Bank transfer (Faster Payments / BACS / SEPA)'],
    'hulo-pay-later': ['Invoice, paid within your terms'],
};

/** Two sentences a shop owner can act on. */
export const BLURBS: Record<string, string> = {
    'hulo-stripe': 'Card payments through your own Stripe account, with Apple Pay, Google Pay and Link shown automatically when the customer\'s device supports them. Money lands in Stripe; Vendure records every payment, refund and dispute.',
    'hulo-adyen': 'Adyen Drop-in: cards, wallets and over a hundred local methods (iDEAL, Klarna, Bancontact…) from one integration, settled to your Adyen merchant account.',
    'hulo-paypal': 'PayPal buttons at checkout: PayPal balance, Pay Later and Venmo (US). Choose whether to take the money at once or hold it and capture from the order page.',
    'hulo-mollie': 'Mollie hosted checkout: iDEAL, cards, Bancontact, SEPA and Klarna, with automatic confirmation when the customer returns.',
    'hulo-square': 'Square Web Payments: cards, Apple Pay, Google Pay, Cash App Pay and Afterpay, charged to your Square location.',
    'hulo-braintree': 'Braintree Drop-in: cards, PayPal, Venmo, Apple Pay and Google Pay through your Braintree merchant account.',
    'hulo-gocardless': 'Direct debit through GoCardless: Bacs, SEPA and ACH mandates plus Instant Bank Pay. Best for repeat and subscription billing.',
    'hulo-checkout-com': 'Checkout.com hosted payment page: cards, wallets, Klarna and iDEAL, with holds, refunds and payment links.',
    'hulo-coinbase': 'Crypto payments through Coinbase Commerce: the customer pays in Bitcoin, Ethereum, USDC and others; you receive the settled amount.',
    'hulo-bank-transfer': 'The customer transfers the money from their bank using the account details you enter. The order is placed straight away and you mark it paid from the order page when the money arrives.',
    'hulo-pay-later': 'Invoice / on-account terms: the order is placed and the customer has the number of days you set to pay. Mark it paid from the order page.',
};

/** Where to register the webhook and what to paste back. */
export const WEBHOOK_HINTS: Record<string, string> = {
    'hulo-stripe': 'Stripe → Developers → Webhooks → Add endpoint. Paste this URL, select payment_intent.*, charge.*, checkout.session.completed, invoice.* and customer.subscription.* events, then copy the signing secret (whsec_…) into "Webhook signing secret" above.',
    'hulo-adyen': 'Customer Area → Developers → Webhooks → Standard webhook. Paste this URL, generate an HMAC key and put it in "Webhook HMAC key" above.',
    'hulo-paypal': 'developer.paypal.com → your app → Webhooks → Add. Paste this URL, tick all payment, dispute and billing events, then put the webhook ID in "Webhook ID" above.',
    'hulo-mollie': 'Nothing to do: Mollie calls this URL automatically and the plugin fetches the payment back to confirm it.',
    'hulo-square': 'Developer Dashboard → Webhooks → Add subscription with this URL (payment.* and refund.* events); paste its signature key above.',
    'hulo-gocardless': 'Dashboard → Developers → Webhook endpoints → Create. Paste this URL and put the secret in "Webhook secret" above.',
    'hulo-checkout-com': 'Dashboard → Developers → Workflows → new workflow with a webhook action to this URL and an HMAC signature; paste the signature key above.',
    'hulo-coinbase': 'Settings → Notifications → Webhook subscriptions → add this URL; paste the shared secret above.',
};

/** Brand marks for the list column and cards: two letters + a colour, no logos to license. */
export const MARKS: Record<string, { text: string; bg: string }> = {
    'hulo-stripe': { text: 'S', bg: '#635bff' },
    'hulo-adyen': { text: 'A', bg: '#0abf53' },
    'hulo-paypal': { text: 'P', bg: '#003087' },
    'hulo-mollie': { text: 'M', bg: '#0077ff' },
    'hulo-square': { text: 'Sq', bg: '#006aff' },
    'hulo-braintree': { text: 'B', bg: '#1e1e1e' },
    'hulo-gocardless': { text: 'G', bg: '#1c1c1c' },
    'hulo-checkout-com': { text: 'C', bg: '#0b0b0b' },
    'hulo-coinbase': { text: '₿', bg: '#0052ff' },
    'hulo-bank-transfer': { text: '£', bg: '#0f766e' },
    'hulo-pay-later': { text: '30', bg: '#92400e' },
};

/** The fields that must be filled before a method can work at all. */
export const REQUIRED_KEYS: Record<string, string[]> = {
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

export type MethodStatus = 'live' | 'test' | 'disabled' | 'not-set-up';

/** One word about a method's state, from what the providers endpoint reports. */
export function methodStatus(m: { enabled: boolean; environment?: string; args?: Record<string, any> }, providerCode: string): MethodStatus {
    const req = REQUIRED_KEYS[providerCode] || [];
    const args = m.args || {};
    // Redacted secrets come back as '••••' — any non-empty value counts as filled.
    if (req.some(k => !String(args[k] ?? '').trim())) return 'not-set-up';
    if (!m.enabled) return 'disabled';
    const env = String(m.environment || 'live').toLowerCase();
    return env === 'live' || env === 'production' ? 'live' : 'test';
}

export const STATUS_LABEL: Record<MethodStatus, string> = { 'live': 'Live', 'test': 'Test mode', 'disabled': 'Ready, disabled', 'not-set-up': 'Not set up' };
