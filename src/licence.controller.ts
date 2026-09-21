import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Ctx, Permission, RequestContext } from '@vendure/core';
import { Response } from 'express';
import { describeLicence, evalInstanceId, performSelfUpdate, selfUpdateEnv } from '@huloglobal/vendure-licence-sdk';
import { HuloPaymentsPlugin, getOptions } from './plugin';
import { HuloPaymentsLicenceService } from './licence.service';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'forbidden' });
        return true;
    }
    return false;
}

/**
 * Plugin-level admin endpoints: version + update banner, effective
 * settings, and the licence lifecycle (activate / deactivate /
 * buy-from-admin / billing portal). Feature endpoints live in the
 * module controllers under the same `/checkout-guard` prefix.
 */
@Controller('hulo-payments')
export class HuloPaymentsLicenceController {
    constructor(private licence: HuloPaymentsLicenceService) {}

    @Get('meta')
    async meta(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const updater = HuloPaymentsPlugin.getUpdateChecker();
        const licence = HuloPaymentsPlugin.getLicenceStatus();
        return res.json({
            name: HuloPaymentsPlugin.getPackageName(),
            version: HuloPaymentsPlugin.getPackageVersion(),
            update: updater ? updater.getStatus() : null,
            selfUpdate: selfUpdateEnv(),
            licensed: !!licence?.valid,
            licence: describeLicence(licence),
            licenceMessage: licence?.valid ? '' : (licence?.message || 'No licence key configured'),
            tier: licence?.valid ? 'paid' : (HuloPaymentsPlugin.getEvalState()?.active ? 'trial' : 'free'),
            eval: HuloPaymentsPlugin.getEvalState(),
        });
    }

    /** Effective options as the plugin sees them (secrets never included). */
    @Get('options')
    async options(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const o = getOptions();
        return res.json({ premium: HuloPaymentsPlugin.hasPremiumAccess(), publicBaseUrl: o.publicBaseUrl, ops: { webhook: !!o.ops?.webhookUrl, email: !!o.ops?.email } });
    }

    @Post('update/run')
    async updateRun(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const updater = HuloPaymentsPlugin.getUpdateChecker();
        const target = String(body?.version || updater?.getStatus()?.latest || '').trim();
        if (!target) return res.status(400).json({ ok: false, message: 'No target version known yet — the registry check runs daily; try again shortly.' });
        const result = await performSelfUpdate({ packageName: HuloPaymentsPlugin.getPackageName(), targetVersion: target });
        return res.status(result.ok ? 200 : 400).json(result);
    }

    @Post('licence/activate')
    async licenceActivate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const key = String(body?.key || '').trim();
        if (!key) return res.status(400).json({ licensed: false, message: 'Paste your licence key first.' });
        const status = HuloPaymentsPlugin.activateRuntimeLicence(key);
        if (!status.valid) return res.status(400).json({ licensed: false, message: status.message || 'Invalid licence key.' });
        await this.licence.saveStoredLicenceKey(key);
        return res.json({ licensed: true, message: status.message });
    }

    @Post('licence/deactivate')
    async licenceDeactivate(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        await this.licence.clearStoredLicenceKey();
        HuloPaymentsPlugin.deactivateRuntimeLicence();
        return res.json({ licensed: false });
    }

    @Post('licence/purchase-link')
    async licencePurchaseLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const plan = (['monthly', 'annual', 'lifetime'].includes(String(body?.plan)) ? String(body.plan) : 'annual') as 'monthly' | 'annual' | 'lifetime';
        try {
            const r = await this.purchaseClaimClient().createPurchaseLink(plan, String(body?.email || '').trim() || undefined);
            return res.json({ url: r.url, state: 'pending' });
        } catch (e: any) {
            return res.status(500).json({ message: e?.message || 'Could not start the purchase — try again shortly.' });
        }
    }

    @Get('licence/claim-status')
    async licenceClaimStatus(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('check') check?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const client = this.purchaseClaimClient();
        const st = check ? await client.checkNow() : await client.status();
        return res.json({ ...st, licensed: HuloPaymentsPlugin.isLicensed() });
    }

    @Post('licence/portal-link')
    async licencePortalLink(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        let storedKey: string | null = null;
        try { storedKey = await this.licence.loadStoredLicenceKey(); } catch { storedKey = null; }
        const url = await this.purchaseClaimClient().billingPortalUrl(storedKey);
        if (!url) return res.status(404).json({ message: 'No billing portal is available for this licence (lifetime and master licences have nothing to manage; for a key set via the environment, reply to your receipt email for a portal link).' });
        return res.json({ url });
    }

    @Post('eval/remind-me')
    async evalRemindMe(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const email = String(body?.email || '').trim();
        const instanceId = HuloPaymentsPlugin.getEvalInstanceId();
        if (!email || !instanceId) return res.status(400).json({ error: 'bad-request' });
        try {
            const base = (process.env.HULO_LICENCE_EVAL_URL || 'https://elite.charity/licence/eval/register').replace(/\/register$/, '');
            const resp = await fetch(`${base}/lead`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: HuloPaymentsPlugin.getPackageName(), instanceId, email }),
            });
            if (!resp.ok) return res.status(502).json({ error: 'upstream', status: resp.status });
            return res.json({ ok: true });
        } catch {
            return res.status(502).json({ error: 'unreachable' });
        }
    }

    private purchaseClaimClient() {
        return this.licence.initPurchaseClaim({
            packageName: HuloPaymentsPlugin.getPackageName(),
            instanceId: () => evalInstanceId(),
            onLicence: async (key: string) => {
                const status = HuloPaymentsPlugin.activateRuntimeLicence(key);
                if (!status.valid) return false;
                await this.licence.saveStoredLicenceKey(key);
                return true;
            },
        });
    }

    async onApplicationBootstrap() {
        await this.purchaseClaimClient().resume().catch(() => undefined);
    }
}
