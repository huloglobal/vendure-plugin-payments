/**
 * Runtime hooks installed by the plugin class so feature modules never
 * import it (which would create an import cycle through the handlers).
 */

export interface HuloPaymentsRuntime {
    hasPremiumAccess: () => boolean;
    publicBaseUrl: () => string;
    /** Optional ops notifier (disputes, failed renewals, webhook misconfig). */
    notifyOps: (event: { kind: string; subject: string; text: string; orderCode?: string; channelId?: number | null }) => Promise<void>;
}

let runtime: HuloPaymentsRuntime = {
    hasPremiumAccess: () => false,
    publicBaseUrl: () => 'http://localhost:3000',
    notifyOps: async () => undefined,
};

export function configureRuntime(r: Partial<HuloPaymentsRuntime>): void { runtime = { ...runtime, ...r }; }
export function getRuntime(): HuloPaymentsRuntime { return runtime; }

export class PremiumRequiredError extends Error {
    constructor(feature: string) {
        super(`${feature} needs a HULO Payments licence — buy at https://huloglobal.com/vendure-plugins/payments/`);
        this.name = 'PremiumRequiredError';
    }
}

export function requirePremium(feature: string): void {
    if (!runtime.hasPremiumAccess()) throw new PremiumRequiredError(feature);
}
