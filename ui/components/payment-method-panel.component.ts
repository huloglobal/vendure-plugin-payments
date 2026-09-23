import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { UntypedFormGroup } from '@angular/forms';
import { CustomDetailComponent, getServerLocation } from '@vendure/admin-ui/core';
import { HuloProvidersCacheService } from '../providers-cache.service';
import { BLURBS, PAY_WITH, WEBHOOK_HINTS } from './provider-copy';
import { Observable, Subscription } from 'rxjs';

// Resolved lazily: this component lives in the eagerly-loaded shared module, and
// the UI config (server location) is not available until the app has bootstrapped.
const api = () => `${getServerLocation().replace(/\/$/, '')}/hulo-payments`;

/**
 * Sits under the standard payment-method form (Settings → Payment methods →
 * a method) whenever the handler is one of ours, and turns the raw handler
 * form into something an admin can follow: what the method is, what
 * customers can pay with, which keys go where, the webhook URL to paste,
 * a "test these keys" button and the provider's own dashboard links.
 */
@Component({
    selector: 'hulo-payment-method-panel',
    standalone: false,
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="hulo-pm" *ngIf="provider">
            <div class="hulo-pm-head">
                <div>
                    <div class="hulo-pm-kicker">HULO Payments</div>
                    <h3>{{ provider.name }}<span class="hulo-pm-badge" [class.free]="provider.freeTier">{{ provider.freeTier ? 'Free tier' : 'Licensed' }}</span></h3>
                    <p class="hulo-pm-lead">{{ blurb }}</p>
                </div>
                <a class="hulo-pm-link" [routerLink]="['/extensions/hulo-payments']" [queryParams]="{ tab: 'providers', connect: provider.code }">Set up automatically instead →</a>
            </div>

            <div class="hulo-pm-grid">
                <div class="hulo-pm-card">
                    <h4>Customers can pay with</h4>
                    <div class="hulo-pm-chips">
                        <span class="chip" *ngFor="let c of payChips">{{ c }}</span>
                    </div>
                    <h4 class="mt">This method supports</h4>
                    <div class="hulo-pm-chips">
                        <span class="chip soft" *ngFor="let c of featureChips">{{ c }}</span>
                    </div>
                </div>

                <div class="hulo-pm-card" *ngIf="!provider.capabilities?.offline">
                    <h4>1 · Keys</h4>
                    <p>Fill in the fields above. Each one says where to find it in the {{ provider.name }} dashboard.</p>
                    <div class="hulo-pm-links" *ngIf="provider.links">
                        <a *ngIf="provider.links.keys" [href]="provider.links.keys" target="_blank" rel="noopener">Open {{ provider.name }} API keys ↗</a>
                        <a *ngIf="provider.links.dashboard" [href]="provider.links.dashboard" target="_blank" rel="noopener">{{ provider.name }} dashboard ↗</a>
                        <a *ngIf="provider.links.docs" [href]="provider.links.docs" target="_blank" rel="noopener">Docs ↗</a>
                    </div>
                    <button type="button" class="hulo-pm-btn" (click)="testKeys()" [disabled]="testing">{{ testing ? 'Checking…' : 'Test these keys' }}</button>
                    <div class="hulo-pm-result" *ngIf="testResult" [class.ok]="testResult.ok" [class.bad]="!testResult.ok">
                        {{ testResult.ok ? '✓' : '✕' }} {{ testResult.message }}
                    </div>
                </div>

                <div class="hulo-pm-card" *ngIf="!provider.capabilities?.offline">
                    <h4>2 · Webhook</h4>
                    <p>{{ webhookHint }}</p>
                    <div class="hulo-pm-url">
                        <code>{{ provider.webhookUrl }}</code>
                        <button type="button" class="hulo-pm-btn small" (click)="copy(provider.webhookUrl)">{{ copied ? 'Copied' : 'Copy' }}</button>
                    </div>
                    <div class="hulo-pm-status" [class.ok]="webhookConfigured" [class.warn]="!webhookConfigured">
                        {{ webhookConfigured ? '✓ Webhook secret saved — payments confirm automatically.' : '△ No webhook secret saved yet — payments still work, but refunds, disputes and subscription renewals made in the provider dashboard will not reach Vendure.' }}
                    </div>
                    <a *ngIf="provider.links?.webhooks" [href]="provider.links.webhooks" target="_blank" rel="noopener" class="hulo-pm-a">Open {{ provider.name }} webhooks ↗</a>
                </div>

                <div class="hulo-pm-card" *ngIf="provider.capabilities?.offline">
                    <h4>How it works</h4>
                    <p>No keys and no webhook. The customer sees the details above at checkout, the order is placed as <strong>Payment authorised</strong>, and you settle it from the order page once the money arrives.</p>
                </div>

                <div class="hulo-pm-card">
                    <h4>{{ provider.capabilities?.offline ? '2' : '3' }} · Go live</h4>
                    <ul>
                        <li>Give the method a name customers understand — it is shown at checkout (for example “Card, Apple Pay &amp; Google Pay”).</li>
                        <li>Tick <strong>Enabled</strong> above and save.</li>
                        <li>Storefront: send customers to the hosted page with <code>huloHostedCheckout</code>, or embed the provider's client — see the Payments page.</li>
                        <li *ngIf="methodInfo?.environment && methodInfo.environment !== 'live' && methodInfo.environment !== 'production'">Currently in <strong>{{ methodInfo.environment }}</strong> mode: real cards will be declined until you switch to live keys.</li>
                    </ul>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .hulo-pm { margin: 24px 0 8px; border: 1px solid var(--color-weight-200, #e2e8f0); border-radius: 12px; padding: 20px 22px; background: var(--color-component-bg-100, #fff); }
        .hulo-pm-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
        .hulo-pm-kicker { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #1d4ed8; }
        .hulo-pm h3 { margin: 2px 0 6px; font-size: 20px; display: flex; align-items: center; gap: 10px; }
        .hulo-pm-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; }
        .hulo-pm-badge.free { background: #dcfce7; color: #166534; }
        .hulo-pm-lead { margin: 0; color: var(--color-weight-600, #475569); max-width: 720px; line-height: 1.5; }
        .hulo-pm-link { font-weight: 600; white-space: nowrap; }
        .hulo-pm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 18px; }
        .hulo-pm-card { border: 1px solid var(--color-weight-200, #e2e8f0); border-radius: 10px; padding: 14px 16px; background: var(--color-weight-100, #f8fafc); }
        .hulo-pm-card h4 { margin: 0 0 8px; font-size: 13px; font-weight: 700; }
        .hulo-pm-card h4.mt { margin-top: 12px; }
        .hulo-pm-card p, .hulo-pm-card li { font-size: 13px; line-height: 1.5; color: var(--color-weight-700, #334155); margin: 0 0 8px; }
        .hulo-pm-card ul { padding-left: 18px; margin: 0; }
        .hulo-pm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #1d4ed8; color: #fff; }
        .chip.soft { background: #e2e8f0; color: #0f172a; }
        .hulo-pm-links { display: flex; flex-wrap: wrap; gap: 12px; margin: 6px 0 10px; font-size: 13px; }
        .hulo-pm-btn { border: 1px solid #1d4ed8; background: #1d4ed8; color: #fff; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .hulo-pm-btn[disabled] { opacity: .6; cursor: default; }
        .hulo-pm-btn.small { padding: 4px 10px; font-size: 12px; }
        .hulo-pm-result { margin-top: 8px; font-size: 13px; padding: 8px 10px; border-radius: 6px; }
        .hulo-pm-result.ok { background: #dcfce7; color: #166534; } .hulo-pm-result.bad { background: #fee2e2; color: #991b1b; }
        .hulo-pm-url { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
        .hulo-pm-url code { flex: 1; font-size: 12px; word-break: break-all; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; }
        .hulo-pm-status { font-size: 12.5px; line-height: 1.45; padding: 8px 10px; border-radius: 6px; margin-top: 6px; }
        .hulo-pm-status.ok { background: #dcfce7; color: #166534; } .hulo-pm-status.warn { background: #fef3c7; color: #92400e; }
        .hulo-pm-a { display: inline-block; margin-top: 8px; font-size: 13px; }
    `],
})
export class HuloPaymentMethodPanelComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;

    provider: any = null; methodInfo: any = null;
    blurb = ''; payChips: string[] = []; featureChips: string[] = []; webhookHint = '';
    testing = false; testResult: { ok: boolean; message: string } | null = null; copied = false;
    private meta: any = null; private subs: Subscription[] = [];

    constructor(private http: HttpClient, private cdr: ChangeDetectorRef, private cache: HuloProvidersCacheService) {}

    ngOnInit() {
        this.subs.push(this.cache.providers().subscribe(m => { if (m) { this.meta = m; this.refresh(); } }));
        const handler = this.detailForm?.get('handler');
        if (handler) this.subs.push(handler.valueChanges.subscribe(() => this.refresh()));
        if (this.entity$) this.subs.push(this.entity$.subscribe(() => this.refresh()));
    }
    ngOnDestroy() { this.subs.forEach(s => s.unsubscribe()); }

    private handlerCode(): string { return String(this.detailForm?.value?.handler?.code || ''); }

    private refresh() {
        const code = this.handlerCode();
        const p = this.meta?.providers?.find((x: any) => x.code === code);
        if (!p) { this.provider = null; this.cdr.markForCheck(); return; }
        if (this.provider?.code !== code) this.testResult = null;
        this.provider = p;
        const entityId = String((this.detailForm?.value?.id) || '');
        this.methodInfo = p.methods?.find((m: any) => String(m.id) === entityId) || p.methods?.[0] || null;
        this.blurb = BLURBS[code] || `Payments through ${p.name}, recorded in the HULO Payments ledger with the same refunds, holds and dashboard as every other provider.`;
        this.payChips = PAY_WITH[code] || [];
        const cap = p.capabilities || {};
        this.featureChips = [
            cap.manualCapture ? 'Holds (authorise now, capture later)' : '',
            cap.refunds ? (cap.partialRefunds ? 'Refunds, incl. partial' : 'Refunds') : 'No refunds through Vendure',
            cap.subscriptions ? 'Subscriptions' : '', cap.savedCards ? 'Saved cards' : '', cap.payLinks ? 'Pay-by-link' : '',
            cap.disputes ? 'Disputes' : '', cap.offline ? 'Settled by hand from the order page' : 'Confirmed by webhook',
        ].filter(Boolean);
        this.webhookHint = WEBHOOK_HINTS[code] || `Add this URL as a webhook endpoint in the ${p.name} dashboard and paste the secret it gives you into the field above.`;
        this.cdr.markForCheck();
    }

    get webhookConfigured(): boolean { return !!this.methodInfo?.webhookConfigured; }

    /** Current (possibly unsaved) handler args from the form, as {name: value}. */
    private currentArgs(): Record<string, string> {
        const raw = this.detailForm?.value?.handler?.args;
        const out: Record<string, string> = {};
        if (Array.isArray(raw)) for (const a of raw) if (a && a.name) out[a.name] = a.value == null ? '' : String(a.value);
        else if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) out[k] = raw[k] == null ? '' : String(raw[k]);
        return out;
    }

    testKeys() {
        if (!this.provider) return;
        this.testing = true; this.testResult = null; this.cdr.markForCheck();
        this.http.post<any>(`${api()}/connect/${this.provider.code}/test`, { args: this.currentArgs() }, this.h()).subscribe({
            next: r => { this.testResult = { ok: !!r?.ok, message: r?.message || (r?.ok ? 'Keys accepted.' : 'Keys rejected.') }; this.testing = false; this.cdr.markForCheck(); },
            error: e => { this.testResult = { ok: false, message: e?.error?.message || e?.message || 'Could not check the keys.' }; this.testing = false; this.cdr.markForCheck(); },
        });
    }

    copy(text: string) {
        try { navigator.clipboard.writeText(text); this.copied = true; setTimeout(() => { this.copied = false; this.cdr.markForCheck(); }, 1500); } catch { /* ignore */ }
    }

    private h(): { headers: { [k: string]: string }; withCredentials: boolean; observe: 'body'; responseType: 'json' } {
        const headers: { [k: string]: string } = {};
        try {
            const raw = localStorage.getItem('vnd_authToken');
            const token = raw ? (raw.startsWith('"') ? JSON.parse(raw) : raw) : '';
            if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch { /* storage unavailable */ }
        return { headers, withCredentials: true, observe: 'body', responseType: 'json' };
    }
}
