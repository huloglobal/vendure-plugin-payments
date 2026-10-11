/**
 * Runtime hooks installed by the plugin class so feature modules never
 * import it (which would create an import cycle through the handlers).
 */

/** Where an unlicensed install buys a licence (every 402 body carries it). */
export const BUY_URL = 'https://elite.charity/licence/buy/vendure-plugin-payments';

export interface OpsMail { to: string; subject: string; text: string; html?: string }

export interface HuloPaymentsRuntime {
    hasPremiumAccess: () => boolean;
    publicBaseUrl: () => string;
    /** Optional ops notifier (disputes, failed renewals, webhook misconfig). */
    notifyOps: (event: { kind: string; subject: string; text: string; orderCode?: string; channelId?: number | null }) => Promise<void>;
    /** The channel's own ops address from Settings → Operations (null when unset). Installed by the ledger. */
    channelOpsEmail: (channelId: number) => Promise<string | null>;
    /** The plugin's SMTP transport (SMTP_* env). Rejects when SMTP is not configured. */
    sendMail: (mail: OpsMail) => Promise<void>;
}

let runtime: HuloPaymentsRuntime = {
    hasPremiumAccess: () => false,
    publicBaseUrl: () => 'http://localhost:3000',
    notifyOps: async () => undefined,
    channelOpsEmail: async () => null,
    sendMail: async () => { throw new Error('SMTP is not configured'); },
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
