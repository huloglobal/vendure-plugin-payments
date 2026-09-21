import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Ctx, LanguageCode, OrderService, PaymentMethodService, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import type { Response } from 'express';
import { allProviders, getProvider, ProviderArgs } from './provider';
import { HANDLER_ARGS } from './handlers';
import { listHuloMethods, redactArgs, resolveMethod, clearCredentialCache } from './credentials';
import { LedgerService } from './ledger.service';
import { PaymentsService } from './payments.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { getRuntime, PremiumRequiredError, requirePremium } from './runtime';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!ctx.userHasPermissions(needed)) { res.status(403).json({ error: 'forbidden' }); return true; }
    return false;
}

function fail(res: Response, e: any) {
    if (e instanceof PremiumRequiredError) return res.status(402).json({ error: 'licence-required', message: e.message, buyUrl: 'https://huloglobal.com/vendure-plugins/payments/' });
    return res.status(400).json({ error: e?.message || String(e) });
}

/** Dashboard, ledger, providers, settings, subscriptions and pay-by-link for the admin UI. */
@Controller('hulo-payments')
export class HuloPaymentsAdminController {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private ledger: LedgerService,
        private payments: PaymentsService,
        private subscriptions: SubscriptionService,
        private paymentMethodService: PaymentMethodService,
    ) {}

    /** Field metadata for the Connect form, derived from the handler args so labels stay in one place. */
    private connectFields(code: string) {
        const provider = getProvider(code);
        const defs: any = (HANDLER_ARGS as any)[code] || {};
        return (provider?.connectFields || []).map(name => {
            const d = defs[name] || {};
            return { name, label: d.label?.[0]?.value || name, description: d.description?.[0]?.value || '', secret: d.ui?.component === 'password-form-input', options: d.ui?.options?.map((o: any) => o.value) || null, defaultValue: d.defaultValue ?? '' };
        });
    }

    @Get('dashboard')
    async dashboard(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const channelId = q.channelId ? Number(q.channelId) : null;
        const [ledger, subs, methods] = await Promise.all([this.ledger.stats(channelId, Number(q.days) || 30), this.subscriptions.stats(), listHuloMethods(this.connection)]);
        return res.json({
            premium: getRuntime().hasPremiumAccess(), ledger, subscriptions: subs,
            providers: allProviders().map(p => ({ code: p.code, name: p.name, freeTier: p.freeTier, capabilities: p.capabilities, configured: methods.some(m => m.handlerCode === p.code && m.enabled) })),
        });
    }

    @Get('transactions')
    async transactions(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.ledger.list({ channelId: q.channelId ? Number(q.channelId) : null, provider: q.provider, kind: q.kind, status: q.status, orderCode: q.q, days: q.days ? Number(q.days) : undefined, page: Number(q.page) || 1, perPage: Number(q.perPage) || 50 }));
    }

    @Get('events')
    async events(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.ledger.recentEvents(100));
    }

    @Get('providers')
    async providers(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        clearCredentialCache();
        const methods = await listHuloMethods(this.connection);
        const base = getRuntime().publicBaseUrl().replace(/\/$/, '');
        const channels: any[] = await this.connection.rawConnection.query(`SELECT id, code FROM channel ORDER BY id`).catch(() => []);
        return res.json({
            webhookBase: `${base}/hulo-payments/webhook/`,
            channels: channels.map(c => ({ id: Number(c.id), code: c.code })),
            providers: allProviders().map(p => {
                const mine = methods.filter(m => m.handlerCode === p.code);
                return {
                    code: p.code, name: p.name, freeTier: p.freeTier, capabilities: p.capabilities, webhookUrl: `${base}/hulo-payments/webhook/${p.code}`,
                    links: p.dashboardLinks(mine[0]?.args || {}), connectFields: this.connectFields(p.code),
                    methods: mine.map(m => ({ id: m.paymentMethodId, code: m.paymentMethodCode, enabled: m.enabled, channelIds: m.channelIds, args: redactArgs(m.args), environment: p.publicConfig(m.args).environment, webhookConfigured: !!(m.args.webhookSecret || m.args.hmacKey || m.args.webhookId || p.code === 'hulo-mollie') })),
                };
            }),
        });
    }

    @Get('settings')
    async settings(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const channels: any[] = await this.connection.rawConnection.query(`SELECT id, code FROM channel ORDER BY id`).catch(() => []);
        const all = await Promise.all(channels.map(async c => ({ channelCode: c.code, ...(await this.ledger.getSettings(Number(c.id))) })));
        return res.json(q.channelId ? all.find(s => s.channelId === Number(q.channelId)) || null : all);
    }

    @Post('settings')
    async saveSettings(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!body?.channelId) return res.status(400).json({ error: 'channelId required' });
        try { await this.ledger.saveSettings(body); return res.json({ ok: true, settings: await this.ledger.getSettings(Number(body.channelId)) }); }
        catch (e) { return fail(res, e); }
    }

    @Get('subscriptions')
    async subscriptionsList(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.subscriptions.list({ status: q.status, search: q.q, page: Number(q.page) || 1, perPage: Number(q.perPage) || 50 }));
    }

    @Post('subscriptions/:id/cancel')
    async cancelSubscription(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        try { requirePremium('Subscriptions'); return res.json(await this.subscriptions.cancel(Number(id), body?.atPeriodEnd !== false, `admin:${ctx.activeUserId}`)); }
        catch (e) { return fail(res, e); }
    }

    @Post('subscriptions/:id/pause')
    async pauseSubscription(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        try { requirePremium('Subscriptions'); return res.json(await this.subscriptions.pause(Number(id), false)); } catch (e) { return fail(res, e); }
    }

    @Post('subscriptions/:id/resume')
    async resumeSubscription(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        try { requirePremium('Subscriptions'); return res.json(await this.subscriptions.pause(Number(id), true)); } catch (e) { return fail(res, e); }
    }

    @Post('scheduler/run')
    async runScheduler(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        try { requirePremium('Subscriptions'); return res.json(await this.subscriptions.runScheduler()); } catch (e) { return fail(res, e); }
    }

    /** Check credentials with the provider without saving anything. */
    @Post('connect/:provider/test')
    async connectTest(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('provider') code: string, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const provider = getProvider(code);
        if (!provider) return res.status(404).json({ error: 'unknown provider' });
        try { return res.status(200).json(await provider.verifyCredentials(this.withDefaults(code, body?.args || {}))); }
        catch (e) { return fail(res, e); }
    }

    /**
     * One-step connect: verify the credentials, register the webhook with the
     * provider (where its API allows it) and create or update the Vendure
     * payment method on the chosen channel. The admin never leaves the page.
     */
    @Post('connect/:provider')
    async connect(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('provider') code: string, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!ctx.userHasPermissions([Permission.CreatePaymentMethod]) && !ctx.userHasPermissions([Permission.UpdatePaymentMethod])) return res.status(403).json({ error: 'forbidden' });
        const provider = getProvider(code);
        if (!provider) return res.status(404).json({ error: 'unknown provider' });
        if (!provider.freeTier && !getRuntime().hasPremiumAccess()) return res.status(402).json({ error: 'licence-required', message: `${provider.name} needs a HULO Payments licence`, buyUrl: 'https://huloglobal.com/vendure-plugins/payments/' });
        try {
            const channelId = Number(body?.channelId) || (ctx.channelId as number);
            const existing = (await listHuloMethods(this.connection, channelId)).find(m => m.handlerCode === code && m.channelIds.includes(channelId));
            let args = this.withDefaults(code, { ...(existing?.args || {}), ...(body?.args || {}) });
            const check = await provider.verifyCredentials(args);
            if (!check.ok) return res.status(400).json({ ok: false, step: 'verify', message: check.message });
            let webhook: any = null;
            if (provider.ensureWebhook) {
                const url = `${getRuntime().publicBaseUrl().replace(/\/$/, '')}/hulo-payments/webhook/${code}`;
                try { webhook = await provider.ensureWebhook(args, url); args = { ...args, ...webhook.args }; }
                catch (e: any) { webhook = { args: {}, note: `Webhook not created: ${e.message}. Add ${url} in the provider dashboard and paste its secret into the payment method.` }; }
            }
            const adminCtx = await this.payments.adminCtx(channelId);
            const handler = { code, arguments: Object.entries(args).map(([name, value]) => ({ name, value: String(value ?? '') })) };
            const name = String(body?.name || existing?.paymentMethodCode || `${provider.name} (HULO Payments)`).slice(0, 120);
            const methodCode = String(body?.code || existing?.paymentMethodCode || `${code.replace('hulo-', '')}${channelId > 1 ? `-ch${channelId}` : ''}`).slice(0, 60);
            let method: any;
            if (existing) {
                method = await this.paymentMethodService.update(adminCtx, { id: existing.paymentMethodId, enabled: body?.enabled !== false, handler, translations: [{ languageCode: LanguageCode.en, name }] } as any);
            } else {
                method = await this.paymentMethodService.create(adminCtx, { code: methodCode, enabled: body?.enabled !== false, handler, translations: [{ languageCode: LanguageCode.en, name, description: '' }] } as any);
            }
            clearCredentialCache();
            return res.status(200).json({ ok: true, message: check.message, account: check.account, environment: check.environment, webhook: webhook ? { ref: webhook.ref || null, note: webhook.note || null, configured: !!(args.webhookSecret || args.hmacKey || args.webhookId) } : { configured: true, note: 'No webhook configuration is needed for this provider.' }, method: { id: method.id, code: method.code, enabled: method.enabled, channelId, updated: !!existing } });
        } catch (e) { return fail(res, e); }
    }

    private withDefaults(code: string, args: ProviderArgs): ProviderArgs {
        const defs: any = (HANDLER_ARGS as any)[code] || {};
        const out: ProviderArgs = {};
        for (const [name, def] of Object.entries<any>(defs)) out[name] = args[name] !== undefined && args[name] !== null ? args[name] : (def.defaultValue ?? '');
        return out;
    }

    /** Pay-by-link for any order that still needs payment (draft orders, quotes, phone orders). */
    @Post('pay-link')
    async payLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        try {
            requirePremium('Pay by link');
            const order = await this.orderService.findOneByCode(ctx, String(body?.orderCode || ''), ['customer', 'lines', 'lines.productVariant', 'channels']);
            if (!order) return res.status(404).json({ error: 'order not found' });
            if (['PaymentSettled', 'PaymentAuthorized', 'Delivered', 'Shipped', 'Cancelled'].includes(order.state)) return res.status(400).json({ error: `order is ${order.state}` });
            const channelId = Number((order.channels || []).find((c: any) => c.code !== '__default_channel__')?.id || order.channels?.[0]?.id) || undefined;
            const methods = await listHuloMethods(this.connection, channelId);
            const method = body?.methodCode ? methods.find(m => m.paymentMethodCode === body.methodCode || m.handlerCode === body.methodCode)
                : methods.find(m => m.enabled && getProvider(m.handlerCode)?.createPayLink);
            const provider = method ? getProvider(method.handlerCode) : undefined;
            if (!method || !provider?.createPayLink) return res.status(400).json({ error: 'no enabled provider with pay-by-link on this channel' });
            const resolved = await resolveMethod(this.connection, method.handlerCode, channelId, method.paymentMethodCode);
            const hours = Math.max(1, Math.min(24 * 30, Number(body?.expiresInHours) || 72));
            const link = await provider.createPayLink(resolved!.args, {
                orderCode: order.code, amount: order.totalWithTax, currency: order.currencyCode, description: `Order ${order.code}`,
                customerEmail: order.customer?.emailAddress, returnUrl: body?.returnUrl || `${getRuntime().publicBaseUrl()}/checkout/confirmation/${order.code}`,
                expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
                lines: (order.lines || []).map(l => ({ name: l.productVariant?.name || 'Item', quantity: l.quantity, amount: l.proratedUnitPriceWithTax ?? l.unitPriceWithTax })),
            });
            await this.ledger.record({ channelId: channelId || null, provider: provider.code, kind: 'paylink', status: 'pending', orderId: order.id as number, orderCode: order.code, paymentRef: link.ref, amount: order.totalWithTax, currency: order.currencyCode, reason: `created by admin ${ctx.activeUserId}`, meta: { url: link.url, expiresAt: link.expiresAt } });
            return res.json({ ok: true, url: link.url, ref: link.ref, expiresAt: link.expiresAt, provider: provider.code, amount: order.totalWithTax, currency: order.currencyCode });
        } catch (e) { return fail(res, e); }
    }
}
