import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnInit } from '@angular/core';
import { CustomColumnComponent } from '@vendure/admin-ui/core';
import { HuloProvidersCacheService } from '../providers-cache.service';
import { MARKS, MethodStatus, STATUS_LABEL, methodStatus } from './provider-copy';

/**
 * Replaces the Name cell in Settings → Payment methods. A HULO method shows a
 * brand mark, its name, one status word (Live / Test mode / Ready, disabled /
 * Not set up) and the first line of its description, so a list of twenty
 * methods reads at a glance. Other methods keep the plain name link.
 */
@Component({
    selector: 'hulo-payment-method-name-cell',
    standalone: false,
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <!-- Fixed columns (mark | status | name) so the status chips line up down the page whatever the name length. -->
        <div class="hulo-cell" [class.plain]="!mark">
            <span class="hulo-mark" [style.background]="mark ? mark.bg : 'transparent'" aria-hidden="true">{{ mark ? mark.text : '' }}</span>
            <span class="hulo-status-col">
                <span class="hulo-status" *ngIf="status" [class]="'hulo-status ' + status">{{ statusLabel }}</span>
            </span>
            <a class="button-ghost hulo-name" [routerLink]="['./', rowItem.id]">{{ rowItem.name }}</a>
            <span class="hulo-cell-sub" *ngIf="sub">{{ sub }}</span>
        </div>
    `,
    styles: [`
        .hulo-cell { display: grid; grid-template-columns: 28px 118px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 10px; row-gap: 2px; align-items: center; min-width: 0; }
        .hulo-cell.plain { grid-template-columns: 0 0 minmax(0, 1fr); column-gap: 0; }
        .hulo-mark { grid-row: 1 / span 2; width: 28px; height: 28px; border-radius: 7px; color: #fff; font-weight: 700; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; letter-spacing: -.02em; }
        .hulo-cell.plain .hulo-mark { display: none; }
        .hulo-status-col { grid-row: 1 / span 2; display: flex; align-items: center; }
        .hulo-cell.plain .hulo-status-col { display: none; }
        .hulo-name { grid-column: 3; grid-row: 1; justify-self: start; }
        .hulo-status { display: inline-block; min-width: 108px; text-align: center; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
        .hulo-status.live { background: #dcfce7; color: #166534; }
        .hulo-status.test { background: #fef3c7; color: #92400e; }
        .hulo-status.disabled { background: #e2e8f0; color: #334155; }
        .hulo-status.not-set-up { background: #f1f5f9; color: #64748b; border: 1px dashed #cbd5e1; }
        .hulo-cell-sub { grid-column: 3; grid-row: 2; font-size: 12px; color: var(--color-weight-500, #64748b); max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `],
})
export class HuloPaymentMethodNameCellComponent implements CustomColumnComponent, OnInit {
    @Input() rowItem: any;
    mark: { text: string; bg: string } | null = null;
    status: MethodStatus | null = null; statusLabel = ''; sub = '';

    constructor(private cache: HuloProvidersCacheService, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.sub = firstLine(this.rowItem?.description);
        this.cache.providers().subscribe(meta => {
            if (!meta) return;
            for (const p of meta.providers || []) {
                const m = (p.methods || []).find((x: any) => String(x.id) === String(this.rowItem?.id));
                if (!m) continue;
                this.mark = MARKS[p.code] || { text: p.name.slice(0, 1), bg: '#1d4ed8' };
                this.status = methodStatus({ enabled: !!this.rowItem?.enabled, environment: m.environment, args: m.args }, p.code);
                this.statusLabel = STATUS_LABEL[this.status];
                if (!this.sub) this.sub = p.name;
                break;
            }
            this.cdr.markForCheck();
        });
    }
}

function firstLine(html: string | undefined): string {
    if (!html) return '';
    const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const cut = text.search(/[.!?](\s|$)/);
    const line = cut > 0 ? text.slice(0, cut + 1) : text;
    return line.length > 110 ? line.slice(0, 107) + '…' : line;
}
