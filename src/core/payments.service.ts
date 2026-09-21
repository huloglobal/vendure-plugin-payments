import { Injectable } from '@nestjs/common';
import {
    ActiveOrderService, ChannelService, Customer, ID, Logger, Order, OrderService, RequestContext, RequestContextService, TransactionalConnection,
} from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { ClientSession, NormalisedEvent, PaymentProvider, ProviderArgs, SavedMethod, SessionOptions, getProvider } from './provider';
import { ResolvedMethod, listHuloMethods, resolveMethod } from './credentials';
import { LedgerService, loggerCtx } from './ledger.service';
import { getRuntime, requirePremium } from './runtime';
import { markSettledByWebhook } from './handlers';
import { request } from './rest';
import { ensureMollieCustomer } from '../providers/mollie';
import { SubscriptionService } from '../subscriptions/subscription.service';

export interface OfferedProvider {
    methodCode: string;
    provider: string;
    name: string;
    capabilities: Record<string, any>;
    publicConfig: Record<string, any>;
    surcharge: { type: 'percent' | 'fixed'; value: number; label?: string } | null;
    preferred: boolean;
}

/**
 * Orchestration shared by the shop API, webhooks and the admin: which
 * providers to offer, session creation (with provider customer records for
 * saved cards / subscriptions), and turning verified webhook events into
 * ledger rows and Vendure payment state.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class PaymentsService {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private activeOrderService: ActiveOrderService,
        private channelService: ChannelService,
        private requestContextService: RequestContextService,
        private ledger: LedgerService,
        private subscriptions: SubscriptionService,
    ) {}

    private get db() { return adapterFor(this.connection.rawConnection); }

    // ── Offering ────────────────────────────────────────────────────────
    async offeredProviders(ctx: RequestContext, order: Order): Promise<OfferedProvider[]> {
        const eligible = await this.orderService.getEligiblePaymentMethods(ctx, order.id);
        const methods = await listHuloMethods(this.connection, ctx.channelId as number);
        const settings = await this.ledger.getSettings(ctx.channelId as number);
        const premium = getRuntime().hasPremiumAccess();
        const out: OfferedProvider[] = [];
        for (const m of methods) {
            const provider = getProvider(m.handlerCode);
            if (!provider || !m.enabled) continue;
            if (!provider.freeTier && !premium) continue;
            const e = eligible.find(x => x.code === m.paymentMethodCode);
            if (!e || !e.isEligible) continue;
            out.push({
                methodCode: m.paymentMethodCode, provider: provider.code, name: provider.name, capabilities: provider.capabilities,
                publicConfig: provider.publicConfig(m.args), surcharge: premium ? settings.surcharges[m.handlerCode] || settings.surcharges[m.paymentMethodCode] || null : null, preferred: false,
            });
        }
        const rank = (code: string) => { const i = settings.providerOrder.indexOf(code); return i === -1 ? 99 : i; };
        out.sort((a, b) => rank(a.provider) - rank(b.provider));
        if (out[0]) out[0].preferred = true;
        return out;
    }

    async activeOrderOrThrow(ctx: RequestContext): Promise<Order> {
        const order = await this.activeOrderService.getActiveOrder(ctx, undefined);
        if (!order) throw new Error('No active order');
        const full = await this.orderService.findOne(ctx, order.id, ['lines', 'lines.productVariant', 'customer', 'customer.groups', 'surcharges', 'payments']);
        if (!full) throw new Error('No active order');
        return full;
    }

    // ── Sessions ────────────────────────────────────────────────────────
    async createSession(ctx: RequestContext, order: Order, methodCode: string, opts: SessionOptions): Promise<ClientSession & { methodCode: string }> {
        const method = await resolveMethod(this.connection, await this.handlerCodeFor(methodCode, ctx.channelId as number), ctx.channelId as number, methodCode);
        if (!method) throw new Error(`Payment method ${methodCode} is not configured on this channel`);
        const provider = getProvider(await this.handlerCodeFor(methodCode, ctx.channelId as number));
        if (!provider) throw new Error(`Unknown provider for ${methodCode}`);
        if (!provider.freeTier) requirePremium(provider.name);
        const subscription = this.subscriptions.orderHasSubscriptionLines(order);
        if (subscription) requirePremium('Subscriptions');
        if (opts.savePaymentMethod || opts.savedMethodId) requirePremium('Saved payment methods');
        const settings = await this.ledger.getSettings(ctx.channelId as number);
        const wantsCustomer = !!(opts.savePaymentMethod || opts.savedMethodId || subscription || (settings.saveCardsDefault && getRuntime().hasPremiumAccess() && order.customer?.user));
        let providerCustomerRef: string | undefined;
        if (wantsCustomer && order.customer?.user) providerCustomerRef = (await this.ensureCustomerRef(provider, method.args, order.customer)) || undefined;
        const session = await provider.createSession(ctx, order, method.args, { ...opts, subscription, providerCustomerRef, savePaymentMethod: opts.savePaymentMethod || subscription || (wantsCustomer && settings.saveCardsDefault) });
        return { ...session, methodCode };
    }

    private async handlerCodeFor(methodCode: string, channelId: number): Promise<string> {
        const all = await listHuloMethods(this.connection, channelId);
        const m = all.find(x => x.paymentMethodCode === methodCode) || all.find(x => x.handlerCode === methodCode);
        if (!m) throw new Error(`Payment method ${methodCode} is not a HULO Payments method`);
        return m.handlerCode;
    }

    /** Provider-side customer object for signed-in customers (Stripe, Mollie). */
    async ensureCustomerRef(provider: PaymentProvider, args: ProviderArgs, customer: Customer): Promise<string | null> {
        const existing = await this.ledger.getCustomerRef(provider.code, customer.id as number);
        if (existing) return existing;
        let ref: string | null = null;
        const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
        try {
            if (provider.code === 'hulo-stripe') {
                const c = await request('Stripe', 'https://api.stripe.com/v1/customers', { headers: { authorization: `Bearer ${args.secretKey}` }, form: { email: customer.emailAddress, name: name || undefined, metadata: { vendureCustomerId: String(customer.id) } } });
                ref = c.id;
            } else if (provider.code === 'hulo-mollie') {
                ref = await ensureMollieCustomer(args, customer.emailAddress, name);
            } else if (provider.code === 'hulo-adyen') {
                ref = `cust-${customer.id}`;
            }
        } catch (e: any) {
            Logger.warn(`${provider.code} customer creation failed: ${e.message}`, loggerCtx);
        }
        if (ref) await this.ledger.setCustomerRef(provider.code, customer.id as number, customer.emailAddress, ref);
        return ref;
    }

    async savedMethods(ctx: RequestContext, customer: Customer): Promise<SavedMethod[]> {
        requirePremium('Saved payment methods');
        const out: SavedMethod[] = [];
        for (const m of await listHuloMethods(this.connection, ctx.channelId as number)) {
            const provider = getProvider(m.handlerCode);
            if (!provider?.listSavedMethods || !m.enabled) continue;
            const ref = await this.ledger.getCustomerRef(provider.code, customer.id as number);
            if (!ref) continue;
            try { out.push(...await provider.listSavedMethods(m.args, ref)); } catch (e: any) { Logger.warn(`${provider.code} listSavedMethods: ${e.message}`, loggerCtx); }
        }
        return out;
    }

    async removeSavedMethod(ctx: RequestContext, customer: Customer, providerCode: string, id: string): Promise<boolean> {
        requirePremium('Saved payment methods');
        const provider = getProvider(providerCode);
        const m = await resolveMethod(this.connection, providerCode, ctx.channelId as number);
        const ref = await this.ledger.getCustomerRef(providerCode, customer.id as number);
        if (!provider?.removeSavedMethod || !m || !ref) return false;
        // Only the customer's own methods can be removed: the id must be in their list.
        const mine = provider.listSavedMethods ? await provider.listSavedMethods(m.args, ref) : [];
        if (!mine.some(x => x.id === id)) return false;
        return provider.removeSavedMethod(m.args, ref, id);
    }

    // ── Surcharges ──────────────────────────────────────────────────────
    async applySurcharge(ctx: RequestContext, order: Order, methodCode: string): Promise<Order> {
        requirePremium('Payment surcharges');
        const settings = await this.ledger.getSettings(ctx.channelId as number);
        const handlerCode = await this.handlerCodeFor(methodCode, ctx.channelId as number).catch(() => methodCode);
        const rule = settings.surcharges[handlerCode] || settings.surcharges[methodCode] || null;
        for (const s of order.surcharges || []) {
            if (String(s.sku || '').startsWith('hulo-surcharge:')) await this.orderService.removeSurchargeFromOrder(ctx, order.id, s.id);
        }
        if (rule && rule.value > 0) {
            const base = order.totalWithTax - (order.surcharges || []).filter(s => String(s.sku || '').startsWith('hulo-surcharge:')).reduce((n, s) => n + s.priceWithTax, 0);
            const amount = rule.type === 'percent' ? Math.round(base * rule.value / 100) : Math.round(rule.value);
            if (amount > 0) {
                await this.orderService.addSurchargeToOrder(ctx, order.id, { description: rule.label || `${methodCode} payment fee`, listPrice: amount, listPriceIncludesTax: true, sku: `hulo-surcharge:${methodCode}`, taxLines: [] } as any);
            }
        }
        return (await this.orderService.findOne(ctx, order.id)) as Order;
    }

    // ── Webhook application ─────────────────────────────────────────────
    async adminCtx(channelId?: number | null): Promise<RequestContext> {
        const channel = channelId ? await this.channelService.findOne(RequestContext.empty(), channelId) : null;
        return this.requestContextService.create({ apiType: 'admin', channelOrToken: channel || (await this.channelService.getDefaultChannel()) });
    }

    async applyEvent(providerCode: string, ev: NormalisedEvent, method: ResolvedMethod & { handlerCode: string }): Promise<void> {
        const provider = getProvider(providerCode);
        if (!provider || ev.type === 'ignored') return;
        if (ev.type.startsWith('subscription.') || (ev.subscription && (ev.type === 'payment.authorized' || ev.type === 'payment.settled'))) {
            await this.subscriptions.applyEvent(providerCode, ev, method.args);
            if (ev.type.startsWith('subscription.')) return;
        }
        const ctx = await this.adminCtx(method.channelIds[0]);
        const order = ev.orderCode ? await this.orderService.findOneByCode(ctx, ev.orderCode, ['payments', 'payments.refunds', 'channels', 'customer', 'lines']) : await this.findOrderByPaymentRef(ctx, ev.paymentRef);
        const channelId = order ? Number((order.channels || []).find((c: any) => c.code !== '__default_channel__')?.id || order.channels?.[0]?.id || ctx.channelId) : (method.channelIds[0] || null);
        const rec = (kind: any, status: any, extra: Partial<Parameters<LedgerService['record']>[0]> = {}) =>
            this.ledger.record({ channelId, provider: providerCode, kind, status, orderId: order ? (order.id as number) : null, orderCode: order?.code || ev.orderCode || null, paymentRef: ev.paymentRef || null, amount: ev.amount ?? null, currency: ev.currency || order?.currencyCode || null, reason: ev.reason || null, meta: { event: ev.type, eventId: ev.id }, ...extra });
        const payment = order?.payments?.find(p => p.method === method.paymentMethodCode && (p.transactionId === ev.paymentRef || !ev.paymentRef || String(p.transactionId).startsWith('adyen-session:') || String(p.metadata?.paypalOrderId || '') === ev.paymentRef));

        switch (ev.type) {
            case 'payment.authorized': {
                if (!order || !payment) { await rec('authorize', 'ok'); return; }
                if (ev.paymentRef && String(payment.transactionId).startsWith('adyen-session:')) {
                    await this.db.query(`UPDATE payment SET transactionId = ? WHERE id = ?`, [ev.paymentRef, payment.id]);
                    payment.transactionId = ev.paymentRef;
                }
                await rec('authorize', 'ok', { meta: { event: ev.type, eventId: ev.id, via: 'webhook' } });
                const immediate = providerCode === 'hulo-adyen' ? method.args.captureMode !== 'manual' : false;
                if (immediate && payment.state === 'Authorized') {
                    markSettledByWebhook(payment.id);
                    const r: any = await this.orderService.settlePayment(ctx, payment.id);
                    if (r?.errorCode) Logger.warn(`settle after ${ev.type} failed for ${order.code}: ${r.message}`, loggerCtx);
                }
                return;
            }
            case 'payment.settled': {
                if (!order) { await rec('capture', 'ok'); return; }
                if (payment && payment.state === 'Authorized') {
                    markSettledByWebhook(payment.id);
                    const r: any = await this.orderService.settlePayment(ctx, payment.id);
                    if (r?.errorCode) Logger.warn(`settle after webhook failed for ${order.code}: ${r.message}`, loggerCtx);
                    return; // the handler's settle wrote the ledger row
                }
                if (!payment && order.state === 'ArrangingPayment') {
                    await this.addPaymentFromWebhook(ctx, order, method, ev);
                    return;
                }
                if (payment?.state !== 'Settled') await rec('capture', 'ok', { meta: { event: ev.type, eventId: ev.id, note: 'no matching Vendure payment' } });
                return;
            }
            case 'payment.failed':
            case 'payment.canceled': {
                await rec(ev.type === 'payment.canceled' ? 'cancel' : 'failure', ev.type === 'payment.canceled' ? 'ok' : 'failed');
                if (order && payment && payment.state === 'Authorized' && ev.type === 'payment.failed') {
                    try { await this.orderService.cancelPayment(ctx, payment.id); } catch (e: any) { Logger.warn(`cancelPayment after ${ev.type}: ${e.message}`, loggerCtx); }
                }
                return;
            }
            case 'refund.settled':
            case 'refund.failed': {
                await rec('refund', ev.type === 'refund.settled' ? 'ok' : 'failed');
                if (order && payment && ev.type === 'refund.settled') {
                    const pending = (payment.refunds || []).find(r => r.state === 'Pending');
                    if (pending) {
                        try { await this.orderService.settleRefund(ctx, { id: pending.id, transactionId: String(ev.paymentRef || pending.transactionId || '') }); }
                        catch (e: any) { Logger.warn(`settleRefund: ${e.message}`, loggerCtx); }
                    }
                }
                return;
            }
            case 'dispute.opened':
            case 'dispute.closed': {
                await rec('dispute', ev.type === 'dispute.opened' ? 'open' : (/won|reversed|resolved_seller|seller_favour/i.test(ev.reason || '') ? 'won' : 'lost'));
                await getRuntime().notifyOps({ kind: `payments.${ev.type}`, subject: `${provider.name} dispute ${ev.type === 'dispute.opened' ? 'opened' : 'closed'}${order ? ` on order ${order.code}` : ''}`, text: `${provider.name} reported a ${ev.type === 'dispute.opened' ? 'new' : 'closed'} dispute${ev.reason ? ` (${ev.reason})` : ''}${ev.amount != null ? ` for ${ev.amount / 100} ${ev.currency}` : ''}. Payment ref ${ev.paymentRef || '?'}.`, orderCode: order?.code, channelId });
                return;
            }
            case 'paylink.completed': {
                if (!order) { await rec('paylink', 'ok'); return; }
                if (['PaymentSettled', 'PaymentAuthorized', 'Delivered', 'Shipped'].includes(order.state)) { await rec('paylink', 'ok', { meta: { event: ev.type, note: 'already paid' } }); return; }
                if (order.state !== 'ArrangingPayment') {
                    const t: any = await this.orderService.transitionToState(ctx, order.id, 'ArrangingPayment');
                    if (t?.errorCode) { await rec('paylink', 'failed', { reason: t.message }); return; }
                }
                await this.addPaymentFromWebhook(ctx, order, method, ev);
                return;
            }
            default:
                return;
        }
    }

    private async addPaymentFromWebhook(ctx: RequestContext, order: Order, method: ResolvedMethod, ev: NormalisedEvent): Promise<void> {
        const metadata = { paymentIntentId: ev.paymentRef, molliePaymentId: ev.paymentRef, paypalOrderId: ev.paymentRef, sessionId: ev.raw?.sessionId, viaWebhook: ev.type };
        const r: any = await this.orderService.addPaymentToOrder(ctx, order.id, { method: method.paymentMethodCode, metadata });
        if (r?.errorCode) {
            Logger.warn(`addPaymentToOrder from webhook (${ev.type}) failed for ${order.code}: ${r.message}`, loggerCtx);
            await this.ledger.record({ channelId: ctx.channelId as number, provider: method.args?.provider || '', kind: 'paylink', status: 'failed', orderId: order.id as number, orderCode: order.code, paymentRef: ev.paymentRef, amount: ev.amount ?? null, currency: ev.currency || order.currencyCode, reason: r.message });
        } else if (ev.type === 'paylink.completed') {
            await this.ledger.record({ channelId: ctx.channelId as number, provider: method.args?.provider || '', kind: 'paylink', status: 'ok', orderId: order.id as number, orderCode: order.code, paymentRef: ev.paymentRef, amount: ev.amount ?? null, currency: ev.currency || order.currencyCode });
        }
    }

    private async findOrderByPaymentRef(ctx: RequestContext, ref?: string): Promise<Order | undefined> {
        if (!ref) return undefined;
        const [row] = await this.db.query(`SELECT orderId FROM payment WHERE transactionId = ? ORDER BY id DESC LIMIT 1`, [ref]).catch(() => []);
        if (!row?.orderId) return undefined;
        return this.orderService.findOne(ctx, row.orderId as ID, ['payments', 'payments.refunds', 'channels', 'customer', 'lines']);
    }
}
