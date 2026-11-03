import { Order } from '@vendure/core';

export type SurchargeRule = { type: 'percent' | 'fixed'; value: number; label?: string };

export const SURCHARGE_SKU_PREFIX = 'hulo-surcharge:';

/** The surcharge lines this plugin added to the order. */
export function huloSurcharges(order: Order): Array<{ id: any; sku: string; priceWithTax: number }> {
    return ((order.surcharges || []) as any[]).filter(s => String(s.sku || '').startsWith(SURCHARGE_SKU_PREFIX));
}

/** The rule for a payment method: by handler (provider) code first, then by payment-method code. */
export function surchargeRule(surcharges: Record<string, SurchargeRule> | undefined, handlerCode: string, methodCode: string): SurchargeRule | null {
    const r = (surcharges || {})[handlerCode] || (surcharges || {})[methodCode] || null;
    return r && Number(r.value) > 0 ? r : null;
}

/** The fee (Vendure minor units, tax inclusive) the rule puts on this order, computed from the total without our own fee lines. */
export function surchargeAmount(rule: SurchargeRule | null, order: Order): number {
    if (!rule) return 0;
    const base = order.totalWithTax - huloSurcharges(order).reduce((n, s) => n + Number(s.priceWithTax || 0), 0);
    const amount = rule.type === 'percent' ? Math.round(base * rule.value / 100) : Math.round(rule.value);
    return amount > 0 ? amount : 0;
}

/**
 * Whether the order carries exactly the fee of the method being charged: one line for this method
 * code at the computed amount (or no fee line when the method has no fee). Anything else (another
 * method's fee, no fee, a stale fee from a smaller basket) means the client chose the surcharge.
 */
export function surchargeMatches(rule: SurchargeRule | null, order: Order, methodCode: string): boolean {
    const lines = huloSurcharges(order);
    const expected = surchargeAmount(rule, order);
    if (!expected) return lines.length === 0;
    return lines.length === 1 && lines[0].sku === `${SURCHARGE_SKU_PREFIX}${methodCode}` && Number(lines[0].priceWithTax) === expected;
}
