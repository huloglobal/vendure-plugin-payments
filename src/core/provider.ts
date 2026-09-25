import { Order, RequestContext } from '@vendure/core';

/** Provider codes double as PaymentMethodHandler codes. */
export type ProviderCode =
    | 'hulo-stripe' | 'hulo-adyen' | 'hulo-paypal' | 'hulo-mollie'
    | 'hulo-square' | 'hulo-braintree' | 'hulo-gocardless' | 'hulo-checkout-com' | 'hulo-coinbase'
    | 'hulo-bank-transfer' | 'hulo-pay-later';

export interface ProviderCapabilities {
    /** Money moves outside the plugin (bank transfer, invoice): settled by hand in the admin. */
    offline?: boolean;
    /** Hosted / embedded checkout element (client-side confirmation). */
    session: boolean;
    /** Authorise now, capture later. */
    manualCapture: boolean;
    partialCapture: boolean;
    refund: boolean;
    partialRefund: boolean;
    /** Saved cards / stored payment methods for returning customers. */
    savedMethods: boolean;
    subscriptions: boolean;
    payByLink: boolean;
    disputes: boolean;
    /** Wallets the hosted element can show (informational for storefronts). */
    wallets: string[];
}

/** Provider credentials as configured on the Vendure PaymentMethod (handler args). */
export type ProviderArgs = Record<string, any>;

/** What the storefront needs to render the provider's element / redirect. */
export interface ClientSession {
    provider: ProviderCode;
    /** Stripe: PaymentIntent client secret. */
    clientSecret?: string;
    /** Adyen: session id + sessionData; PayPal: order id; Mollie: payment id. */
    sessionId?: string;
    sessionData?: string;
    /** Redirect-style providers (Mollie, PayPal approve, pay-by-link). */
    checkoutUrl?: string;
    /** Publishable key / client key / client id — safe for browsers. */
    publicKey?: string;
    /** Provider environment: 'test' | 'live'. */
    environment?: string;
    /** How the hosted page / storefront should drive this session. */
    flow?: 'stripe-element' | 'adyen-dropin' | 'paypal-buttons' | 'square-web' | 'braintree-dropin' | 'redirect' | 'instructions';
    /** Text shown to the customer for offline methods (bank details, pay-later terms). */
    instructions?: string;
    /** Extra public config (Adyen: environment/countryCode/locale, PayPal: currency). */
    config?: Record<string, any>;
    amount: number;
    currency: string;
    expiresAt?: string;
}

export interface SessionOptions {
    /** Save the payment method for later (customer must be signed in). */
    savePaymentMethod?: boolean;
    /** Reuse a stored payment method id. */
    savedMethodId?: string;
    /** Where redirect flows return to (storefront URL). */
    returnUrl?: string;
    /** Storefront locale / country for hosted UIs. */
    locale?: string;
    countryCode?: string;
    /** Set when the order contains subscription lines. */
    subscription?: boolean;
    /** Provider customer reference for the signed-in customer (looked up by the plugin). */
    providerCustomerRef?: string;
}

export type PaymentOutcomeState = 'Settled' | 'Authorized' | 'Declined' | 'Error';

export interface PaymentOutcome {
    state: PaymentOutcomeState;
    /** Amount actually authorised/settled in Vendure minor units. */
    amount: number;
    transactionId?: string;
    errorMessage?: string;
    metadata?: Record<string, any>;
}

export interface RefundOutcome {
    state: 'Settled' | 'Pending' | 'Failed';
    transactionId?: string;
    metadata?: Record<string, any>;
}

export interface CaptureOutcome {
    success: boolean;
    errorMessage?: string;
    metadata?: Record<string, any>;
}

/** Normalised webhook event; the plugin turns these into ledger rows and order state. */
export interface NormalisedEvent {
    /** Provider event id (idempotency). */
    id: string;
    type:
        | 'payment.settled' | 'payment.authorized' | 'payment.failed' | 'payment.canceled'
        | 'refund.settled' | 'refund.failed'
        | 'dispute.opened' | 'dispute.closed'
        | 'subscription.active' | 'subscription.renewed' | 'subscription.payment_failed'
        | 'subscription.canceled' | 'subscription.paused' | 'subscription.updated'
        | 'paylink.completed' | 'ignored';
    orderCode?: string;
    /** True when the payment was created by another integration on the same provider account
     *  (e.g. Vendure's own Stripe plugin): acknowledge and leave the order alone. */
    foreign?: boolean;
    /** Provider payment reference (PaymentIntent id, pspReference, capture id, Mollie payment id). */
    paymentRef?: string;
    /** Provider subscription reference where relevant. */
    subscriptionRef?: string;
    amount?: number;
    currency?: string;
    /** Provider-side reason / status text for the ledger. */
    reason?: string;
    /** Subscription facts pushed by the provider (period end, status). */
    subscription?: { status?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; customerRef?: string; paymentRef?: string };
    raw?: any;
}

export interface WebhookVerification {
    ok: boolean;
    events: NormalisedEvent[];
    /** Body to answer the provider with (Adyen wants "[accepted]"). */
    reply?: any;
    error?: string;
}

export interface SubscriptionPlanInput {
    /** Vendure product variant id (used as the plan key). */
    variantId: number;
    name: string;
    amount: number;
    currency: string;
    interval: 'day' | 'week' | 'month' | 'year';
    intervalCount: number;
    trialDays: number;
    quantity: number;
}

export interface SubscriptionCreateInput extends SubscriptionPlanInput {
    orderCode: string;
    customerEmail: string;
    customerName?: string;
    /** Provider references captured at checkout (customer, payment method / token). */
    providerCustomerRef?: string;
    providerPaymentRef?: string;
    /** Provider payment reference of the initial order payment (to derive tokens). */
    initialPaymentRef?: string;
    /** Provider plan / price reference from a previous `ensurePlan` call. */
    providerPlanRef?: string;
    returnUrl?: string;
}

export interface SubscriptionOutcome {
    /** Provider subscription id, or the plugin's own scheduler when the provider has none. */
    providerSubscriptionRef: string;
    status: 'active' | 'trialing' | 'pending' | 'past_due' | 'paused' | 'canceled';
    currentPeriodEnd?: string;
    /** Customer must approve (PayPal) — redirect them here. */
    approveUrl?: string;
    providerCustomerRef?: string;
    providerPaymentRef?: string;
    /** True when renewals are charged by this plugin's scheduler (tokenised). */
    selfScheduled?: boolean;
}

export interface PayLinkInput {
    orderCode: string;
    amount: number;
    currency: string;
    description: string;
    customerEmail?: string;
    returnUrl?: string;
    expiresAt?: string;
    lines?: Array<{ name: string; quantity: number; amount: number }>;
}

export interface PayLinkOutcome { url: string; ref: string; expiresAt?: string }

export interface SavedMethod { id: string; brand?: string; last4?: string; expiry?: string; type: string; provider: ProviderCode }

export interface CredentialCheck {
    ok: boolean;
    message: string;
    /** Account / merchant name as the provider reports it. */
    account?: string;
    environment?: string;
}

/** What `ensureWebhook` was able to set up; missing pieces come with a note for the admin. */
export interface WebhookSetup {
    /** Handler args to merge (webhookSecret, webhookId, hmacKey …). */
    args: Partial<ProviderArgs>;
    /** Provider-side reference of the webhook (endpoint id). */
    ref?: string;
    /** Human note when something must still be done by hand. */
    note?: string;
}

export interface DashboardLinks { dashboard: string; keys?: string; webhooks?: string; docs?: string }

/**
 * The single contract every provider implements. Handlers, webhooks, the
 * shop API and the subscription engine only talk to this interface.
 */
export interface PaymentProvider {
    code: ProviderCode;
    name: string;
    capabilities: ProviderCapabilities;
    /** True when the provider is usable without a licence (free tier). */
    freeTier: boolean;
    /** Public config for storefronts (never secrets). */
    publicConfig(args: ProviderArgs): Record<string, any>;
    /** Deep links into the provider's dashboard for the given credentials / environment. */
    dashboardLinks(args: ProviderArgs): DashboardLinks;
    /** Which handler args the Connect form asks for (the rest get defaults). */
    connectFields: string[];
    /** Call the provider with the supplied credentials and report what account they belong to. */
    verifyCredentials(args: ProviderArgs): Promise<CredentialCheck>;
    /** Create (or reuse) the provider-side webhook pointing at `url`; returns args to store. */
    ensureWebhook?(args: ProviderArgs, url: string): Promise<WebhookSetup>;
    createSession(ctx: RequestContext, order: Order, args: ProviderArgs, opts: SessionOptions): Promise<ClientSession>;
    /** Verify the client-reported result server-side and decide the payment state. */
    confirmPayment(ctx: RequestContext, order: Order, args: ProviderArgs, metadata: Record<string, any>): Promise<PaymentOutcome>;
    capture(args: ProviderArgs, paymentRef: string, amount: number, currency: string, metadata: Record<string, any>): Promise<CaptureOutcome>;
    cancel(args: ProviderArgs, paymentRef: string, metadata: Record<string, any>): Promise<CaptureOutcome>;
    refund(args: ProviderArgs, paymentRef: string, amount: number, currency: string, reason: string, metadata: Record<string, any>): Promise<RefundOutcome>;
    verifyWebhook(args: ProviderArgs, rawBody: Buffer | string, headers: Record<string, any>, query: Record<string, any>): Promise<WebhookVerification>;
    listSavedMethods?(args: ProviderArgs, providerCustomerRef: string): Promise<SavedMethod[]>;
    removeSavedMethod?(args: ProviderArgs, providerCustomerRef: string, methodId: string): Promise<boolean>;
    /** Create (or reuse) the provider-side plan/price for a variant; returns its reference. */
    ensurePlan?(args: ProviderArgs, plan: SubscriptionPlanInput): Promise<string>;
    createSubscription?(args: ProviderArgs, input: SubscriptionCreateInput): Promise<SubscriptionOutcome>;
    cancelSubscription?(args: ProviderArgs, providerSubscriptionRef: string, atPeriodEnd: boolean): Promise<{ status: SubscriptionOutcome['status']; currentPeriodEnd?: string }>;
    pauseSubscription?(args: ProviderArgs, providerSubscriptionRef: string, resume: boolean): Promise<{ status: SubscriptionOutcome['status'] }>;
    /** Charge a stored token for a self-scheduled renewal. */
    chargeStored?(args: ProviderArgs, input: { customerRef: string; paymentRef: string; amount: number; currency: string; reference: string; description: string }): Promise<PaymentOutcome>;
    createPayLink?(args: ProviderArgs, input: PayLinkInput): Promise<PayLinkOutcome>;
}

const registry = new Map<ProviderCode, PaymentProvider>();
export function registerProvider(p: PaymentProvider): void { registry.set(p.code, p); }
export function getProvider(code: string): PaymentProvider | undefined { return registry.get(code as ProviderCode); }
export function allProviders(): PaymentProvider[] { return [...registry.values()]; }
