import { describe, expect, it } from 'vitest';
import { formatStat } from '@huloglobal/vendure-licence-sdk';
import { STAT_DEFS, methodConnected, setupItemsFrom, toDigestStat, webhookConfigured } from './engagement-rules';
import { registerProvider } from './provider';
import { stripeProvider } from '../providers/stripe';
import { mollieProvider } from '../providers/mollie';
import { bankTransferProvider } from '../providers/offline';

for (const p of [stripeProvider, mollieProvider, bankTransferProvider]) registerProvider(p);

const stripe = (args: Record<string, any>, enabled = true) => ({ handlerCode: 'hulo-stripe', enabled, args, channelIds: [1] });
const facts = (over: Partial<Parameters<typeof setupItemsFrom>[0]> = {}) => ({ methods: [], returnHosts: [], opsEmailOption: '', channelOpsEmails: 0, firstPayment: false, ...over });

describe('usage stats', () => {
    it('reports the keys the licence server expects', () => {
        expect(STAT_DEFS.map(d => d.key)).toEqual(['paymentsSettled', 'volumePence', 'refundedPence', 'disputesOpened', 'subscriptionsActive', 'mrrPence', 'payLinkPaidPence', 'renewalsRecovered']);
        expect(STAT_DEFS.filter(d => d.snapshot).map(d => d.key)).toEqual(['subscriptionsActive', 'mrrPence']);
    });
    it('formats money in the store currency and counts as integers', () => {
        const pence = STAT_DEFS.find(d => d.key === 'volumePence')!;
        const count = STAT_DEFS.find(d => d.key === 'paymentsSettled')!;
        expect(formatStat(toDigestStat(pence, 123456, 100000, 'GBP'))).toBe('£1,234.56');
        expect(toDigestStat(pence, 123456, 100000, 'GBP')).toMatchObject({ format: 'pence', previous: 100000 });
        expect(formatStat(toDigestStat(pence, 123456, null, 'EUR'))).toBe('€1,234.56');
        expect(toDigestStat(pence, 0, null, 'EUR')).toMatchObject({ format: 'text', value: 0 });
        expect(toDigestStat(count, 12.4, undefined, 'EUR')).toEqual({ key: 'paymentsSettled', label: 'payments settled', value: 12, previous: null });
    });
});

describe('set-up checklist', () => {
    it('knows when a provider is connected and when its webhook is saved', () => {
        expect(methodConnected(stripe({ secretKey: 'sk_test_1', publishableKey: 'pk_test_1' }))).toBe(true);
        expect(methodConnected(stripe({ secretKey: 'sk_test_1', publishableKey: '' }))).toBe(false);
        expect(methodConnected({ handlerCode: 'hulo-unknown', args: {} })).toBe(false);
        expect(webhookConfigured(stripe({ secretKey: 'x', publishableKey: 'y' }))).toBe(false);
        expect(webhookConfigured(stripe({ secretKey: 'x', publishableKey: 'y', webhookSecret: 'whsec_1' }))).toBe(true);
        expect(webhookConfigured({ handlerCode: 'hulo-mollie', args: { apiKey: 'live_x' } })).toBe(true);
        expect(webhookConfigured({ handlerCode: 'hulo-bank-transfer', args: { accountName: 'HULO' } })).toBe(true);
    });
    it('starts with nothing done and never claims the webhook is set on an empty install', () => {
        const r = setupItemsFrom(facts());
        expect(r.complete).toBe(false);
        expect(r.items.map(i => i.key)).toEqual(['provider', 'method', 'returnHosts', 'opsEmail', 'webhook', 'firstPayment']);
        expect(r.items.every(i => !i.done)).toBe(true);
        expect(r.items.find(i => i.key === 'webhook')!.label).toBe("Save each connected provider's webhook secret");
        expect(r.items.filter(i => i.tab).map(i => i.tab)).toEqual(['providers', 'methods', 'settings', 'providers', 'transactions']);
        expect(r.items.find(i => i.key === 'returnHosts')!.url).toMatch(/^https:\/\/huloglobal\.com\//);
    });
    it('names the providers whose webhook secret is missing and ignores unconnected methods', () => {
        const r = setupItemsFrom(facts({ methods: [stripe({ secretKey: 'sk', publishableKey: 'pk' }), { handlerCode: 'hulo-mollie', enabled: false, args: {}, channelIds: [1] }] }));
        const by = Object.fromEntries(r.items.map(i => [i.key, i]));
        expect(by.provider.done).toBe(true);
        expect(by.method.done).toBe(true);
        expect(by.webhook.done).toBe(false);
        expect(by.webhook.label).toBe('Save the webhook secret for Stripe');
    });
    it('is complete once every check passes', () => {
        const r = setupItemsFrom(facts({
            methods: [stripe({ secretKey: 'sk', publishableKey: 'pk', webhookSecret: 'whsec' })],
            returnHosts: ['shop.example.com'], channelOpsEmails: 1, firstPayment: true,
        }));
        expect(r.complete).toBe(true);
        expect(setupItemsFrom(facts({ methods: [stripe({ secretKey: 'sk', publishableKey: 'pk', webhookSecret: 'whsec' }, false)], returnHosts: ['x'], opsEmailOption: 'ops@example.com', firstPayment: true })).items.find(i => i.key === 'method')!.done).toBe(false);
    });
});
