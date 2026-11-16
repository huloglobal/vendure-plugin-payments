import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCENT, renderEmail, safeAccent } from './email-layout';
import { composeOpsMail } from '../plugin';
import { configureRuntime } from './runtime';
import { registerProvider } from './provider';
import { stripeProvider } from '../providers/stripe';
import { PayLinkService } from './pay-link.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { HuloPaymentsAdminController } from './admin.controller';

registerProvider(stripeProvider);

describe('shared e-mail design (0.5.0)', () => {
    const brand = { storeName: 'Acme <Tools>', accentColor: '#ff6600', supportEmail: 'help@acme.test', footerText: 'Acme Ltd, 1 High St' };
    const content = {
        heading: 'Dispute opened on <b>ORD1</b>', paragraphs: ['Stripe reported a "new" dispute & more.'],
        details: { title: 'Details', rows: [{ label: 'Payment ref', value: 'pi_123', mono: true }] },
        warning: { text: 'Respond before the deadline.' }, primaryButton: { label: 'Open', url: 'https://shop.test/admin' },
    };

    it('is a 600px white card on grey with the accent bar, inline styles only', () => {
        const { html } = renderEmail(brand, content);
        expect(html).toContain('background-color:#f3f4f6');
        expect(html).toContain('max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px');
        expect(html).toContain('border-bottom:3px solid #ff6600');
        expect(html).toContain('font-size:22px');
        expect(html).toContain('background-color:#fffbeb;border:1px solid #fde68a');
        expect(html).toContain('background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px');
        expect(html).toContain('Consolas');
        expect(html).not.toMatch(/<style/i);
        expect(html).toContain('Kind regards,');
        expect(html).toContain('font-size:11px');
    });

    it('escapes every interpolated value', () => {
        const { html } = renderEmail(brand, content);
        expect(html).toContain('Acme &lt;Tools&gt;');
        expect(html).toContain('Dispute opened on &lt;b&gt;ORD1&lt;/b&gt;');
        expect(html).toContain('&quot;new&quot; dispute &amp; more');
        expect(html).not.toContain('<b>ORD1');
    });

    it('has a plain-text alternative with the same content', () => {
        const { text } = renderEmail(brand, content);
        expect(text).toContain('Dispute opened on <b>ORD1</b>');
        expect(text).toContain('Payment ref: pi_123');
        expect(text).toContain('Open: https://shop.test/admin');
        expect(text).toContain('Kind regards,\nAcme <Tools>\nhelp@acme.test');
        expect(text).toContain('Acme Ltd, 1 High St');
    });

    it('falls back to the default accent and the store name; refuses unsafe URLs', () => {
        expect(safeAccent('red;background:url(x)')).toBe(DEFAULT_ACCENT);
        expect(safeAccent('#abc')).toBe('#abc');
        const { html } = renderEmail({ storeName: 'Shop', logoUrl: 'javascript:alert(1)' }, { heading: 'Hi', primaryButton: { label: 'Go', url: 'javascript:x' } });
        expect(html).toContain(`border-bottom:3px solid ${DEFAULT_ACCENT}`);
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('<img');
        const logo = renderEmail({ storeName: 'Shop', logoUrl: 'https://cdn.test/logo.png' }, { heading: 'Hi' }).html;
        expect(logo).toMatch(/<img src="https:\/\/cdn\.test\/logo\.png" alt="Shop" width="140"/);
    });
});

describe('ops alert e-mails (0.5.0)', () => {
    it('are compact, branded per channel, with HTML and text and the order code as a reference', () => {
        const mail = composeOpsMail(
            { kind: 'payments.dispute.opened', subject: 'Stripe dispute opened on order ORD9', text: 'Stripe reported a new dispute.', orderCode: 'ORD9', channelId: 2, warning: 'Respond in time.' },
            { storeName: 'Channel Two', accentColor: '#0a7d32', logoUrl: null },
            { accentColor: '#999999', footerText: 'Two Ltd' }, 'https://shop.test/admin/extensions/hulo-payments');
        expect(mail.subject).toBe('[Payments] Stripe dispute opened on order ORD9');
        expect(mail.html).toContain('border-bottom:3px solid #0a7d32');
        expect(mail.html).toContain('Channel Two');
        expect(mail.html).toContain('Open Payments in Admin');
        expect(mail.text).toContain('Order: ORD9');
        expect(mail.text).toContain('Respond in time.');
        expect(mail.text).toContain('Two Ltd');
    });
    it('use the plugin email options when the channel has no branding', () => {
        const mail = composeOpsMail({ kind: 'x', subject: 'S', text: 'T' }, { storeName: '', accentColor: null, logoUrl: null }, { accentColor: '#123456', storeName: 'Fallback Shop' });
        expect(mail.html).toContain('border-bottom:3px solid #123456');
        expect(mail.html).toContain('Fallback Shop');
        expect(mail.html).not.toContain('Open Payments in Admin');
    });
});

describe('pay links refuse a disabled method chosen by code (0.5.0)', () => {
    afterEach(() => configureRuntime({ hasPremiumAccess: () => false }));
    it('a disabled Stripe method cannot issue a provider link', async () => {
        const order = { id: 7, code: 'ORD7', state: 'Draft', totalWithTax: 2599, currencyCode: 'GBP', channels: [{ id: 1, code: '__default_channel__' }], lines: [], payments: [], customer: { emailAddress: 'c@example.com' } };
        const connection = { rawConnection: { options: { type: 'mysql' }, query: vi.fn(async () => [{ id: 1, code: 'stripe', enabled: 0, handler: JSON.stringify({ code: 'hulo-stripe', args: [] }) }]) } };
        const svc = new PayLinkService(connection as any, { findOneByCode: vi.fn(async () => order) } as any, { record: vi.fn() } as any, {} as any);
        await expect(svc.create({ channelId: 1 } as any, { orderCode: 'ORD7', mode: 'provider', methodCode: 'stripe' })).rejects.toMatchObject({ code: 'no-provider', message: expect.stringContaining('disabled') });
    });
});

describe('subscriptions are scoped to the operator\'s channel (0.5.0)', () => {
    const resMock = () => {
        const r: any = { code: 200, body: null };
        r.status = (c: number) => { r.code = c; return r; };
        r.json = (b: any) => { r.body = b; return r; };
        return r;
    };
    const ctx = (channelId: number, code: string) => ({ channelId, channel: { code }, apiType: 'admin', userHasPermissions: () => true, activeUserId: 1, session: { token: 't' } }) as any;

    it('the list filters by channel and stats can be per channel', async () => {
        const queries: Array<[string, any[]]> = [];
        const db = { rawConnection: { options: { type: 'mysql' }, query: vi.fn(async (sql: string, params: any[] = []) => { queries.push([sql, params]); return /COUNT/.test(sql) ? [{ n: 0 }] : []; }) } };
        const svc = new SubscriptionService(db as any, {} as any);
        await svc.list({ channelId: 3 });
        expect(queries[0][0]).toContain('WHERE channelId = ?');
        expect(queries[0][1]).toEqual([3]);
        await svc.stats(3);
        expect(queries.at(-1)![0]).toContain('WHERE channelId = ?');
        await svc.stats();
        expect(queries.at(-1)![0]).not.toContain('WHERE');
    });

    it('an operator in another channel cannot cancel, pause or resume a subscription', async () => {
        const subs = { findOne: vi.fn(async () => ({ id: 5, channelId: 1 })), cancel: vi.fn(async () => ({})), pause: vi.fn(async () => ({})), list: vi.fn(async () => ({ items: [] })) };
        const c = new HuloPaymentsAdminController({} as any, {} as any, {} as any, {} as any, subs as any, {} as any, {} as any, {} as any);
        configureRuntime({ hasPremiumAccess: () => true });
        for (const call of [(r: any) => c.cancelSubscription(ctx(2, 'two'), r, '5', {}), (r: any) => c.pauseSubscription(ctx(2, 'two'), r, '5'), (r: any) => c.resumeSubscription(ctx(2, 'two'), r, '5')]) {
            const r = resMock();
            await call(r);
            expect(r.code).toBe(403);
        }
        expect(subs.cancel).not.toHaveBeenCalled();
        expect(subs.pause).not.toHaveBeenCalled();
        const ok = resMock();
        await c.cancelSubscription(ctx(1, '__default_channel__'), ok, '5', {});
        expect(subs.cancel).toHaveBeenCalled();
        const list = resMock();
        await c.subscriptionsList(ctx(2, 'two'), list, { channelId: '1' });
        expect(subs.list).toHaveBeenCalledWith(expect.objectContaining({ channelId: 2 }));
        configureRuntime({ hasPremiumAccess: () => false });
    });

    it('webhook events are only listed in the default channel', async () => {
        const ledger = { recentEvents: vi.fn(async () => [{ eventId: 'evt_1' }]) };
        const c = new HuloPaymentsAdminController({} as any, {} as any, ledger as any, {} as any, {} as any, {} as any, {} as any, {} as any);
        const other = resMock();
        await c.events(ctx(2, 'two'), other);
        expect(other.body).toEqual([]);
        const def = resMock();
        await c.events(ctx(1, '__default_channel__'), def);
        expect(def.body).toEqual([{ eventId: 'evt_1' }]);
    });
});

describe('hosted page: an unknown link still gets the security headers (0.5.0)', () => {
    it('404 carries no-store, frame-ancestors and DENY', async () => {
        const { HostedCheckoutController } = await import('./hosted.controller');
        const c = new HostedCheckoutController({ find: vi.fn(async () => null) } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
        const r: any = { headers: {} as Record<string, string>, code: 200 };
        r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
        r.status = (n: number) => { r.code = n; return r; };
        r.type = () => r;
        r.send = (b: string) => { r.body = b; return r; };
        await c.page('f'.repeat(48), { socket: { remoteAddress: '203.0.113.50' }, headers: {} } as any, r);
        expect(r.code).toBe(404);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['x-frame-options']).toBe('DENY');
        expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    });
});
