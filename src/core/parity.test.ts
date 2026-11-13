import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedWindowLimiter, clientIp, configureRateLimits, isPrivateIp, limitFor, rateLimited } from './rate-limit';
import { fallbackActive, fallbackSuggestions, reorderAfterFailure } from './fallback';
import { renderHostedPage } from './hosted-page';
import { PREMIUM_FEATURES } from './engagement-rules';
import { normaliseStripeEvent, stripeProvider } from '../providers/stripe';
import { adyenProvider } from '../providers/adyen';
import { bankTransferProvider } from '../providers/offline';
import { registerProvider } from './provider';
import { configureRuntime } from './runtime';
import { PayLinkService, PayLinkError } from './pay-link.service';
import { PremiumWeeklyDigest } from './premium-digest';

for (const p of [stripeProvider, adyenProvider, bankTransferProvider]) registerProvider(p);

const req = (peer: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers } as any);
const resMock = () => {
    const r: any = { headers: {} as Record<string, string>, code: 0, body: null };
    r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
    r.status = (c: number) => { r.code = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    return r;
};

describe('per-IP rate limits on public routes', () => {
    afterEach(() => configureRateLimits(undefined));

    it('counts a fixed window per key and says how long to wait', () => {
        const l = new FixedWindowLimiter(3, 60_000);
        expect([l.hit('a', 0), l.hit('a', 1), l.hit('a', 2)]).toEqual([0, 0, 0]);
        expect(l.hit('a', 10_000)).toBe(50);
        expect(l.hit('b', 10_000)).toBe(0);
        expect(l.hit('a', 60_001)).toBe(0); // new window
    });

    it('uses the TCP peer unless it is a private proxy address', () => {
        expect(clientIp(req('203.0.113.9', { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }))).toBe('203.0.113.9');
        expect(clientIp(req('::ffff:127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' }))).toBe('198.51.100.7');
        expect(clientIp(req('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.8, 192.168.1.25' }))).toBe('198.51.100.8');
        expect(clientIp(req('::1', { 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
        expect(clientIp(req('::1'))).toBe('::1');
        expect(isPrivateIp('172.20.1.1')).toBe(true);
        expect(isPrivateIp('172.32.1.1')).toBe(false);
        expect(isPrivateIp('fd00::1')).toBe(true);
        expect(isPrivateIp('2001:db8::1')).toBe(false);
    });

    it('answers 429 with Retry-After over the limit, and can be configured or switched off', () => {
        configureRateLimits({ hostedAction: 2 });
        expect(limitFor('hostedAction')).toBe(2);
        expect(limitFor('webhook')).toBe(1200);
        const r = req('198.51.100.20');
        expect(rateLimited(r, resMock(), 'hostedAction')).toBe(false);
        expect(rateLimited(r, resMock(), 'hostedAction')).toBe(false);
        const res = resMock();
        expect(rateLimited(r, res, 'hostedAction')).toBe(true);
        expect(res.code).toBe(429);
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        configureRateLimits(false);
        for (let i = 0; i < 5; i++) expect(rateLimited(r, resMock(), 'hostedAction')).toBe(false);
    });
});

describe('fallback after a decline (B9)', () => {
    const offered = [
        { methodCode: 'stripe', provider: 'hulo-stripe', name: 'Card', preferred: true },
        { methodCode: 'paypal', provider: 'hulo-paypal', name: 'PayPal', preferred: false },
        { methodCode: 'bank', provider: 'hulo-bank-transfer', name: 'Bank transfer', preferred: false },
    ];
    it('is active only with the channel switch and premium access', () => {
        expect(fallbackActive({ fallbackOnFailure: true }, true)).toBe(true);
        expect(fallbackActive({ fallbackOnFailure: true }, false)).toBe(false);
        expect(fallbackActive({ fallbackOnFailure: false }, true)).toBe(false);
    });
    it('moves the failed method last and prefers the next one in routing order', () => {
        const r = reorderAfterFailure(offered, 'stripe');
        expect(r.map(p => p.methodCode)).toEqual(['paypal', 'bank', 'stripe']);
        expect(r.map(p => p.preferred)).toEqual([true, false, false]);
        expect(fallbackSuggestions(offered, 'stripe')).toEqual([{ methodCode: 'paypal', name: 'PayPal' }, { methodCode: 'bank', name: 'Bank transfer' }]);
    });
    it('leaves the offer alone for an unknown method or a single method', () => {
        expect(reorderAfterFailure(offered, 'nope')).toBe(offered);
        expect(reorderAfterFailure([offered[0]], 'stripe')).toEqual([offered[0]]);
        expect(fallbackSuggestions([offered[0]], 'stripe')).toEqual([]);
    });
    it('the hosted page knows how to show the suggestions', () => {
        const html = renderHostedPage({ token: 'a'.repeat(48), orderCode: 'O1', amount: 100, currency: 'GBP', locale: 'en-GB', customerEmail: '', brand: 'Shop', accent: '#123456', logoUrl: '', cancelUrl: '', providers: [], returned: false, lines: [] });
        expect(html).toContain('function offerFallback(list, message)');
        expect(html).toContain('offerFallback(r.fallback, r.message)');
    });
});

describe('tiers (0.4.0)', () => {
    it('PREMIUM_FEATURES no longer sells the free hosted page, pay links or routing', () => {
        const all = PREMIUM_FEATURES.join(' | ');
        expect(all).not.toMatch(/hosted checkout|pay-by-link|pay link|routing/i);
        expect(all).toMatch(/Weekly report and set-up checklist/);
        expect(all).toMatch(/Fallback/);
    });
});

describe('dashboard-refund events', () => {
    it('charge.refunded carries the running refunded total', () => {
        const ev = normaliseStripeEvent({ id: 'evt_1', type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', currency: 'gbp', amount_refunded: 1500, metadata: { vendureOrderId: '1', orderCode: 'O1' }, refunds: { data: [] } } } });
        expect(ev).toMatchObject({ type: 'refund.settled', paymentRef: 'pi_1', refundedTotal: 1500, refundRef: undefined, refundAmount: undefined });
    });
    it('Stripe lists a payment intent\'s refunds', async () => {
        const realFetch = globalThis.fetch;
        let url = '';
        (globalThis as any).fetch = async (u: string) => { url = u; return new Response(JSON.stringify({ data: [{ id: 're_1', amount: 500, currency: 'gbp', status: 'succeeded', created: 2 }, { id: 're_2', amount: 100, currency: 'gbp', status: 'canceled', created: 3 }] }), { status: 200 }); };
        try {
            const list = await stripeProvider.listRefunds!({ secretKey: 'sk_test_x' }, 'pi_123');
            expect(url).toBe('https://api.stripe.com/v1/refunds?payment_intent=pi_123&limit=100');
            expect(list).toEqual([{ id: 're_1', amount: 500, status: 'succeeded', created: 2 }, { id: 're_2', amount: 100, status: 'failed', created: 3 }]);
            expect(await stripeProvider.listRefunds!({ secretKey: 'sk_test_x' }, 'evil/../x')).toEqual([]);
        } finally { (globalThis as any).fetch = realFetch; }
    });
});

describe('weekly report is premium (0.4.0)', () => {
    const prefs = { all: vi.fn(async () => ({})), get: vi.fn(async () => null), set: vi.fn(), cas: vi.fn(async () => true), casDelete: vi.fn() } as any;
    const opts = { pluginId: 'p', pluginName: 'Payments', prefs, collect: vi.fn(async () => ({ stats: [] } as any)), send: vi.fn(async () => true), defaultRecipient: () => 'ops@example.com' };
    it('the scheduler sends nothing without premium access', async () => {
        const d = new PremiumWeeklyDigest(opts as any, () => false);
        expect(await d.tick(new Date('2026-11-16T09:00:00'))).toBe(false);
        expect(prefs.all).not.toHaveBeenCalled();
        expect(opts.send).not.toHaveBeenCalled();
    });
    it('"send me a test" refuses without premium access', async () => {
        const d = new PremiumWeeklyDigest(opts as any, () => false);
        const r = await d.sendNow('me@example.com');
        expect(r).toMatchObject({ sent: false, reason: 'licence-required' });
        expect(opts.send).not.toHaveBeenCalled();
    });
    it('runs as before with premium access', async () => {
        const d = new PremiumWeeklyDigest(opts as any, () => true);
        await d.tick(new Date('2026-11-16T09:00:00'));
        expect(prefs.all).toHaveBeenCalled();
    });
});

describe('pay-link service API', () => {
    afterEach(() => configureRuntime({ hasPremiumAccess: () => false }));
    const order = (over: any = {}) => ({ id: 7, code: 'ORD7', state: 'Draft', totalWithTax: 2599, currencyCode: 'GBP', channels: [{ id: 1, code: '__default_channel__' }], lines: [], customer: { emailAddress: 'c@example.com' }, ...over });
    const make = (o: any, methods: any[] = []) => {
        const ledger = { record: vi.fn(async () => 1), payLinksFor: vi.fn(async () => []) };
        const hosted = { create: vi.fn(async () => ({ id: 42, token: 'b'.repeat(48), expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString() })) };
        const orderService = { findOneByCode: vi.fn(async () => o), findOne: vi.fn(async () => o) };
        const connection = { rawConnection: { options: { type: 'mysql' }, query: vi.fn(async () => methods.map(m => ({ id: 1, code: m.code, enabled: 1, handler: JSON.stringify({ code: m.handler, args: m.args || [] }) }))) } };
        const svc = new PayLinkService(connection as any, orderService as any, ledger as any, hosted as any);
        return { svc, ledger, hosted };
    };
    const ctx = { channelId: 1, activeUserId: 3 } as any;
    it('issues a hosted-page link by default, free, recorded as a pending paylink', async () => {
        configureRuntime({ publicBaseUrl: () => 'https://shop.example' });
        const { svc, ledger, hosted } = make(order());
        const r = await svc.create(ctx, { orderCode: 'ORD7', expiresInHours: 72, createdBy: 'quotation:Q-1' });
        expect(r).toMatchObject({ mode: 'hosted', provider: 'hulo-hosted', ref: 'hosted:42', amount: 2599, currency: 'GBP', orderCode: 'ORD7', url: `https://shop.example/hulo-payments/pay/${'b'.repeat(48)}` });
        expect((hosted.create.mock.calls[0] as any[])[7]).toEqual({ ttlMs: 72 * 3600_000, payLink: true });
        expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hulo-hosted', kind: 'paylink', status: 'pending', orderCode: 'ORD7', reason: 'created by quotation:Q-1' }));
    });
    it('refuses bad input and orders that cannot take a payment', async () => {
        await expect(make(order()).svc.create(ctx, { orderCode: 'X', mode: 'nope' as any })).rejects.toMatchObject({ code: 'invalid-input' });
        await expect(make(order()).svc.create(ctx, {})).rejects.toMatchObject({ code: 'invalid-input' });
        await expect(make(undefined).svc.create(ctx, { orderCode: 'X' })).rejects.toMatchObject({ code: 'order-not-found' });
        await expect(make(order({ state: 'PaymentSettled' })).svc.create(ctx, { orderCode: 'X' })).rejects.toBeInstanceOf(PayLinkError);
        await expect(make(order({ totalWithTax: 0 })).svc.create(ctx, { orderCode: 'X' })).rejects.toMatchObject({ code: 'order-not-payable' });
    });
    it('provider links: unlicensed providers need a licence, no provider is a clear error', async () => {
        const adyen = make(order(), [{ code: 'adyen', handler: 'hulo-adyen' }]);
        await expect(adyen.svc.create(ctx, { orderCode: 'ORD7', mode: 'provider', methodCode: 'adyen' })).rejects.toMatchObject({ code: 'licence-required' });
        await expect(make(order(), []).svc.create(ctx, { orderCode: 'ORD7', mode: 'provider' })).rejects.toMatchObject({ code: 'no-provider' });
    });
});
