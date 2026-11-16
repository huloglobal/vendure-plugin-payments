import { Injectable } from '@nestjs/common';
import { ID, Order, OrderService, RequestContext, TransactionalConnection } from '@vendure/core';
import { getProvider } from './provider';
import { listHuloMethods, resolveMethod } from './credentials';
import { LedgerService } from './ledger.service';
import { HostedCheckoutService, MAX_PAY_LINK_TTL_MS } from './hosted.service';
import { getRuntime } from './runtime';

/**
 * Pay links — free since 0.4.0. Public, stable service API (also used by other
 * HULO plugins, e.g. Quotations, to put a "Pay now" link on an accepted quote):
 *
 * - `create(ctx, input)` issues a link for any unpaid order;
 * - `listForOrder(orderCode)` lists the links issued for an order.
 *
 * Two kinds of link:
 * - `hosted` (default): the plugin's own hosted checkout page for that order,
 *   offering every method enabled on the order's channel (bank transfer and
 *   pay-later included). Nothing is created at a provider until the customer
 *   picks a method.
 * - `provider`: a provider-hosted link (Stripe Checkout, Adyen, PayPal,
 *   Mollie, Square, Checkout.com, Coinbase). Providers other than Stripe
 *   need a licence, as they do everywhere else.
 *
 * Either way the payment is recorded on the order by the same code paths as
 * checkout (hosted page completion or the provider's webhook), and the link
 * is written to the ledger as a `paylink` row.
 *
 * @docsCategory Services
 * @category Services
 */
export type PayLinkMode = 'hosted' | 'provider';

export interface CreatePayLinkInput {
    /** The order, by code or id (one of the two). */
    orderCode?: string;
    orderId?: ID;
    /** `hosted` (default) or `provider`. */
    mode?: PayLinkMode;
    /**
     * `provider` links: the payment method code (or handler code, e.g. `hulo-stripe`) to create
     * the link with; default the first enabled method on the order's channel that supports links.
     * `hosted` links: the method to open first on the page (optional).
     */
    methodCode?: string;
    /** Link lifetime in hours: 1 to 720 (30 days); default 72. */
    expiresInHours?: number;
    /** Absolute https URL the customer returns to after paying. Default `<publicBaseUrl>/checkout/confirmation/<code>`. */
    returnUrl?: string;
    /** Page language for hosted links (BCP 47, e.g. `en-GB`). */
    locale?: string;
    /** Free text kept on the ledger row, e.g. `quotation:Q-1042` or `admin 12`. */
    createdBy?: string;
    /**
     * Minor units. When set below what is left to pay, the link is for this amount only (a deposit or a
     * balance): paying it adds a PARTIAL payment, and the order reaches PaymentSettled only once its settled
     * payments cover the total. Partial links are provider links (Stripe, free); hosted links are always for
     * what is left to pay.
     */
    amount?: number;
    /** What the customer sees on the provider page (default `Order <code>`). */
    description?: string;
    /** Must equal the order's currency when given. */
    currency?: string;
    customerEmail?: string;
    /** String metadata stamped on the provider payment (at most 10 keys). */
    metadata?: Record<string, string>;
}

/** The input of `PayLinkService.createPayLink` (the contract HULO Quotations calls). */
export interface PayLinkRequest {
    orderCode: string;
    /** Minor units; when set, the link is for this amount, not the order total (deposits and balances). */
    amount?: number;
    currency: string;
    description: string;
    customerEmail?: string;
    returnUrl?: string;
    expiresInHours?: number;
    /** Kept on the ledger row and stamped on the provider payment as `reference`. */
    reference?: string;
    metadata?: Record<string, string>;
}

export interface PayLinkResult {
    url: string;
    /** Provider link id, or `hosted:<n>` for hosted links. */
    ref: string;
    expiresAt: string | null;
    mode: PayLinkMode;
    /** Handler code of the provider, or `hulo-hosted`. */
    provider: string;
    orderCode: string;
    amount: number;
    currency: string;
}

export interface PayLinkSummary {
    id: number;
    provider: string;
    mode: PayLinkMode;
    /** `pending` until paid (`ok`) or refused (`failed`). */
    status: string;
    amount: number | null;
    currency: string | null;
    ref: string | null;
    url: string | null;
    expiresAt: string | null;
    createdAt: any;
}

export type PayLinkErrorCode = 'invalid-input' | 'order-not-found' | 'order-not-payable' | 'no-provider' | 'licence-required' | 'provider-error';

export class PayLinkError extends Error {
    constructor(public readonly code: PayLinkErrorCode, message: string) {
        super(message);
        this.name = 'PayLinkError';
    }
}

/** Orders in these states take no further payment through a link. */
export const NOT_PAYABLE_STATES = ['PaymentSettled', 'PaymentAuthorized', 'Delivered', 'Shipped', 'PartiallyDelivered', 'PartiallyShipped', 'Cancelled'];

export const HOSTED_PROVIDER = 'hulo-hosted';
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const METHOD_RE = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class PayLinkService {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private ledger: LedgerService,
        private hosted: HostedCheckoutService,
    ) {}

    /** Issue a pay link for an unpaid order. Throws `PayLinkError`. */
    async create(ctx: RequestContext, input: CreatePayLinkInput): Promise<PayLinkResult> {
        const mode: PayLinkMode = input?.mode === 'provider' ? 'provider' : 'hosted';
        if (input?.mode && !['hosted', 'provider'].includes(input.mode)) throw new PayLinkError('invalid-input', 'mode must be "hosted" or "provider"');
        if (input?.methodCode && !METHOD_RE.test(String(input.methodCode))) throw new PayLinkError('invalid-input', 'methodCode is not valid');
        const relations: any[] = ['customer', 'lines', 'lines.productVariant', 'channels', 'payments'];
        let order: Order | undefined;
        if (input?.orderCode) order = await this.orderService.findOneByCode(ctx, String(input.orderCode).slice(0, 64), relations);
        else if (input?.orderId != null) order = await this.orderService.findOne(ctx, input.orderId, relations);
        else throw new PayLinkError('invalid-input', 'orderCode or orderId is required');
        if (!order) throw new PayLinkError('order-not-found', 'order not found');
        if (NOT_PAYABLE_STATES.includes(order.state)) throw new PayLinkError('order-not-payable', `order is ${order.state}`);
        if (!(order.totalWithTax > 0)) throw new PayLinkError('order-not-payable', 'order total is zero');
        if (input.currency && String(input.currency).toUpperCase() !== order.currencyCode) throw new PayLinkError('invalid-input', `currency must be ${order.currencyCode}`);
        // What is left to pay: the total less payments already settled or authorised (deposits).
        const covered = (order.payments || []).filter(p => p.state === 'Settled' || p.state === 'Authorized').reduce((n, p) => n + Number(p.amount || 0), 0);
        const left = order.totalWithTax - covered;
        if (left <= 0) throw new PayLinkError('order-not-payable', 'order is already covered by its payments');
        let amount = left;
        if (input.amount != null) {
            amount = Math.trunc(Number(input.amount));
            if (!(amount > 0) || amount > left) throw new PayLinkError('invalid-input', `amount must be between 1 and ${left} (what is left to pay)`);
        }
        const partial = amount < order.totalWithTax;
        const channelId = Number((order.channels || []).find((c: any) => c.code !== '__default_channel__')?.id || order.channels?.[0]?.id || ctx.channelId) || 1;
        const hours = Math.max(1, Math.min(MAX_PAY_LINK_TTL_MS / 3600_000, Number(input?.expiresInHours) || 72));
        const raw = String(input?.returnUrl || '');
        const returnUrl = /^https:\/\/[^\s]+$/i.test(raw) && raw.length <= 1000 ? raw : `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/checkout/confirmation/${order.code}`;
        const createdBy = input?.createdBy ? String(input.createdBy).slice(0, 200) : ctx.activeUserId ? `admin ${ctx.activeUserId}` : 'api';
        // A part payment cannot go through the hosted page (it charges what the order shows): use a provider link.
        if (partial && mode === 'hosted' && input?.mode === 'hosted') throw new PayLinkError('invalid-input', 'a link for part of the order must be a provider link (mode: "provider")');
        return mode === 'hosted' && !partial
            ? this.createHosted(order, channelId, hours, returnUrl, input, createdBy)
            : this.createProvider(order, channelId, hours, returnUrl, input, createdBy, amount, partial);
    }

    /**
     * The contract HULO Quotations (and other plugins) call: a pay link for an order, for its whole remaining
     * amount (the hosted page) or — with `amount` — for part of it (a Stripe link; the payment is partial).
     */
    async createPayLink(ctx: RequestContext, input: PayLinkRequest): Promise<{ url: string; ref: string }> {
        const metadata = { ...(input?.metadata || {}), ...(input?.reference ? { reference: String(input.reference).slice(0, 200) } : {}) };
        const r = await this.create(ctx, {
            orderCode: input?.orderCode, amount: input?.amount, currency: input?.currency, description: input?.description,
            customerEmail: input?.customerEmail, returnUrl: input?.returnUrl, expiresInHours: input?.expiresInHours, metadata,
            mode: input?.amount != null ? 'provider' : undefined,
            createdBy: input?.reference ? `ref:${String(input.reference).slice(0, 180)}` : undefined,
        });
        return { ...r, url: r.url, ref: r.ref };
    }

    /** Pay links issued for an order, newest first. */
    async listForOrder(orderCode: string): Promise<PayLinkSummary[]> {
        return this.ledger.payLinksFor(String(orderCode || '').slice(0, 64));
    }

    private async createHosted(order: Order, channelId: number, hours: number, returnUrl: string, input: CreatePayLinkInput, createdBy: string): Promise<PayLinkResult> {
        const locale = LOCALE_RE.test(String(input?.locale || '')) ? String(input.locale) : 'en-GB';
        const s = await this.hosted.create(order.id, order.code, channelId, returnUrl, '', locale, input?.methodCode || undefined, { ttlMs: hours * 3600_000, payLink: true });
        const url = `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/hulo-payments/pay/${s.token}`;
        const expiresAt = new Date(s.expiresAt).toISOString();
        const ref = `hosted:${s.id}`;
        await this.ledger.record({ channelId, provider: HOSTED_PROVIDER, kind: 'paylink', status: 'pending', orderId: order.id as number, orderCode: order.code, paymentRef: ref, amount: order.totalWithTax, currency: order.currencyCode, reason: `created by ${createdBy}`, meta: { url, expiresAt, mode: 'hosted' } });
        return { url, ref, expiresAt, mode: 'hosted', provider: HOSTED_PROVIDER, orderCode: order.code, amount: order.totalWithTax, currency: order.currencyCode };
    }

    private async createProvider(order: Order, channelId: number, hours: number, returnUrl: string, input: CreatePayLinkInput, createdBy: string, amount = order.totalWithTax, partial = false): Promise<PayLinkResult> {
        const premium = getRuntime().hasPremiumAccess();
        const methods = await listHuloMethods(this.connection, channelId);
        // Part payments are verified against the intent's own amount: Stripe only.
        const usable = (m: { handlerCode: string }) => { const p = getProvider(m.handlerCode); return !!p?.createPayLink && (p.freeTier || premium) && (!partial || p.code === 'hulo-stripe'); };
        const method = input?.methodCode
            ? methods.find(m => m.paymentMethodCode === input.methodCode || m.handlerCode === input.methodCode)
            : methods.find(m => m.enabled && usable(m));
        // A method chosen by code must be enabled too: a disabled method takes no payments anywhere else.
        if (method && !method.enabled) throw new PayLinkError('no-provider', `payment method ${method.paymentMethodCode} is disabled`);
        const provider = method ? getProvider(method.handlerCode) : undefined;
        if (!method || !provider?.createPayLink) throw new PayLinkError('no-provider', partial ? 'a link for part of the order needs an enabled Stripe method on this channel' : 'no enabled provider with pay-by-link on this channel');
        if (partial && provider.code !== 'hulo-stripe') throw new PayLinkError('invalid-input', 'a link for part of the order can only be a Stripe link');
        if (!provider.freeTier && !premium) throw new PayLinkError('licence-required', `${provider.name} needs a HULO Payments licence`);
        const resolved = await resolveMethod(this.connection, method.handlerCode, channelId, method.paymentMethodCode);
        if (!resolved) throw new PayLinkError('no-provider', `payment method ${method.paymentMethodCode} is not configured on this channel`);
        let link;
        try {
            link = await provider.createPayLink(resolved.args, {
                orderCode: order.code, amount, currency: order.currencyCode, description: input?.description ? String(input.description).slice(0, 200) : `Order ${order.code}`,
                customerEmail: input?.customerEmail || order.customer?.emailAddress, returnUrl, partial, metadata: input?.metadata,
                expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
                lines: (order.lines || []).map(l => ({ name: l.productVariant?.name || 'Item', quantity: l.quantity, amount: l.proratedUnitPriceWithTax ?? l.unitPriceWithTax })),
            });
        } catch (e: any) {
            throw new PayLinkError('provider-error', e?.message || `${provider.name} could not create the link`);
        }
        await this.ledger.record({ channelId, provider: provider.code, kind: 'paylink', status: 'pending', orderId: order.id as number, orderCode: order.code, paymentRef: link.ref, amount, currency: order.currencyCode, reason: `created by ${createdBy}`, meta: { url: link.url, expiresAt: link.expiresAt, mode: 'provider', partial } });
        return { url: link.url, ref: link.ref, expiresAt: link.expiresAt || null, mode: 'provider', provider: provider.code, orderCode: order.code, amount, currency: order.currencyCode };
    }
}

/** 0.4.0 name of `PayLinkService`, kept as an alias (same class, same Nest provider). */
export const HuloPayLinkService = PayLinkService;
export type HuloPayLinkService = PayLinkService;
