import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SharedModule, getServerLocation } from '@vendure/admin-ui/core';

const API = `${getServerLocation().replace(/\/$/, '')}/hulo-payments`;

/**
 * Admin dashboard widget: three 7-day figures from the ledger, the licence
 * lifecycle notice when there is one, and a link to the Payments page.
 * Same endpoint auth as the main page (cookie session or bearer token).
 */
@Component({
    selector: 'hulo-payments-widget',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="hpw">
            <ng-container *ngIf="data; else loading">
                <div class="hpw-stats">
                    <div class="hpw-stat" *ngFor="let s of data.stats"><div class="hpw-num">{{ s.value }}</div><div class="hpw-label">{{ s.label }}</div></div>
                </div>
                <div class="hpw-notice" *ngIf="data.notice">{{ data.notice.message }}</div>
                <a class="hpw-link" [routerLink]="[data.route]">Open Payments →</a>
            </ng-container>
            <ng-template #loading><p class="hpw-muted">{{ failed ? 'Payments is unavailable right now.' : 'Loading…' }}</p></ng-template>
        </div>
    `,
    styles: [`
        .hpw { padding: 4px 2px; }
        .hpw-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 12px; }
        .hpw-num { font-size: 24px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--color-text-100, #0f172a); }
        .hpw-label { margin-top: 4px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--color-weight-500, #64748b); }
        .hpw-notice { margin-top: 12px; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600; background: #fffbeb; border: 1px solid #fcd34d; border-left: 4px solid #f59e0b; color: #92400e; }
        .hpw-link { display: inline-block; margin-top: 12px; font-size: 13px; font-weight: 600; color: #b45309; text-decoration: none; }
        .hpw-link:hover { text-decoration: underline; }
        .hpw-muted { margin: 0; font-size: 13px; color: var(--color-weight-500, #64748b); }
    `],
})
export class HuloPaymentsWidgetComponent implements OnInit {
    data: { tier: string; notice: { kind: string; message: string; daysLeft: number } | null; stats: Array<{ label: string; value: string }>; route: string } | null = null;
    failed = false;

    constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        const headers: { [k: string]: string } = {};
        try {
            const raw = localStorage.getItem('vnd_authToken');
            const token = raw ? (raw.startsWith('"') ? JSON.parse(raw) : raw) : '';
            if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch { /* storage unavailable */ }
        this.http.get<any>(`${API}/widget`, { headers, withCredentials: true }).subscribe({
            next: d => { this.data = d; this.cdr.markForCheck(); },
            error: () => { this.failed = true; this.cdr.markForCheck(); },
        });
    }
}
