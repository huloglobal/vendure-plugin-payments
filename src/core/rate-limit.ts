import type { Request, Response } from 'express';
import { isIP } from 'net';

/**
 * Per-IP fixed-window limits for the public routes (hosted page, webhooks,
 * CSP reports). In memory, per process: the point is to stop one client
 * hammering a token or a webhook URL, not to meter fair use, so the limits
 * are far above what a real customer or provider sends.
 */

export type RateBucket = 'hostedPage' | 'hostedAction' | 'webhook' | 'cspReport';

/** Requests per minute per client IP. */
export const DEFAULT_RATE_LIMITS: Record<RateBucket, number> = {
    hostedPage: 120,
    hostedAction: 40,
    webhook: 1200,
    cspReport: 60,
};

export type RateLimitOptions = false | Partial<Record<RateBucket, number>>;

const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;

export class FixedWindowLimiter {
    private hits = new Map<string, { start: number; n: number }>();
    constructor(private readonly limit: number, private readonly windowMs = WINDOW_MS) {}

    /** Count one hit for `key`; returns seconds to wait when over the limit, else 0. */
    hit(key: string, now = Date.now()): number {
        let w = this.hits.get(key);
        if (!w || now - w.start >= this.windowMs) {
            if (this.hits.size >= MAX_KEYS) this.sweep(now);
            w = { start: now, n: 0 };
            this.hits.set(key, w);
        }
        w.n++;
        return w.n > this.limit ? Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) : 0;
    }

    private sweep(now: number): void {
        for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k);
        // Still full (a flood of distinct addresses): start over rather than grow without bound.
        if (this.hits.size >= MAX_KEYS) this.hits.clear();
    }
}

/** Loopback, RFC 1918, link-local, CGNAT and ULA addresses: what a reverse proxy in front of Vendure looks like. */
export function isPrivateIp(ip: string): boolean {
    const v = ip.replace(/^::ffff:/i, '');
    if (isIP(v) === 4) {
        const [a, b] = v.split('.').map(Number);
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
    }
    if (isIP(v) === 6) {
        const l = v.toLowerCase();
        return l === '::1' || l === '::' || /^f[cd][0-9a-f]{2}:/.test(l) || /^fe[89ab][0-9a-f]:/.test(l);
    }
    return false;
}

function header(req: Request, name: string): string {
    const v = req.headers?.[name];
    return (Array.isArray(v) ? v[0] : v || '').toString().trim();
}

/**
 * The address to count a request against. The TCP peer, unless the peer is a
 * private address (a proxy on the same host or network): then the address
 * that proxy reports — `CF-Connecting-IP`, else the right-most public entry
 * of `X-Forwarded-For`, else `X-Real-IP`. A client that reaches Vendure
 * directly from the internet cannot choose its bucket with these headers.
 */
export function clientIp(req: Request): string {
    const peer = String(req.socket?.remoteAddress || (req as any).connection?.remoteAddress || req.ip || '').replace(/^::ffff:/i, '');
    if (peer && !isPrivateIp(peer)) return peer;
    const cf = header(req, 'cf-connecting-ip');
    if (isIP(cf)) return cf;
    const xff = header(req, 'x-forwarded-for').split(',').map(s => s.trim().replace(/^::ffff:/i, '')).filter(s => isIP(s));
    for (let i = xff.length - 1; i >= 0; i--) if (!isPrivateIp(xff[i])) return xff[i];
    const real = header(req, 'x-real-ip');
    if (isIP(real) && !isPrivateIp(real)) return real;
    return peer || 'unknown';
}

let limits: RateLimitOptions = {};
const limiters = new Map<RateBucket, FixedWindowLimiter>();

/** Installed by `HuloPaymentsPlugin.init({ rateLimits })`; `false` turns every limit off. */
export function configureRateLimits(opts: RateLimitOptions | undefined): void {
    limits = opts === undefined ? {} : opts;
    limiters.clear();
}

export function limitFor(bucket: RateBucket): number {
    if (limits === false) return 0;
    const n = Number(limits[bucket] ?? DEFAULT_RATE_LIMITS[bucket]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Count the request; when over the bucket's limit answer 429 with `Retry-After` and return true
 * (the caller returns at once). A limit of 0 (or `rateLimits: false`) never refuses.
 */
export function rateLimited(req: Request, res: Response, bucket: RateBucket): boolean {
    const limit = limitFor(bucket);
    if (!limit) return false;
    let l = limiters.get(bucket);
    if (!l) { l = new FixedWindowLimiter(limit); limiters.set(bucket, l); }
    const wait = l.hit(clientIp(req));
    if (!wait) return false;
    res.setHeader('retry-after', String(wait));
    res.status(429).json({ error: 'too_many_requests', message: 'Too many requests. Please wait a moment and try again.' });
    return true;
}
