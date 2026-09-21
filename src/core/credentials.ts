import { TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { ProviderArgs } from './provider';

/**
 * Provider credentials live where Vendure keeps them: on the PaymentMethod
 * entity as handler args, per channel, editable in the admin. Webhooks and
 * session creation run outside a handler call, so they look the method up
 * here. Cached for 30 s — credentials rarely change and webhooks are bursty.
 */

interface MethodRow { id: number; code: string; enabled: number; handler: string; channelIds: number[] }

const cache = new Map<string, { at: number; value: ResolvedMethod | null }>();
const TTL_MS = 30_000;

export interface ResolvedMethod {
    paymentMethodId: number;
    paymentMethodCode: string;
    enabled: boolean;
    args: ProviderArgs;
    channelIds: number[];
}

function parseHandler(handler: any): { code: string; args: ProviderArgs } {
    try {
        const h = typeof handler === 'string' ? JSON.parse(handler) : handler;
        const args: ProviderArgs = {};
        for (const a of h?.args || []) args[a.name] = coerce(a.value);
        return { code: String(h?.code || ''), args };
    } catch {
        return { code: '', args: {} };
    }
}

function coerce(v: any): any {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) { try { return JSON.parse(v); } catch { return v; } }
    return v;
}

/** All enabled Vendure payment methods using HULO handlers, with parsed args. */
export async function listHuloMethods(connection: TransactionalConnection, channelId?: number): Promise<Array<ResolvedMethod & { handlerCode: string }>> {
    const db = adapterFor(connection.rawConnection);
    const rows: any[] = await db.query(
        `SELECT pm.id, pm.code, pm.enabled, pm.handler, GROUP_CONCAT(pmc.channelId) AS channelIds
         FROM payment_method pm
         LEFT JOIN payment_method_channels_channel pmc ON pmc.paymentMethodId = pm.id
         GROUP BY pm.id`,
    ).catch(() => []);
    const out: Array<ResolvedMethod & { handlerCode: string }> = [];
    for (const r of rows) {
        const { code, args } = parseHandler(r.handler);
        if (!code.startsWith('hulo-')) continue;
        const channelIds = String(r.channelIds || '').split(',').filter(Boolean).map(Number);
        if (channelId && channelIds.length && !channelIds.includes(Number(channelId))) continue;
        out.push({ paymentMethodId: Number(r.id), paymentMethodCode: String(r.code), enabled: !!Number(r.enabled), args, channelIds, handlerCode: code });
    }
    return out;
}

/** The enabled method for a provider on a channel (falls back to any channel). */
export async function resolveMethod(connection: TransactionalConnection, handlerCode: string, channelId?: number, paymentMethodCode?: string): Promise<ResolvedMethod | null> {
    const key = `${handlerCode}|${channelId || 0}|${paymentMethodCode || ''}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const all = await listHuloMethods(connection);
    const candidates = all.filter(m => m.handlerCode === handlerCode && (!paymentMethodCode || m.paymentMethodCode === paymentMethodCode));
    const onChannel = channelId ? candidates.find(m => m.enabled && m.channelIds.includes(Number(channelId))) : undefined;
    const value = onChannel || candidates.find(m => m.enabled) || null;
    cache.set(key, { at: Date.now(), value });
    return value;
}

export function clearCredentialCache(): void { cache.clear(); }

/** Secrets never leave the server: redact for admin display. */
export function redactArgs(args: ProviderArgs): ProviderArgs {
    const out: ProviderArgs = {};
    for (const [k, v] of Object.entries(args || {})) {
        out[k] = /secret|key|password|hmac|token/i.test(k) && !/public|publishable|client(Id|Key)$/i.test(k) && typeof v === 'string' && v
            ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
    }
    return out;
}
