import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Ctx, OrderService, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import type { Response } from 'express';
import { allProviders, getProvider } from './provider';
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
    ) {}

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
        return res.json({
            webhookBase: `${base}/hulo-payments/webhook/`,
            providers: allProviders().map(p => ({
                code: p.code, name: p.name, freeTier: p.freeTier, capabilities: p.capabilities, webhookUrl: `${base}/hulo-payments/webhook/${p.code}`,
                methods: methods.filter(m => m.handlerCode === p.code).map(m => ({ id: m.paymentMethodId, code: m.paymentMethodCode, enabled: m.enabled, channelIds: m.channelIds, args: redactArgs(m.args), environment: p.publicConfig(m.args).environment })),
            })),
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
