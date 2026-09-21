/**
 * Tiny HTTP helpers on the platform `fetch` (Node 18+). The plugin carries
 * no provider SDKs: every provider is a handful of REST calls, and keeping
 * them explicit keeps the dependency surface (and the audit surface) small.
 */

export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; headers?: any }>;

export class ProviderRequestError extends Error {
    constructor(
        public readonly provider: string,
        public readonly status: number,
        public readonly body: any,
        public readonly path: string,
    ) {
        super(ProviderRequestError.describe(provider, status, body, path));
        this.name = 'ProviderRequestError';
    }
    static describe(provider: string, status: number, body: any, path: string): string {
        const msg = body?.error?.message || body?.message || body?.detail || body?.title || body?.error_description
            || (Array.isArray(body?.details) && body.details[0]?.description) || '';
        return `${provider} ${path} → HTTP ${status}${msg ? `: ${msg}` : ''}`;
    }
    /** Provider-supplied machine code where one exists. */
    get code(): string | undefined {
        const b = this.body || {};
        return b.error?.code || b.errorCode || b.name || b.code || (Array.isArray(b.details) ? b.details[0]?.issue : undefined);
    }
}

export interface RequestOpts {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    /** JSON body (sent as application/json). */
    json?: any;
    /** Form body (sent as application/x-www-form-urlencoded, Stripe style). */
    form?: Record<string, unknown>;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    /** Treat these statuses as success (e.g. 202 for Adyen webhooks). */
    okStatuses?: number[];
}

/** Stripe-style form encoding: nested objects become `a[b]=c`, arrays `a[0]=x`. */
export function encodeForm(params: Record<string, unknown>, prefix = ''): string {
    const pairs: string[] = [];
    const walk = (value: unknown, key: string) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, `${key}[${i}]`));
        } else if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                walk(v, key ? `${key}[${k}]` : k);
            }
        } else {
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
    };
    walk(params, prefix);
    return pairs.join('&');
}

export async function request<T = any>(provider: string, url: string, opts: RequestOpts = {}): Promise<T> {
    const fetchImpl: FetchLike = opts.fetchImpl || (globalThis as any).fetch;
    if (!fetchImpl) throw new Error('fetch is not available — Node 18+ is required');
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers || {}) };
    let body: string | undefined;
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
    else if (opts.form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = encodeForm(opts.form); }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000) : null;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
        res = await fetchImpl(url, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, signal: controller?.signal });
    } catch (e: any) {
        throw new ProviderRequestError(provider, 0, { message: e?.name === 'AbortError' ? 'request timed out' : e?.message }, url);
    } finally {
        if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: any = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; } }
    const ok = res.ok || (opts.okStatuses || []).includes(res.status);
    if (!ok) throw new ProviderRequestError(provider, res.status, parsed, url.replace(/^https?:\/\/[^/]+/, ''));
    return parsed as T;
}

/** Constant-time string comparison for signatures. */
export function safeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** Deterministic idempotency key for provider calls (max 255 chars). */
export function idem(...parts: Array<string | number | undefined | null>): string {
    return parts.filter(p => p !== undefined && p !== null && p !== '').map(String).join(':').slice(0, 255);
}
