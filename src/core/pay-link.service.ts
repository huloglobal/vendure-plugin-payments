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
export class HuloPayLinkService {
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
        const relations: any[] = ['customer', 'lines', 'lines.productVariant', 'channels'];
        let order: Order | undefined;
        if (input?.orderCode) order = await this.orderService.findOneByCode(ctx, String(input.orderCode).slice(0, 64), relations);
        else if (input?.orderId != null) order = await this.orderService.findOne(ctx, input.orderId, relations);
        else throw new PayLinkError('invalid-input', 'orderCode or orderId is required');
        if (!order) throw new PayLinkError('order-not-found', 'order not found');
        if (NOT_PAYABLE_STATES.includes(order.state)) throw new PayLinkError('order-not-payable', `order is ${order.state}`);
        if (!(order.totalWithTax > 0)) throw new PayLinkError('order-not-payable', 'order total is zero');
        const channelId = Number((order.channels || []).find((c: any) => c.code !== '__default_channel__')?.id || order.channels?.[0]?.id || ctx.channelId) || 1;
        const hours = Math.max(1, Math.min(MAX_PAY_LINK_TTL_MS / 3600_000, Number(input?.expiresInHours) || 72));
        const raw = String(input?.returnUrl || '');
        const returnUrl = /^https:\/\/[^\s]+$/i.test(raw) && raw.length <= 1000 ? raw : `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/checkout/confirmation/${order.code}`;
        const createdBy = input?.createdBy ? String(input.createdBy).slice(0, 200) : ctx.activeUserId ? `admin ${ctx.activeUserId}` : 'api';
        return mode === 'hosted'
            ? this.createHosted(order, channelId, hours, returnUrl, input, createdBy)
            : this.createProvider(order, channelId, hours, returnUrl, input, createdBy);
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

    private async createProvider(order: Order, channelId: number, hours: number, returnUrl: string, input: CreatePayLinkInput, createdBy: string): Promise<PayLinkResult> {
        const premium = getRuntime().hasPremiumAccess();
        const methods = await listHuloMethods(this.connection, channelId);
        const usable = (m: { handlerCode: string }) => { const p = getProvider(m.handlerCode); return !!p?.createPayLink && (p.freeTier || premium); };
        const method = input?.methodCode
            ? methods.find(m => m.paymentMethodCode === input.methodCode || m.handlerCode === input.methodCode)
            : methods.find(m => m.enabled && usable(m));
        const provider = method ? getProvider(method.handlerCode) : undefined;
        if (!method || !provider?.createPayLink) throw new PayLinkError('no-provider', 'no enabled provider with pay-by-link on this channel');
        if (!provider.freeTier && !premium) throw new PayLinkError('licence-required', `${provider.name} needs a HULO Payments licence`);
        const resolved = await resolveMethod(this.connection, method.handlerCode, channelId, method.paymentMethodCode);
        if (!resolved) throw new PayLinkError('no-provider', `payment method ${method.paymentMethodCode} is not configured on this channel`);
        let link;
        try {
            link = await provider.createPayLink(resolved.args, {
                orderCode: order.code, amount: order.totalWithTax, currency: order.currencyCode, description: `Order ${order.code}`,
                customerEmail: order.customer?.emailAddress, returnUrl,
                expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
                lines: (order.lines || []).map(l => ({ name: l.productVariant?.name || 'Item', quantity: l.quantity, amount: l.proratedUnitPriceWithTax ?? l.unitPriceWithTax })),
            });
        } catch (e: any) {
            throw new PayLinkError('provider-error', e?.message || `${provider.name} could not create the link`);
        }
        await this.ledger.record({ channelId, provider: provider.code, kind: 'paylink', status: 'pending', orderId: order.id as number, orderCode: order.code, paymentRef: link.ref, amount: order.totalWithTax, currency: order.currencyCode, reason: `created by ${createdBy}`, meta: { url: link.url, expiresAt: link.expiresAt, mode: 'provider' } });
        return { url: link.url, ref: link.ref, expiresAt: link.expiresAt || null, mode: 'provider', provider: provider.code, orderCode: order.code, amount: order.totalWithTax, currency: order.currencyCode };
    }
}
