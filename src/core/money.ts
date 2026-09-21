/**
 * Money helpers. Vendure stores every amount in minor units of the order's
 * currency (pence, cents…). Providers mostly agree, with two exceptions:
 * zero-decimal currencies (JPY, KRW…) where Stripe and Adyen expect whole
 * units, and Mollie, which wants decimal strings ("12.50").
 */

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
    const c = String(currency || '').toUpperCase();
    if (ZERO_DECIMAL.has(c)) return 0;
    if (THREE_DECIMAL.has(c)) return 3;
    return 2;
}

/** Vendure minor units → provider minor units (Stripe / Adyen / PayPal-cents style). */
export function toProviderMinor(vendureMinor: number, currency: string): number {
    const exp = currencyExponent(currency);
    if (exp === 2) return Math.round(vendureMinor);
    // Vendure always uses 2 decimals; rescale for 0- and 3-decimal currencies.
    return Math.round(vendureMinor * Math.pow(10, exp - 2));
}

export function fromProviderMinor(providerMinor: number, currency: string): number {
    const exp = currencyExponent(currency);
    if (exp === 2) return Math.round(providerMinor);
    return Math.round(providerMinor / Math.pow(10, exp - 2));
}

/** Vendure minor units → decimal string with the currency's exponent ("12.50", "1200", "1.250"). */
export function toDecimalString(vendureMinor: number, currency: string): string {
    const exp = currencyExponent(currency);
    const major = Math.round(vendureMinor) / 100;
    return major.toFixed(exp);
}

export function fromDecimalString(value: string | number, currency: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    void currency;
    return Math.round(n * 100);
}

export function formatMoney(vendureMinor: number, currency: string, locale = 'en-GB'): string {
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: (currency || 'GBP').toUpperCase() }).format(Math.round(vendureMinor) / 100);
    } catch {
        return `${(Math.round(vendureMinor) / 100).toFixed(2)} ${currency}`;
    }
}

/** Amounts that agree to the penny after rounding through a provider. */
export function amountsMatch(a: number, b: number, toleranceMinor = 0): boolean {
    return Math.abs(Math.round(a) - Math.round(b)) <= toleranceMinor;
}
