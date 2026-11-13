import { DigestMail, WeeklyDigest } from '@huloglobal/vendure-licence-sdk';

/**
 * The weekly report is a licensed feature (0.4.0): without a licence or an active evaluation the
 * scheduler sends nothing and "Send me a test" refuses. Settings and history are kept, so the
 * report resumes as it was when a licence is activated.
 */
export class PremiumWeeklyDigest extends WeeklyDigest {
    constructor(opts: ConstructorParameters<typeof WeeklyDigest>[0], private readonly premium: () => boolean) { super(opts); }

    async tick(now: Date = new Date()): Promise<boolean> {
        if (!this.premium()) return false;
        return super.tick(now);
    }

    async sendNow(to?: string | null): ReturnType<WeeklyDigest['sendNow']> {
        if (!this.premium()) {
            return { sent: false, to: null, reason: 'licence-required', preview: { subject: 'The weekly report needs a HULO Payments licence', text: '', html: '' } as DigestMail };
        }
        return super.sendNow(to);
    }
}

