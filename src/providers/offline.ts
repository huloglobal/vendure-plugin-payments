import { Order, RequestContext } from '@vendure/core';
import { ClientSession, CredentialCheck, PaymentOutcome, PaymentProvider, ProviderArgs, SessionOptions, WebhookVerification } from '../core/provider';

const noWebhook = async (): Promise<WebhookVerification> => ({ ok: false, events: [], error: 'this method has no webhooks' });

function fill(template: string, order: Order, vars: Record<string, string>): string {
    return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? (k === 'orderCode' ? order.code : ''));
}

/**
 * Bank transfer: the customer pays from their bank using the order code as
 * the reference. The order sits in PaymentAuthorized until an admin marks
 * the payment settled from the order page. Free tier.
 */
export const bankTransferProvider: PaymentProvider = {
    code: 'hulo-bank-transfer',
    name: 'Bank transfer',
    freeTier: true,
    capabilities: { offline: true, session: true, manualCapture: true, partialCapture: false, refund: true, partialRefund: true, savedMethods: false, subscriptions: false, payByLink: false, disputes: false, wallets: [] },
    connectFields: ['accountName', 'sortCode', 'accountNumber', 'iban', 'bic', 'instructions'],
    publicConfig() { return {}; },
    dashboardLinks() { return { dashboard: '', docs: 'https://huloglobal.com/vendure-plugins/payments/docs/' }; },
    async verifyCredentials(args): Promise<CredentialCheck> {
        if (!args.accountName || (!args.accountNumber && !args.iban)) return { ok: false, message: 'Account name and either sort code + account number or IBAN are required.' };
        return { ok: true, message: `Bank transfer will show payments to ${args.accountName}.`, account: String(args.accountName) };
    },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs, _opts: SessionOptions): Promise<ClientSession> {
        const lines = [
            `Account name: ${args.accountName || ''}`,
            args.sortCode ? `Sort code: ${args.sortCode}` : '', args.accountNumber ? `Account number: ${args.accountNumber}` : '',
            args.iban ? `IBAN: ${args.iban}` : '', args.bic ? `BIC: ${args.bic}` : '',
            `Reference: ${order.code}`,
        ].filter(Boolean).join('\n');
        return { provider: 'hulo-bank-transfer', flow: 'instructions', instructions: `${lines}${args.instructions ? `\n\n${fill(args.instructions, order, {})}` : ''}`, amount: order.totalWithTax, currency: order.currencyCode, config: { accountName: args.accountName, sortCode: args.sortCode, accountNumber: args.accountNumber, iban: args.iban, bic: args.bic, reference: order.code } };
    },
    async confirmPayment(_ctx, order, args): Promise<PaymentOutcome> {
        return { state: 'Authorized', amount: order.totalWithTax, transactionId: `bank:${order.code}`, metadata: { capture: 'manual', public: { method: 'bank-transfer', reference: order.code, accountName: args.accountName, sortCode: args.sortCode, accountNumber: args.accountNumber, iban: args.iban, bic: args.bic } } };
    },
    async capture() { return { success: true }; },
    async cancel() { return { success: true }; },
    async refund(_args, paymentRef, amount) { return { state: 'Pending', transactionId: `${paymentRef}:refund:${Date.now().toString(36)}`, metadata: { note: `Refund ${amount} by bank transfer, then settle the refund in Vendure.` } }; },
    verifyWebhook: noWebhook,
};

/**
 * Pay later / on invoice: the order is placed on account and paid on the
 * merchant's terms. Pair it with the rules checker (customer groups,
 * signed-in only) to offer it to approved accounts only. Free tier.
 */
export const payLaterProvider: PaymentProvider = {
    code: 'hulo-pay-later',
    name: 'Pay later (invoice)',
    freeTier: true,
    capabilities: { offline: true, session: true, manualCapture: true, partialCapture: false, refund: true, partialRefund: true, savedMethods: false, subscriptions: false, payByLink: false, disputes: false, wallets: [] },
    connectFields: ['termsDays', 'instructions'],
    publicConfig(args) { return { termsDays: Number(args.termsDays) || 30 }; },
    dashboardLinks() { return { dashboard: '', docs: 'https://huloglobal.com/vendure-plugins/payments/docs/' }; },
    async verifyCredentials(args): Promise<CredentialCheck> { return { ok: true, message: `Invoices will be due ${Number(args.termsDays) || 30} days after the order.` }; },
    async createSession(_ctx: RequestContext, order: Order, args: ProviderArgs): Promise<ClientSession> {
        const days = Number(args.termsDays) || 30;
        const due = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
        return { provider: 'hulo-pay-later', flow: 'instructions', instructions: `${args.instructions ? fill(args.instructions, order, { dueDate: due, termsDays: String(days) }) + '\n\n' : ''}Payment is due within ${days} days (by ${due}). Please quote ${order.code} on your remittance.`, amount: order.totalWithTax, currency: order.currencyCode, config: { termsDays: days, dueDate: due } };
    },
    async confirmPayment(_ctx, order, args): Promise<PaymentOutcome> {
        const days = Number(args.termsDays) || 30;
        return { state: 'Authorized', amount: order.totalWithTax, transactionId: `invoice:${order.code}`, metadata: { capture: 'manual', dueAt: new Date(Date.now() + days * 86400_000).toISOString(), public: { method: 'pay-later', termsDays: days } } };
    },
    async capture() { return { success: true }; },
    async cancel() { return { success: true }; },
    async refund(_args, paymentRef, amount) { return { state: 'Pending', transactionId: `${paymentRef}:credit:${Date.now().toString(36)}`, metadata: { note: `Issue a credit note for ${amount}, then settle the refund in Vendure.` } }; },
    verifyWebhook: noWebhook,
};
