import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendOpsMail } from './plugin';

/**
 * The ops SMTP transport in plugin.ts (ops e-mails and the weekly report).
 * plugin.ts loads nodemailer with require() because the host may not have
 * it, and vi.mock does not reach require(), so these tests stub
 * createTransport on the module require() returns. Skipped when nodemailer
 * is not installed.
 */
let nodemailer: any = null;
try { nodemailer = createRequire(__filename)('nodemailer'); } catch { /* not installed */ }
const run = nodemailer ? describe : describe.skip;

run('ops e-mail transport', () => {
    const SMTP_KEYS = ['SMTP_SERVER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PASS', 'SMTP_FROM'];
    const saved = Object.fromEntries(SMTP_KEYS.map(k => [k, process.env[k]]));
    const mail = { to: 'owner@example.test', subject: 'Weekly report', text: 'Report' };
    let createTransport: any;
    let hosts = 0;

    /** A new SMTP host each time, so every test builds its own pooled transport. */
    function useSmtp(port: number): void {
        for (const k of SMTP_KEYS) delete process.env[k];
        process.env.SMTP_SERVER = `smtp${++hosts}.example.test`;
        process.env.SMTP_PORT = String(port);
        process.env.SMTP_USER = 'ops@example.test';
        process.env.SMTP_PASSWORD = 'not-a-secret';
    }
    /** The next transport nodemailer hands out. */
    function nextTransport(sendMail: () => Promise<unknown>) {
        const t = { sendMail: vi.fn(sendMail), close: vi.fn() };
        createTransport.mockReturnValueOnce(t);
        return t;
    }

    beforeEach(() => {
        createTransport = vi.spyOn(nodemailer, 'createTransport');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
        vi.useRealTimers();
        createTransport.mockRestore();
        for (const k of SMTP_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('allows 30 s to connect, 30 s for the greeting and 45 s of socket idle (port 587: STARTTLS)', async () => {
        useSmtp(587);
        const t = nextTransport(async () => ({}));
        await sendOpsMail(mail);
        expect(createTransport).toHaveBeenCalledTimes(1);
        expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
            port: 587, secure: false, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 45_000,
        }));
        // The socket idle timer runs during the greeting wait. If it is not longer, a server
        // that never greets fails with a bare "Timeout" instead of "Greeting never received".
        const opts = createTransport.mock.calls[0][0];
        expect(opts.socketTimeout).toBeGreaterThan(opts.greetingTimeout);
        expect(t.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'ops@example.test', to: 'owner@example.test' }));
    });

    it('uses implicit TLS on port 465', async () => {
        useSmtp(465);
        nextTransport(async () => ({}));
        await sendOpsMail(mail);
        expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
            port: 465, secure: true, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 45_000,
        }));
    });

    it('gives a send 60 s, then fails it and reconnects for the next one', async () => {
        useSmtp(587);
        const stuck = nextTransport(() => new Promise(() => undefined));
        const outcome = sendOpsMail(mail).then(() => 'sent', (e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toBe('smtp timeout (60 s)');
        expect(stuck.close).toHaveBeenCalled();

        const fresh = nextTransport(async () => ({}));
        await sendOpsMail(mail);
        expect(createTransport).toHaveBeenCalledTimes(2);
        expect(fresh.sendMail).toHaveBeenCalled();
    });
});
