/**
 * Provider fallback after a decline (premium, per channel: Settings →
 * Routing → "Fall back to the next provider on decline").
 *
 * Without it, a customer whose card is declined on the hosted page (or by
 * the storefront's own session) is left looking at the same list with the
 * failed method still first. With it, the method that failed moves to the
 * end, the next enabled provider in the channel's routing order is marked
 * `preferred`, and the hosted page says so. Nothing is charged
 * automatically: the customer still chooses.
 */

export interface FallbackCandidate { methodCode: string; provider: string; name: string; preferred: boolean }

/** True when the channel asked for fallback and the install has premium access. */
export function fallbackActive(settings: { fallbackOnFailure: boolean }, premium: boolean): boolean {
    return !!settings.fallbackOnFailure && premium;
}

/**
 * The offer after `failedMethodCode` failed: every other method first, in
 * the order given (already the channel's routing order), then the failed
 * one. The first of the others becomes `preferred`. Returns the list
 * unchanged when the failed method is unknown or nothing else is offered.
 */
export function reorderAfterFailure<T extends FallbackCandidate>(offered: T[], failedMethodCode: string): T[] {
    const failed = offered.filter(p => p.methodCode === failedMethodCode);
    const others = offered.filter(p => p.methodCode !== failedMethodCode);
    if (!failed.length || !others.length) return offered;
    return [...others, ...failed].map((p, i) => ({ ...p, preferred: i === 0 }));
}

/** What the hosted page shows after a failure: the other methods to try, next one first. */
export function fallbackSuggestions(offered: FallbackCandidate[], failedMethodCode: string): Array<{ methodCode: string; name: string }> {
    return reorderAfterFailure(offered, failedMethodCode)
        .filter(p => p.methodCode !== failedMethodCode)
        .map(p => ({ methodCode: p.methodCode, name: p.name }));
}
