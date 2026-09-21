import { LanguageCode, PaymentMethodEligibilityChecker } from '@vendure/core';

const label = (v: string) => [{ languageCode: LanguageCode.en, value: v }];

function csv(v: unknown): string[] {
    return String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * `hulo-payment-rules` — attach to any payment method (HULO or not) to
 * control when it is offered: order total band, currencies, shipping /
 * billing countries, customer groups, signed-in customers only.
 */
export const huloPaymentRulesChecker = new PaymentMethodEligibilityChecker({
    code: 'hulo-payment-rules',
    description: label('HULO Payments rules: amount band, currencies, countries, customer groups'),
    args: {
        minAmount: { type: 'int', label: label('Minimum order total (minor units, incl. tax)'), defaultValue: 0 },
        maxAmount: { type: 'int', label: label('Maximum order total (0 = no limit)'), defaultValue: 0 },
        currencies: { type: 'string', label: label('Currencies'), description: label('Comma list, e.g. GBP,EUR — empty = any'), defaultValue: '' },
        countries: { type: 'string', label: label('Countries'), description: label('Comma list of ISO codes matched against shipping then billing address — empty = any'), defaultValue: '' },
        customerGroups: { type: 'string', label: label('Customer group ids'), description: label('Comma list — empty = any'), defaultValue: '' },
        requireLogin: { type: 'boolean', label: label('Signed-in customers only'), defaultValue: false },
    },
    check(ctx, order, args) {
        const total = order.totalWithTax;
        if (args.minAmount && total < args.minAmount) return false;
        if (args.maxAmount && total > args.maxAmount) return false;
        const currencies = csv(args.currencies);
        if (currencies.length && !currencies.includes(order.currencyCode)) return false;
        const countries = csv(args.countries);
        if (countries.length) {
            const c = String(order.shippingAddress?.countryCode || order.billingAddress?.countryCode || '').toUpperCase();
            if (!c || !countries.includes(c)) return false;
        }
        if (args.requireLogin && !ctx.activeUserId) return false;
        const groups = csv(args.customerGroups);
        if (groups.length) {
            const mine = (order.customer?.groups || []).map(g => String(g.id).toUpperCase());
            if (!mine.some(g => groups.includes(g))) return false;
        }
        return true;
    },
});
