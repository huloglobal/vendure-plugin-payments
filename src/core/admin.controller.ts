import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Ctx, LanguageCode, OrderService, PaymentMethodService, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import type { Response } from 'express';
import { allProviders, getProvider, ProviderArgs } from './provider';
import { HANDLER_SHORT_NAMES, HANDLER_ARGS } from './handlers';
import { adapterFor, isAdminApiSession } from '@huloglobal/vendure-licence-sdk';
import { listHuloMethods, redactArgs, clearCredentialCache } from './credentials';
import { LedgerService } from './ledger.service';
import { PaymentsService } from './payments.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { BUY_URL, getRuntime, PremiumRequiredError, requirePremium } from './runtime';
import { HuloPaymentsEngagementService } from '../engagement.service';
import { PayLinkService, PayLinkError } from './pay-link.service';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!isAdminApiSession(ctx) || !ctx.userHasPermissions(needed)) { res.status(403).json({ error: 'forbidden' }); return true; }
    return false;
}

/** True when the request is made in the default channel (which may see and act on every channel). */
function inDefaultChannel(ctx: RequestContext): boolean {
    return !ctx.channelId || ctx.channel?.code === '__default_channel__' || String(ctx.channelId) === '1';
}

/** The channel a read is scoped to: an operator in a non-default channel only sees that channel. */
function scopedChannel(ctx: RequestContext, requested: unknown): number | null {
    if (!inDefaultChannel(ctx)) return Number(ctx.channelId);
    const n = requested ? Number(requested) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** A write on `channelId` is allowed from the default channel, or from that channel itself. */
function channelAllowed(ctx: RequestContext, channelId: number): boolean {
    return inDefaultChannel(ctx) || Number(ctx.channelId) === Number(channelId);
}

function clampDays(v: unknown, fallback: number): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(365, n) : fallback;
}

function fail(res: Response, e: any) {
    if (e instanceof PremiumRequiredError) return res.status(402).json({ error: 'licence-required', message: e.message, buyUrl: BUY_URL });
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
        private engagement: HuloPaymentsEngagementService,
        private payLinks: PayLinkService,
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
        const channelId = scopedChannel(ctx, q.channelId);
        const days = clampDays(q.days, 30);
        const now = new Date();
        const [ledger, subs, methods, renewalsRecovered] = await Promise.all([
            this.ledger.stats(channelId, days), this.subscriptions.stats(channelId), listHuloMethods(this.connection, channelId ?? undefined),
            this.engagement.renewalsRecovered(new Date(now.getTime() - days * 86_400_000), now, channelId).catch(() => 0),
        ]);
        return res.json({
            premium: getRuntime().hasPremiumAccess(), ledger, subscriptions: subs, renewalsRecovered,
            providers: allProviders().map(p => ({ code: p.code, name: p.name, freeTier: p.freeTier, capabilities: p.capabilities, configured: methods.some(m => m.handlerCode === p.code && m.enabled) })),
        });
    }

    @Get('transactions')
    async transactions(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.ledger.list({ channelId: scopedChannel(ctx, q.channelId), provider: q.provider, kind: q.kind, status: q.status, orderCode: q.q, days: q.days ? clampDays(q.days, 30) : undefined, page: Number(q.page) || 1, perPage: Number(q.perPage) || 50 }));
    }

    @Get('events')
    async events(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        // Webhook events carry no channel: only the default channel (which sees every channel) may read them.
        if (!inDefaultChannel(ctx)) return res.json([]);
        return res.json(await this.ledger.recentEvents(100));
    }

    @Get('providers')
    async providers(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        // An operator outside the default channel sees that channel's methods only.
        const own = inDefaultChannel(ctx) ? undefined : Number(ctx.channelId);
        const methods = await listHuloMethods(this.connection, own);
        const base = getRuntime().publicBaseUrl().replace(/\/$/, '');
        const allChannels: any[] = await this.connection.rawConnection.query(`SELECT id, code FROM channel ORDER BY id`).catch(() => []);
        const channels = own ? allChannels.filter(c => Number(c.id) === own) : allChannels;
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
        const visible = inDefaultChannel(ctx) ? channels : channels.filter(c => Number(c.id) === Number(ctx.channelId));
        const all = await Promise.all(visible.map(async c => ({ channelCode: c.code, ...(await this.ledger.getSettings(Number(c.id))) })));
        const want = scopedChannel(ctx, q.channelId);
        return res.json(want ? all.find(s => s.channelId === want) || null : all);
    }

    @Post('settings')
    async saveSettings(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const channelId = Number.parseInt(String(body?.channelId ?? ''), 10);
        if (!Number.isInteger(channelId) || channelId < 1) return res.status(400).json({ error: 'channelId required' });
        if (!channelAllowed(ctx, channelId)) return res.status(403).json({ error: 'forbidden' });
        // Only known providers, bounded values; the row stores this as JSON, so it is validated here rather than truncated there.
        const surcharges: Record<string, any> = {};
        for (const [k, v] of Object.entries<any>(body?.surcharges || {})) {
            if (!getProvider(k) && !k.startsWith('hulo-')) continue;
            surcharges[k] = { type: v?.type === 'fixed' ? 'fixed' : 'percent', value: Math.max(0, Math.min(1_000_000, Number(v?.value) || 0)), label: String(v?.label || '').slice(0, 60) };
        }
        if (JSON.stringify(surcharges).length > 4000) return res.status(400).json({ error: 'too many surcharge rules' });
        const logo = String(body?.hostedLogoUrl || '').trim();
        if (logo && !/^https?:\/\/[^\s]+$/i.test(logo)) return res.status(400).json({ error: 'hostedLogoUrl must be an absolute http(s) URL' });
        const opsEmail = String(body?.opsEmail || '').trim();
        if (opsEmail && !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(opsEmail)) return res.status(400).json({ error: 'opsEmail is not an e-mail address' });
        const providerOrder = (Array.isArray(body?.providerOrder) ? body.providerOrder : []).filter((c: any) => typeof c === 'string' && getProvider(c));
        try {
            // Fields the body leaves out keep their stored value (an older admin UI knows nothing of reconcileRefunds).
            const current = await this.ledger.getSettings(channelId);
            const merged: any = { ...current };
            for (const k of ['fallbackOnFailure', 'reconcileRefunds', 'saveCardsDefault', 'dunningDays', 'hostedBrandName', 'hostedAccent']) if (body?.[k] !== undefined) merged[k] = body[k];
            await this.ledger.saveSettings({ ...merged, channelId, surcharges: body?.surcharges !== undefined ? surcharges : current.surcharges, hostedLogoUrl: body?.hostedLogoUrl !== undefined ? logo : current.hostedLogoUrl, opsEmail: body?.opsEmail !== undefined ? opsEmail : current.opsEmail, providerOrder: Array.isArray(body?.providerOrder) ? providerOrder : current.providerOrder });
            return res.json({ ok: true, settings: await this.ledger.getSettings(channelId) });
        } catch (e) { return fail(res, e); }
    }

    @Get('subscriptions')
    async subscriptionsList(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.subscriptions.list({ status: q.status, search: q.q, page: Number(q.page) || 1, perPage: Number(q.perPage) || 50, channelId: scopedChannel(ctx, q.channelId) }));
    }

    /** A subscription an operator may act on: it exists and belongs to a channel the operator can write to. */
    private async ownSubscription(ctx: RequestContext, res: Response, id: string): Promise<boolean> {
        const sub = await this.subscriptions.findOne(Number(id));
        if (!sub) { res.status(404).json({ error: 'not found' }); return false; }
        if (!inDefaultChannel(ctx) && Number(sub.channelId) !== Number(ctx.channelId)) { res.status(403).json({ error: 'forbidden' }); return false; }
        return true;
    }

    @Post('subscriptions/:id/cancel')
    async cancelSubscription(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!(await this.ownSubscription(ctx, res, id))) return;
        try { requirePremium('Subscriptions'); return res.json(await this.subscriptions.cancel(Number(id), body?.atPeriodEnd !== false, `admin:${ctx.activeUserId}`)); }
        catch (e) { return fail(res, e); }
    }

    @Post('subscriptions/:id/pause')
    async pauseSubscription(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!(await this.ownSubscription(ctx, res, id))) return;
        try { requirePremium('Subscriptions'); return res.json(await this.subscriptions.pause(Number(id), false)); } catch (e) { return fail(res, e); }
    }

    @Post('subscriptions/:id/resume')
    async resumeSubscription(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!(await this.ownSubscription(ctx, res, id))) return;
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
        if (!provider.freeTier && !getRuntime().hasPremiumAccess()) return res.status(402).json({ error: 'licence-required', message: `${provider.name} needs a HULO Payments licence`, buyUrl: BUY_URL });
        try {
            const channelId = Number(body?.channelId) || (ctx.channelId as number);
            if (!channelAllowed(ctx, channelId)) return res.status(403).json({ error: 'forbidden' });
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

    /**
     * Add a provider to a channel as a disabled payment method with default
     * args and a descriptive name, so every option is visible in Settings →
     * Payment methods (and in the plugin's Methods tab) before any keys exist.
     * Connect, or the method page, fills the keys in later.
     */
    @Post('methods')
    async addMethod(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!ctx.userHasPermissions([Permission.CreatePaymentMethod])) return res.status(403).json({ error: 'forbidden' });
        const code = String(body?.provider || '');
        const provider = getProvider(code);
        if (!provider) return res.status(404).json({ error: 'unknown provider' });
        try {
            const channelId = Number(body?.channelId) || (ctx.channelId as number);
            if (!channelAllowed(ctx, channelId)) return res.status(403).json({ error: 'forbidden' });
            const existing = (await listHuloMethods(this.connection, channelId)).find(m => m.handlerCode === code && m.channelIds.includes(channelId));
            if (existing) return res.status(200).json({ ok: true, created: false, method: { id: existing.paymentMethodId, code: existing.paymentMethodCode } });
            const adminCtx = await this.payments.adminCtx(channelId);
            // Through the dialect adapter: a bare `?` placeholder is a syntax error on Postgres.
            const channels: any[] = await adapterFor(this.connection.rawConnection).query(`SELECT id, code FROM channel WHERE id = ?`, [channelId]).catch(() => []);
            const channelCode = String(channels[0]?.code || '');
            const suffix = channelId > 1 && channelCode ? `-${channelCode.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}` : '';
            const taken = new Set(((await this.connection.rawConnection.query(`SELECT code FROM payment_method`).catch(() => [])) as any[]).map(r => String(r.code)));
            let methodCode = `${code}${suffix}`.slice(0, 60);
            for (let n = 2; taken.has(methodCode) && n < 50; n++) methodCode = `${code}${suffix}-${n}`.slice(0, 60);
            const args = this.withDefaults(code, {});
            const handler = { code, arguments: Object.entries(args).map(([name, value]) => ({ name, value: String(value ?? '') })) };
            const name = (HANDLER_SHORT_NAMES as any)[code] || `${provider.name} (HULO Payments)`;
            const description = provider.capabilities.offline
                ? 'Not enabled yet: check the details on this method, then enable it. Runs through the HULO Payments plugin.'
                : 'Not set up yet: open this method and paste the keys, or use Connect on the Payments page, then enable it. Runs through the HULO Payments plugin with the same ledger, refunds and dashboard as every other provider.';
            const method: any = await this.paymentMethodService.create(adminCtx, { code: methodCode, enabled: false, handler, translations: [{ languageCode: LanguageCode.en, name, description }] } as any);
            clearCredentialCache();
            return res.status(200).json({ ok: true, created: true, method: { id: method.id, code: method.code } });
        } catch (e) { return fail(res, e); }
    }

    private withDefaults(code: string, args: ProviderArgs): ProviderArgs {
        const defs: any = (HANDLER_ARGS as any)[code] || {};
        const out: ProviderArgs = {};
        for (const [name, def] of Object.entries<any>(defs)) out[name] = args[name] !== undefined && args[name] !== null ? args[name] : (def.defaultValue ?? '');
        return out;
    }

    /**
     * Pay link for any order that still needs payment (draft orders, quotes, phone orders) — free.
     * `mode: 'hosted'` (the default when no `methodCode` is given) is the plugin's own hosted page;
     * `mode: 'provider'` (the default when a `methodCode` is given) a provider-hosted link.
     */
    @Post('pay-link')
    async payLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const mode = body?.mode === 'hosted' || body?.mode === 'provider' ? body.mode : (body?.methodCode ? 'provider' : 'hosted');
        try {
            const link = await this.payLinks.create(ctx, {
                orderCode: String(body?.orderCode || '').trim(), mode, methodCode: body?.methodCode ? String(body.methodCode) : undefined,
                expiresInHours: Number(body?.expiresInHours) || undefined, returnUrl: body?.returnUrl ? String(body.returnUrl) : undefined,
                locale: body?.locale ? String(body.locale) : undefined, createdBy: `admin ${ctx.activeUserId}`,
            });
            return res.json({ ok: true, ...link });
        } catch (e: any) {
            if (e instanceof PayLinkError) {
                const status = e.code === 'order-not-found' ? 404 : e.code === 'licence-required' ? 402 : 400;
                return res.status(status).json({ error: e.code === 'licence-required' ? 'licence-required' : e.message, code: e.code, message: e.message, ...(status === 402 ? { buyUrl: BUY_URL } : {}) });
            }
            return fail(res, e);
        }
    }

    /** Pay links issued for one order (`?orderCode=`). */
    @Get('pay-links')
    async payLinksList(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const code = String(q?.orderCode || '').trim();
        if (!code) return res.status(400).json({ error: 'orderCode required' });
        const order = await this.orderService.findOneByCode(ctx, code.slice(0, 64));
        if (!order) return res.status(404).json({ error: 'order not found' });
        return res.json({ items: await this.payLinks.listForOrder(order.code) });
    }
}
