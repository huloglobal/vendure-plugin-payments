import { afterEach, describe, expect, it, vi } from 'vitest';
import { js, renderHostedPage } from './hosted-page';
import { addInterval, SubscriptionService } from '../subscriptions/subscription.service';
import { parseHandler, redactArgs } from './credentials';
import { configureRuntime } from './runtime';

const model = (over: Partial<Parameters<typeof renderHostedPage>[0]> = {}) => ({
    token: 'a'.repeat(48), orderCode: 'ORD1', amount: 1234, currency: 'GBP', locale: 'en-GB', customerEmail: 'a@b.co',
    brand: 'Shop', accent: '#123456', logoUrl: '', cancelUrl: 'https://shop.example/cart',
    providers: [{ methodCode: 'stripe', provider: 'hulo-stripe', name: 'Card', wallets: [], offline: false, surcharge: null }],
    returned: false, preselect: '', lines: [{ name: 'Thing', quantity: 1, total: 1234 }], ...over,
});

describe('hosted page hardening', () => {
    it('js() can never close the script block', () => {
        const out = js('</script><script>alert(1)</script>');
        expect(out).not.toContain('</script>');
        expect(JSON.parse(out.replace(/\\u003c/g, '<'))).toBe('</script><script>alert(1)</script>');
        expect(js('a b')).toContain('\\u2028');
    });
    it('a hostile preselect / line name / locale is neutralised in the rendered page', () => {
        const html = renderHostedPage(model({ preselect: '</script><img src=x onerror=alert(1)>', lines: [{ name: '<img src=x onerror=alert(1)>', quantity: 1, total: 1 }], locale: '"><script>' }));
        expect(html).not.toMatch(/<img src=x onerror/);
        expect(html.split('</script>').length).toBe(2); // exactly the one real closing tag
        expect(html).toMatch(/<html lang="[a-zA-Z]{0,3}">/);
    });
});

describe('calendar intervals', () => {
    it('adds months and years on the calendar, not in 30-day blocks', () => {
        expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'month', 1).toISOString()).toBe('2026-03-03T10:00:00.000Z'); // JS overflow: Feb 31 → Mar 3 (documented Date behaviour)
        expect(addInterval(new Date('2026-03-15T10:00:00Z'), 'month', 1).toISOString()).toBe('2026-04-15T10:00:00.000Z');
        expect(addInterval(new Date('2026-03-15T10:00:00Z'), 'year', 1).toISOString()).toBe('2027-03-15T10:00:00.000Z');
        expect(addInterval(new Date('2026-03-15T10:00:00Z'), 'week', 2).toISOString()).toBe('2026-03-29T10:00:00.000Z');
        expect(addInterval(new Date('2026-03-15T10:00:00Z'), 'day', 3).toISOString()).toBe('2026-03-18T10:00:00.000Z');
    });
});

describe('failed-renewal webhook', () => {
    afterEach(() => configureRuntime({ notifyOps: async () => undefined }));

    it('answers the provider without waiting for the ops e-mail', async () => {
        const sub = { id: 7, provider: 'hulo-stripe', providerSubscriptionRef: 'sub_1', channelId: 2, customerEmail: 'c@example.test', orderId: 9, orderCode: 'ORD9',
            variantId: 3, variantName: 'Plan', quantity: 1, amount: 1000, currency: 'GBP', interval: 'month', intervalCount: 1, status: 'active', failures: 0, cancelAtPeriodEnd: 0, selfScheduled: 0 };
        const queries: string[] = [];
        const rawConnection = {
            options: { type: 'mysql' },
            async query(sql: string) { queries.push(sql); return sql.startsWith('SELECT * FROM hulo_subscription') ? [sub] : []; },
        };
        const ledger = { record: vi.fn(async () => undefined) };
        // A mail server that never answers.
        const notifyOps = vi.fn(() => new Promise<void>(() => undefined));
        configureRuntime({ notifyOps });
        const svc = new SubscriptionService({ rawConnection } as any, ledger as any);
        const outcome = await Promise.race([
            svc.applyEvent('hulo-stripe', { id: 'in_1', type: 'subscription.payment_failed', subscriptionRef: 'sub_1', reason: 'card declined' } as any, {} as any).then(() => 'answered'),
            new Promise(resolve => setTimeout(() => resolve('still waiting for the e-mail'), 1_000)),
        ]);
        expect(outcome).toBe('answered');
        expect(queries).toContainEqual(expect.stringMatching(/^UPDATE hulo_subscription SET status = \?, failures = \?/));
        expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'renewal', status: 'failed', orderCode: 'ORD9' }));
        expect(notifyOps).toHaveBeenCalledWith(expect.objectContaining({ kind: 'payments.subscription.past_due', orderCode: 'ORD9', channelId: 2 }));
    });
});

describe('handler args', () => {
    it('keeps leading zeros (account numbers) as strings and still coerces plain numbers and booleans', () => {
        const { args } = parseHandler(JSON.stringify({ code: 'hulo-bank-transfer', args: [
            { name: 'accountNumber', value: '01234567' }, { name: 'sortCode', value: '040004' }, { name: 'termsDays', value: '14' }, { name: 'enabled', value: 'true' },
        ] }));
        expect(args.accountNumber).toBe('01234567');
        expect(args.sortCode).toBe('040004');
        expect(args.termsDays).toBe(14);
        expect(args.enabled).toBe(true);
    });
    it('redacts short secrets completely', () => {
        const r = redactArgs({ secretKey: 'secret_abcdefghijklmnopqrstuvwxyz', webhookSecret: 'shortkey', publishableKey: 'pk_test_1' });
        expect(r.secretKey).toBe('secret…wxyz');
        expect(r.webhookSecret).toBe('••••••••');
        expect(r.publishableKey).toBe('pk_test_1');
    });
});
