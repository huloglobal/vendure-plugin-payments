import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NotificationService, ModalService, getServerLocation } from '@vendure/admin-ui/core';

/** REST prefix shared with the plugin controllers — resolved against the
 *  Vendure server the admin UI is configured for, so it also works when the
 *  UI is served from another origin or a CDN. */
const API = `${getServerLocation().replace(/\/$/, '')}/hulo-payments`;

type Tab = 'overview' | 'transactions' | 'subscriptions' | 'paylink' | 'providers' | 'settings';

const PROVIDER_NAMES: Record<string, string> = { 'hulo-stripe': 'Stripe', 'hulo-adyen': 'Adyen', 'hulo-paypal': 'PayPal', 'hulo-mollie': 'Mollie' };

@Component({
    selector: 'hulo-payments',
    standalone: false,
    template: `
        <!-- ── Hero ────────────────────────────────────────────────── -->
        <vdr-page-block>
            <div class="hulo-hero">
                <div class="hulo-hero-logo" aria-hidden="true"><svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#050a10"/><rect x="12" y="20" width="40" height="26" rx="4" fill="#1d4ed8"/><rect x="12" y="26" width="40" height="6" fill="#050a10"/><rect x="17" y="36" width="12" height="4" rx="1" fill="#fff"/><circle cx="46" cy="38" r="3.5" fill="#f59e0b"/></svg></div>
                <div class="hulo-hero-text">
                    <h1 class="hulo-hero-title">Payments</h1>
                    <p class="hulo-hero-sub">Stripe, Adyen, PayPal and Mollie behind one contract — sessions, wallets, 3-D Secure, captures, refunds, disputes, saved cards, subscriptions and pay-by-link, all in one ledger.</p>
                </div>
                <div class="hulo-hero-actions">
                    <button class="gbtn gbtn-hero" (click)="showHelp = !showHelp">{{ showHelp ? 'Hide guide' : 'Setup guide' }}</button>
                    <button class="gbtn gbtn-hero" (click)="reloadAll()">Refresh</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="showHelp">
            <div class="hulo-help-drawer">
                <div class="hulo-help-grid">
                    <div class="hulo-help-card"><div class="hulo-help-num">1</div><h4>Add a payment method</h4><p>Settings → Payment methods → new method, handler <strong>Stripe / Adyen / PayPal / Mollie (HULO Payments)</strong>, paste the keys. One method per provider per channel. Optionally attach the <strong>HULO Payments rules</strong> eligibility checker for amount bands, countries or customer groups.</p></div>
                    <div class="hulo-help-card"><div class="hulo-help-num">2</div><h4>Point the provider's webhook here</h4><p>Copy the URL from the Providers tab into the provider dashboard (Stripe: payment_intent.*, charge.*, checkout.session.completed, invoice.*, customer.subscription.*; Adyen: standard webhook with HMAC; PayPal: all payment, dispute and billing events; Mollie: automatic).</p></div>
                    <div class="hulo-help-card"><div class="hulo-help-num">3</div><h4>Wire the storefront</h4><p><span class="code-inline">huloPaymentProviders</span> lists what to offer; <span class="code-inline">huloCreatePaymentSession</span> returns the client secret / session / checkout URL; then the normal <span class="code-inline">addPaymentToOrder</span> with the provider's result. Snippets for each provider are in the README.</p></div>
                    <div class="hulo-help-card"><div class="hulo-help-num">4</div><h4>Subscriptions &amp; pay-by-link</h4><p>Set a billing interval on any product variant to make it a subscription. Send a payment link for any unpaid order from the Pay by link tab.</p></div>
                </div>
                <div class="hulo-help-links">
                    <a href="https://huloglobal.com/vendure-plugins/payments/docs/" target="_blank">Full docs ↗</a>
                    <a href="https://huloglobal.com/vendure-plugins/payments/" target="_blank">Plugin page ↗</a>
                    <a href="mailto:support@huloglobal.com">Email support</a>
                </div>
            </div>
        </vdr-page-block>

        <!-- ── Licence & billing ───────────────────────────────────── -->
        <vdr-page-block *ngIf="meta && meta.licensed">
            <div class="update-banner" style="margin-top:8px">
                <div><strong>✅ Licensed</strong> — {{ licenceLabel() }}</div>
                <div class="actions eval-actions">
                    <ng-container *ngIf="meta.licence && !meta.licence.master && meta.licence.plan !== 'lifetime'">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="openPortal()" [disabled]="portalOpening">{{ portalOpening ? 'Opening…' : 'Manage billing ↗' }}</button>
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLifetime()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Upgrade to lifetime →' }}</button>
                    </ng-container>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/payments/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
        </vdr-page-block>
        <vdr-page-block *ngIf="meta && !meta.licensed">
            <div class="update-banner major" *ngIf="meta.tier === 'trial'">
                <div>
                    <strong>⏳ Full-featured evaluation</strong> —
                    <ng-container *ngIf="meta.eval?.daysRemaining != null; else evalNoClock">
                        <strong>{{ meta.eval.daysRemaining }} day{{ meta.eval.daysRemaining === 1 ? '' : 's' }} left</strong> with everything enabled — Adyen, PayPal, Mollie, subscriptions, saved cards, pay-by-link, routing and surcharges included.
                    </ng-container>
                    <ng-template #evalNoClock>everything is enabled — Adyen, PayPal, Mollie, subscriptions, saved cards, pay-by-link, routing and surcharges included.</ng-template>
                    Afterwards the plugin drops to the free tier.
                </div>
                <div class="actions eval-actions">
                    <select [(ngModel)]="buyPlan" [disabled]="buying" class="plan-select"><option value="monthly">Monthly · 14-day free trial</option><option value="annual">Annual · 14-day free trial, 2 months free</option><option value="lifetime">Lifetime · one-off</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : (buyPlan === 'lifetime' ? 'Buy lifetime →' : 'Start 14-day free trial →') }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/payments/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
            <div class="update-banner major" *ngIf="meta.tier !== 'trial'">
                <div>
                    <strong>🔓 Free tier</strong> — Stripe (cards, wallets, 3-D Secure, captures, refunds, disputes), the ledger and this dashboard stay active. Adyen, PayPal, Mollie, subscriptions, saved cards, pay-by-link, provider routing and surcharges need a licence.
                    Start your <strong>14-day free trial</strong> below (card required, nothing charged until day 15, cancel any time) or buy a lifetime licence.
                </div>
                <div class="actions">
                    <select [(ngModel)]="buyPlan" [disabled]="buying" class="plan-select"><option value="monthly">Monthly</option><option value="annual">Annual (2 months free)</option><option value="lifetime">Lifetime</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Buy licence →' }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/payments/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
            <div class="update-banner" style="margin-top:8px">
                <div><strong>🔑 Already have a licence key?</strong> Paste it from your purchase email to activate instantly — no .env edit, no redeploy.</div>
                <div class="actions eval-actions">
                    <input class="eval-email" style="min-width:280px" type="text" placeholder="eyJhbGciOi…" [(ngModel)]="licenceKeyInput" [disabled]="activating">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="activateLicence()" [disabled]="activating || !licenceKeyInput">{{ activating ? 'Verifying…' : 'Activate' }}</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="updateAvailable()">
            <div class="update-banner">
                <div>
                    <strong>📦 Update available</strong>
                    <!--email_off-->{{ meta.name }} {{ meta.version }} → <strong>{{ meta.update.latest }}</strong><!--/email_off-->
                </div>
                <div class="actions">
                    <a href="https://huloglobal.com/vendure-plugins/payments/changelog/" target="_blank" class="gbtn gbtn-outline gbtn-sm">What&rsquo;s new ↗</a>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="meta.update = null">Dismiss</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="dash && !configuredCount()">
            <div class="card"><div class="card-block">
                <h3 class="step-title" style="margin:0 0 4px">Three steps to taking payments</h3>
                <div class="hulo-help-grid" style="margin-top:12px">
                    <div class="hulo-help-card"><div class="hulo-help-num">1</div><h4>Connect a provider</h4><p>Stripe, Adyen, PayPal, Mollie, Square, Braintree, GoCardless, Checkout.com, crypto, bank transfer or pay later. Paste the keys; the plugin checks them and sets up the webhook.</p><button class="gbtn gbtn-primary gbtn-sm" style="margin-top:8px" (click)="go('providers')">Choose a provider →</button></div>
                    <div class="hulo-help-card"><div class="hulo-help-num">2</div><h4>Send customers to the hosted checkout</h4><p>One mutation, one redirect: <span class="code-inline">huloHostedCheckout(returnUrl)</span> returns a page that shows every enabled method and brings the customer back paid. No provider code in your storefront.</p><button class="gbtn gbtn-outline gbtn-sm" style="margin-top:8px" (click)="go('settings')">Brand the page →</button></div>
                    <div class="hulo-help-card"><div class="hulo-help-num">3</div><h4>Take a test payment</h4><p>Use test-mode keys first; every capture, refund and dispute shows up in Transactions. Switch to live keys with Reconnect when you are happy.</p><a class="gbtn gbtn-outline gbtn-sm" style="margin-top:8px" href="https://huloglobal.com/vendure-plugins/payments/docs/" target="_blank">Read the guide ↗</a></div>
                </div>
            </div></div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="card top-bar"><div class="card-block">
                <div class="tabs" role="tablist">
                    <button class="tab" role="tab" [class.active]="tab==='overview'" (click)="go('overview')">Overview</button>
                    <button class="tab" role="tab" [class.active]="tab==='transactions'" (click)="go('transactions')">Transactions<span class="tab-count" *ngIf="txns?.totalItems">{{ txns.totalItems }}</span></button>
                    <button class="tab" role="tab" [class.active]="tab==='subscriptions'" (click)="go('subscriptions')">Subscriptions<span class="tab-count" *ngIf="subs?.totalItems">{{ subs.totalItems }}</span></button>
                    <button class="tab" role="tab" [class.active]="tab==='paylink'" (click)="go('paylink')">Pay by link</button>
                    <button class="tab" role="tab" [class.active]="tab==='providers'" (click)="go('providers')">Providers</button>
                    <button class="tab" role="tab" [class.active]="tab==='settings'" (click)="go('settings')">Settings</button>
                </div>
            </div></div>
        </vdr-page-block>

        <!-- OVERVIEW -->
        <ng-container *ngIf="tab==='overview' && dash">
            <vdr-page-block>
                <div class="kpi-row">
                    <div class="kpi"><div class="kpi-label">Volume · {{ days }}d</div><div class="kpi-num">{{ money(dash.ledger.totals.volume, mainCurrency()) }}</div><div class="kpi-sub">{{ dash.ledger.totals.captures }} captures</div></div>
                    <div class="kpi"><div class="kpi-label">Success rate</div><div class="kpi-num">{{ dash.ledger.totals.successRate == null ? '—' : dash.ledger.totals.successRate + '%' }}</div><div class="kpi-sub">{{ dash.ledger.totals.failures }} failed</div></div>
                    <div class="kpi"><div class="kpi-label">Refunded</div><div class="kpi-num">{{ money(dash.ledger.totals.refunded, mainCurrency()) }}</div><div class="kpi-sub">last {{ days }} days</div></div>
                    <div class="kpi" [class.kpi-alert]="dash.ledger.totals.openDisputes"><div class="kpi-label">Disputes</div><div class="kpi-num">{{ dash.ledger.totals.openDisputes }}</div><div class="kpi-sub">open · {{ dash.ledger.totals.disputes }} in period</div></div>
                    <div class="kpi"><div class="kpi-label">Subscriptions</div><div class="kpi-num">{{ dash.subscriptions.active + dash.subscriptions.trialing }}</div><div class="kpi-sub">MRR {{ mrrLabel() }}<span *ngIf="dash.subscriptions.pastDue"> · {{ dash.subscriptions.pastDue }} past due</span></div></div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="two-col">
                    <div class="card"><div class="card-block">
                        <div class="row-between"><h3 class="step-title" style="margin:0">Daily volume</h3><select class="form-select" [(ngModel)]="days" (ngModelChange)="loadDashboard()"><option [ngValue]="7">7 days</option><option [ngValue]="30">30 days</option><option [ngValue]="90">90 days</option></select></div>
                        <div class="bar" *ngIf="dayBars().length; else noVol"><div *ngFor="let b of dayBars()" [style.height.%]="b.pct" [title]="b.day + ': ' + money(b.volume, mainCurrency())"></div></div>
                        <ng-template #noVol><p class="hint">No captured payments in this period yet.</p></ng-template>
                    </div></div>
                    <div class="card"><div class="card-block">
                        <h3 class="step-title">By provider</h3>
                        <table class="table">
                            <thead><tr><th>Provider</th><th class="num">Volume</th><th class="num">Captures</th><th class="num">Failed</th><th class="num">Refunded</th><th class="num">Disputes</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let p of dash.providers">
                                    <td><strong>{{ p.name }}</strong> <span class="pill" [class.ok]="p.configured">{{ p.configured ? 'configured' : 'not set up' }}</span> <span class="pill" *ngIf="!p.freeTier && !dash.premium">licence</span></td>
                                    <td class="num">{{ money(providerStat(p.code, 'volume'), mainCurrency()) }}</td>
                                    <td class="num">{{ providerStat(p.code, 'captures') }}</td>
                                    <td class="num">{{ providerStat(p.code, 'failures') }}</td>
                                    <td class="num">{{ money(providerStat(p.code, 'refunded'), mainCurrency()) }}</td>
                                    <td class="num">{{ providerStat(p.code, 'disputes') }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div></div>
                </div>
            </vdr-page-block>
        </ng-container>

        <!-- TRANSACTIONS -->
        <vdr-page-block *ngIf="tab==='transactions'">
            <div class="card"><div class="card-block">
                <div class="row-between">
                    <div class="picker">
                        <select class="form-select" [(ngModel)]="txnKind" (ngModelChange)="loadTxns()"><option value="all">All kinds</option><option *ngFor="let k of kinds" [value]="k">{{ k }}</option></select>
                        <select class="form-select" [(ngModel)]="txnStatus" (ngModelChange)="loadTxns()"><option value="all">All statuses</option><option value="ok">ok</option><option value="failed">failed</option><option value="pending">pending</option><option value="open">open</option><option value="won">won</option><option value="lost">lost</option></select>
                        <input class="form-input" placeholder="Order code" [(ngModel)]="txnSearch" (keyup.enter)="loadTxns()">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="loadTxns()">Search</button>
                    </div>
                    <span class="hint" style="margin:0">Refunds are issued from the order page (Vendure refund) — they land here automatically.</span>
                </div>
                <table class="table" *ngIf="txns?.items?.length; else noTxns">
                    <thead><tr><th>When</th><th>Provider</th><th>Kind</th><th>Order</th><th class="num">Amount</th><th>Reference</th><th>Status</th></tr></thead>
                    <tbody>
                        <tr *ngFor="let t of txns.items">
                            <td class="nowrap" [title]="t.createdAt">{{ relative(t.createdAt) }}</td>
                            <td>{{ providerName(t.provider) }}</td>
                            <td>{{ t.kind }}</td>
                            <td><a *ngIf="t.orderId" [routerLink]="['/orders', t.orderId]">{{ t.orderCode }}</a><span *ngIf="!t.orderId">{{ t.orderCode || '—' }}</span></td>
                            <td class="num">{{ money(t.amount, t.currency) }}</td>
                            <td class="mono small">{{ t.paymentRef || '—' }}<div class="muted" *ngIf="t.reason">{{ t.reason }}</div></td>
                            <td><span class="pill" [ngClass]="t.status">{{ t.status }}</span></td>
                        </tr>
                    </tbody>
                </table>
                <ng-template #noTxns><p class="hint">Nothing recorded yet — the first payment through a HULO method will appear here.</p></ng-template>
                <div class="picker" *ngIf="txns && txns.totalItems > txns.perPage" style="margin-top:10px">
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="txnPage = txnPage - 1; loadTxns()" [disabled]="txnPage <= 1">‹ Prev</button>
                    <span class="hint" style="margin:0">page {{ txnPage }}</span>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="txnPage = txnPage + 1; loadTxns()" [disabled]="txnPage * txns.perPage >= txns.totalItems">Next ›</button>
                </div>
            </div></div>
        </vdr-page-block>

        <!-- SUBSCRIPTIONS -->
        <vdr-page-block *ngIf="tab==='subscriptions'">
            <div class="card"><div class="card-block">
                <div class="row-between">
                    <div class="picker">
                        <select class="form-select" [(ngModel)]="subStatus" (ngModelChange)="loadSubs()"><option value="all">All statuses</option><option *ngFor="let s of ['active','trialing','pending','past_due','paused','canceled']" [value]="s">{{ s }}</option></select>
                        <input class="form-input" placeholder="Order, email, product" [(ngModel)]="subSearch" (keyup.enter)="loadSubs()">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="loadSubs()">Search</button>
                    </div>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="runScheduler()" [disabled]="busy">Run renewals now</button>
                </div>
                <p class="hint">A product variant becomes a subscription when it has a billing interval (Catalog → variant → custom fields). The order charges the first period; Stripe, PayPal and Mollie bill the rest natively, Adyen renewals are charged by the plugin's scheduler from the stored card. <span *ngIf="!dash?.premium" class="warn-inline">Subscriptions need a licence.</span></p>
                <table class="table" *ngIf="subs?.items?.length; else noSubs">
                    <thead><tr><th>Customer</th><th>Product</th><th>Provider</th><th class="num">Per period</th><th>Billing</th><th>Status</th><th>Next / period end</th><th></th></tr></thead>
                    <tbody>
                        <tr *ngFor="let s of subs.items">
                            <td>{{ s.customerEmail }}<div class="hint" style="margin:0">order <a *ngIf="s.orderId" [routerLink]="['/orders', s.orderId]">{{ s.orderCode }}</a></div></td>
                            <td>{{ s.variantName }} × {{ s.quantity }}</td>
                            <td>{{ providerName(s.provider) }}<div class="mono small muted">{{ s.providerSubscriptionRef }}</div></td>
                            <td class="num">{{ money(s.amount * s.quantity, s.currency) }}</td>
                            <td>every {{ s.intervalCount > 1 ? s.intervalCount + ' ' : '' }}{{ s.interval }}{{ s.intervalCount > 1 ? 's' : '' }}</td>
                            <td><span class="pill" [ngClass]="s.status">{{ s.status }}</span><div class="small muted" *ngIf="s.cancelAtPeriodEnd">ends at period end</div><div class="small muted" *ngIf="s.failures">{{ s.failures }} failed attempt(s)</div><a *ngIf="s.approveUrl && s.status === 'pending'" [href]="s.approveUrl" target="_blank" class="small">customer approval link ↗</a></td>
                            <td class="nowrap">{{ s.currentPeriodEnd ? (s.currentPeriodEnd | date:'d MMM y') : '—' }}</td>
                            <td class="nowrap">
                                <button class="gbtn gbtn-outline gbtn-sm" *ngIf="s.status === 'active' || s.status === 'trialing'" (click)="subAction(s, 'pause')" [disabled]="busy">Pause</button>
                                <button class="gbtn gbtn-outline gbtn-sm" *ngIf="s.status === 'paused'" (click)="subAction(s, 'resume')" [disabled]="busy">Resume</button>
                                <button class="gbtn gbtn-ghost gbtn-danger gbtn-sm" *ngIf="s.status !== 'canceled'" (click)="cancelSub(s)" [disabled]="busy">Cancel</button>
                            </td>
                        </tr>
                    </tbody>
                </table>
                <ng-template #noSubs><p class="hint">No subscriptions yet.</p></ng-template>
            </div></div>
        </vdr-page-block>

        <!-- PAY BY LINK -->
        <vdr-page-block *ngIf="tab==='paylink'">
            <div class="two-col">
                <div class="card"><div class="card-block">
                    <h3 class="step-title">Send a payment link</h3>
                    <p class="hint">For any order that still needs paying — draft orders built in the admin, accepted quotes, phone orders. The customer pays on the provider's hosted page; the order moves to PaymentSettled by webhook. <span *ngIf="!dash?.premium" class="warn-inline">Needs a licence.</span></p>
                    <div class="form-grid">
                        <div class="form-row"><label>Order code</label><input class="form-input" style="width:100%" [(ngModel)]="linkOrder" placeholder="e.g. A1B2C3D4E5F6G7H8"></div>
                        <div class="form-row"><label>Provider</label><select class="form-select" style="width:100%" [(ngModel)]="linkProvider"><option value="">Preferred provider</option><option *ngFor="let p of linkProviders()" [value]="p.code">{{ p.name }}</option></select></div>
                        <div class="form-row"><label>Expires in</label><select class="form-select" style="width:100%" [(ngModel)]="linkHours"><option [ngValue]="24">24 hours</option><option [ngValue]="72">3 days</option><option [ngValue]="168">7 days</option><option [ngValue]="720">30 days</option></select></div>
                    </div>
                    <div class="picker" style="margin-top:12px">
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="createLink()" [disabled]="busy || !linkOrder">{{ busy ? 'Creating…' : 'Create link' }}</button>
                    </div>
                    <div *ngIf="link" class="status-sentence" style="margin-top:14px">
                        <strong>{{ providerName(link.provider) }} · {{ money(link.amount, link.currency) }}</strong><br>
                        <span class="url">{{ link.url }}</span>
                        <div class="picker" style="margin-top:8px"><button class="gbtn gbtn-outline gbtn-sm" (click)="copy(link.url)">{{ copied ? 'Copied ✓' : 'Copy link' }}</button><a [href]="link.url" target="_blank" class="gbtn gbtn-outline gbtn-sm">Open ↗</a><span class="hint" style="margin:0" *ngIf="link.expiresAt">expires {{ link.expiresAt | date:'d MMM y HH:mm' }}</span></div>
                    </div>
                </div></div>
                <div class="card"><div class="card-block">
                    <h3 class="step-title">Recent links</h3>
                    <table class="table" *ngIf="links?.items?.length; else noLinks">
                        <thead><tr><th>When</th><th>Order</th><th class="num">Amount</th><th>Provider</th><th>Status</th></tr></thead>
                        <tbody><tr *ngFor="let t of links.items"><td class="nowrap">{{ relative(t.createdAt) }}</td><td><a *ngIf="t.orderId" [routerLink]="['/orders', t.orderId]">{{ t.orderCode }}</a></td><td class="num">{{ money(t.amount, t.currency) }}</td><td>{{ providerName(t.provider) }}</td><td><span class="pill" [ngClass]="t.status">{{ t.status === 'pending' ? 'sent' : t.status === 'ok' ? 'paid' : t.status }}</span></td></tr></tbody>
                    </table>
                    <ng-template #noLinks><p class="hint">No links created yet.</p></ng-template>
                </div></div>
            </div>
        </vdr-page-block>

        <!-- PROVIDERS -->
        <vdr-page-block *ngIf="tab==='providers' && providers">
            <div class="prov-grid">
                <div class="prov-card" *ngFor="let p of providers.providers">
                    <h4>{{ p.name }} <span class="pill" [class.ok]="p.methods.length">{{ p.methods.length ? p.methods.length + ' method(s)' : 'not configured' }}</span> <span class="pill" *ngIf="p.freeTier">free tier</span><span class="pill" *ngIf="!p.freeTier && !dash?.premium">licence required</span></h4>
                    <div class="caps">
                        <span class="cap" [class.on]="p.capabilities.session">hosted session</span><span class="cap" [class.on]="p.capabilities.manualCapture">manual capture</span><span class="cap" [class.on]="p.capabilities.partialRefund">partial refunds</span><span class="cap" [class.on]="p.capabilities.savedMethods">saved cards</span><span class="cap" [class.on]="p.capabilities.subscriptions">subscriptions</span><span class="cap" [class.on]="p.capabilities.payByLink">pay by link</span><span class="cap" [class.on]="p.capabilities.disputes">disputes</span>
                    </div>
                    <div class="small muted">Wallets: {{ p.capabilities.wallets.join(', ') }}</div>
                    <div class="picker small" style="margin-top:8px">
                        <a [href]="p.links.dashboard" target="_blank" rel="noopener">{{ p.name }} dashboard ↗</a>
                        <a *ngIf="p.links.keys" [href]="p.links.keys" target="_blank" rel="noopener">API keys ↗</a>
                        <a *ngIf="p.links.webhooks" [href]="p.links.webhooks" target="_blank" rel="noopener">Webhooks ↗</a>
                        <a *ngIf="p.links.docs" [href]="p.links.docs" target="_blank" rel="noopener">Docs ↗</a>
                    </div>
                    <table class="table" *ngIf="p.methods.length" style="margin-top:8px">
                        <thead><tr><th>Method</th><th>Env</th><th>Channels</th><th>Webhook</th><th>Enabled</th></tr></thead>
                        <tbody><tr *ngFor="let m of p.methods"><td><a [routerLink]="['/settings', 'payment-methods', m.id]">{{ m.code }}</a></td><td>{{ m.environment }}</td><td>{{ channelNames(m.channelIds) }}</td><td><span class="pill" [class.ok]="m.webhookConfigured" [class.pending]="!m.webhookConfigured">{{ m.webhookConfigured ? 'configured' : 'missing' }}</span></td><td><span class="pill" [class.ok]="m.enabled">{{ m.enabled ? 'on' : 'off' }}</span></td></tr></tbody>
                    </table>
                    <div class="picker" style="margin-top:10px">
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="openConnect(p)" [disabled]="!p.freeTier && !dash?.premium">{{ connectFor === p.code ? 'Close' : (p.methods.length ? 'Reconnect / update keys' : 'Connect ' + p.name + ' →') }}</button>
                    </div>
                    <div *ngIf="connectFor === p.code" class="connect-panel">
                        <p class="hint" style="margin:0 0 10px">Paste the keys from the <a [href]="p.links.keys || p.links.dashboard" target="_blank" rel="noopener">{{ p.name }} dashboard ↗</a>. Connect checks them with {{ p.name }}, {{ p.code === 'hulo-mollie' ? 'needs no webhook setup' : 'registers the webhook for you' }}, and creates the payment method — nothing to copy back by hand.</p>
                        <div class="form-grid">
                            <div class="form-row"><label>Channel</label><select class="form-select" [(ngModel)]="connectChannel"><option *ngFor="let c of providers.channels" [ngValue]="c.id">{{ c.code === '__default_channel__' ? 'Default channel' : c.code }}</option></select></div>
                            <div class="form-row" *ngFor="let f of p.connectFields">
                                <label>{{ f.label }}</label>
                                <select class="form-select" *ngIf="f.options" [(ngModel)]="connectArgs[f.name]"><option *ngFor="let o of f.options" [value]="o">{{ o }}</option></select>
                                <input class="form-input" *ngIf="!f.options" [type]="f.secret ? 'password' : 'text'" autocomplete="off" [(ngModel)]="connectArgs[f.name]" [placeholder]="f.secret ? '••••••••' : ''" style="width:100%">
                                <div class="small muted" *ngIf="f.description">{{ f.description }}</div>
                            </div>
                        </div>
                        <div class="picker" style="margin-top:12px">
                            <button class="gbtn gbtn-outline gbtn-sm" (click)="testConnect(p)" [disabled]="busy">{{ busy ? 'Checking…' : 'Test connection' }}</button>
                            <button class="gbtn gbtn-primary gbtn-sm" (click)="connect(p)" [disabled]="busy">{{ busy ? 'Connecting…' : (p.methods.length ? 'Update & reconnect' : 'Connect & create payment method') }}</button>
                        </div>
                        <div *ngIf="connectResult" class="status-sentence" [class.status-danger]="!connectResult.ok" style="margin-top:12px">
                            <strong>{{ connectResult.ok ? '✓' : '✕' }}</strong> {{ connectResult.message }}
                            <div *ngIf="connectResult.webhook" class="small" style="margin-top:4px">Webhook: {{ connectResult.webhook.configured ? 'configured' : 'not configured' }}{{ connectResult.webhook.note ? ' — ' + connectResult.webhook.note : '' }}</div>
                            <div *ngIf="connectResult.method" class="small" style="margin-top:4px">Payment method <a [routerLink]="['/settings', 'payment-methods', connectResult.method.id]">{{ connectResult.method.code }}</a> {{ connectResult.method.updated ? 'updated' : 'created' }} and {{ connectResult.method.enabled ? 'enabled' : 'left disabled' }}.</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="card" style="margin-top:14px"><div class="card-block">
                <h3 class="step-title">Recent webhook deliveries</h3>
                <table class="table" *ngIf="events?.length; else noEvents">
                    <thead><tr><th>Received</th><th>Provider</th><th>Event</th><th>Order</th><th>Result</th></tr></thead>
                    <tbody><tr *ngFor="let e of events"><td class="nowrap">{{ relative(e.receivedAt) }}</td><td>{{ providerName(e.provider) }}</td><td class="mono small">{{ e.type }}<div class="muted">{{ e.eventId }}</div></td><td>{{ e.orderCode || '—' }}</td><td><span class="pill" [ngClass]="e.error ? 'failed' : (e.processedAt ? 'ok' : 'pending')">{{ e.error ? 'error' : (e.processedAt ? 'processed' : 'received') }}</span><div class="small muted" *ngIf="e.error">{{ e.error }}</div></td></tr></tbody>
                </table>
                <ng-template #noEvents><p class="hint">No webhooks received yet — send a test event from the provider dashboard to check the URL and secret.</p></ng-template>
            </div></div>
        </vdr-page-block>

        <!-- SETTINGS -->
        <vdr-page-block *ngIf="tab==='settings' && settingsList">
            <div class="card"><div class="card-block">
                <div class="row-between"><h3 class="step-title" style="margin:0">Channel</h3>
                    <select class="form-select" [(ngModel)]="cfgIdx" (ngModelChange)="cfg = settingsList[cfgIdx]"><option *ngFor="let s of settingsList; let i = index" [ngValue]="i">{{ s.channelCode }}</option></select></div>
                <ng-container *ngIf="cfg">
                    <h3 class="step-title" style="margin-top:14px">Routing</h3>
                    <p class="hint">The first configured provider in this order is offered first; the storefront can fall back to the next when a payment is declined. <span *ngIf="!dash?.premium" class="warn-inline">Routing, surcharges and saved cards need a licence.</span></p>
                    <div class="form-grid">
                        <div class="form-row wide"><label>Provider order</label>
                            <div class="picker"><ng-container *ngFor="let code of cfg.providerOrder; let i = index"><span class="pill">{{ i + 1 }}. {{ providerName(code) }}</span><button class="gbtn gbtn-ghost gbtn-sm" (click)="moveProvider(i, -1)" [disabled]="i === 0" aria-label="Move up">↑</button><button class="gbtn gbtn-ghost gbtn-sm" (click)="moveProvider(i, 1)" [disabled]="i === cfg.providerOrder.length - 1" aria-label="Move down">↓</button></ng-container></div></div>
                        <div class="form-row"><label>Fall back to the next provider on decline</label><span class="gb-switch-group"><button class="gb-switch" role="switch" [attr.aria-checked]="cfg.fallbackOnFailure" [class.on]="cfg.fallbackOnFailure" (click)="cfg.fallbackOnFailure = !cfg.fallbackOnFailure"><span class="gb-switch-knob"></span></button><span>{{ cfg.fallbackOnFailure ? 'On' : 'Off' }}</span></span></div>
                        <div class="form-row"><label>Offer "save this card" to signed-in customers</label><span class="gb-switch-group"><button class="gb-switch" role="switch" [attr.aria-checked]="cfg.saveCardsDefault" [class.on]="cfg.saveCardsDefault" (click)="cfg.saveCardsDefault = !cfg.saveCardsDefault"><span class="gb-switch-knob"></span></button><span>{{ cfg.saveCardsDefault ? 'On' : 'Off' }}</span></span></div>
                    </div>
                    <h3 class="step-title" style="margin-top:14px">Surcharges</h3>
                    <p class="hint">Added to the order as a surcharge line when the storefront calls <span class="code-inline">huloApplyPaymentSurcharge</span>. Check your local rules before charging fees on consumer card payments.</p>
                    <table class="table"><thead><tr><th>Provider</th><th>Type</th><th class="num">Value</th><th>Label</th></tr></thead>
                        <tbody><tr *ngFor="let p of providerCodes()">
                            <td>{{ providerName(p) }}</td>
                            <td><select class="form-select" [ngModel]="surcharge(p).type" (ngModelChange)="setSurcharge(p, 'type', $event)"><option value="percent">% of total</option><option value="fixed">fixed (minor units)</option></select></td>
                            <td class="num"><input class="form-input" type="number" min="0" step="0.01" style="width:120px" [ngModel]="surcharge(p).value" (ngModelChange)="setSurcharge(p, 'value', $event)"></td>
                            <td><input class="form-input" [ngModel]="surcharge(p).label" (ngModelChange)="setSurcharge(p, 'label', $event)" placeholder="e.g. PayPal handling fee"></td>
                        </tr></tbody></table>
                    <h3 class="step-title" style="margin-top:14px">Hosted checkout page</h3>
                    <p class="hint">The plugin serves a payment page at <span class="code-inline">/hulo-payments/pay/&lt;token&gt;</span> listing every enabled method in the order above. Your storefront calls <span class="code-inline">huloHostedCheckout(returnUrl: "https://shop.example.com/checkout/return")</span> and redirects to the URL it returns; the customer comes back to <span class="code-inline">returnUrl?order=CODE&amp;result=paid|pending</span>.</p>
                    <div class="form-grid">
                        <div class="form-row"><label>Shop name on the page</label><input class="form-input" style="width:100%" [(ngModel)]="cfg.hostedBrandName" placeholder="Your shop"></div>
                        <div class="form-row"><label>Accent colour</label><div class="picker"><input class="form-input" style="width:120px" [(ngModel)]="cfg.hostedAccent" placeholder="#1d4ed8"><span class="swatch" [style.background]="cfg.hostedAccent" style="width:28px;height:28px;border-radius:8px;border:1px solid var(--gb-line)"></span></div></div>
                        <div class="form-row wide"><label>Logo URL</label><input class="form-input" style="width:100%" [(ngModel)]="cfg.hostedLogoUrl" placeholder="https://…/logo.svg (optional)"></div>
                    </div>
                    <h3 class="step-title" style="margin-top:14px">Operations</h3>
                    <div class="form-grid">
                        <div class="form-row"><label>Ops email for disputes and failed renewals</label><input class="form-input" style="width:100%" [(ngModel)]="cfg.opsEmail" placeholder="ops@example.com"></div>
                        <div class="form-row"><label>Cancel a past-due subscription after N failed daily attempts</label><input class="form-input" type="number" min="1" max="60" [(ngModel)]="cfg.dunningDays"></div>
                    </div>
                    <div class="picker" style="margin-top:14px"><button class="gbtn gbtn-primary gbtn-sm" (click)="saveSettings()" [disabled]="busy">{{ busy ? 'Saving…' : 'Save settings' }}</button></div>
                </ng-container>
            </div></div>
        </vdr-page-block>
`,
    styles: [`
        :host { display: block; color: var(--gb-strong); }

        /* ── Verified theme tokens (HULO admin design system) ─────────
           Same machine-checked token set as fraud-prevention — every
           text/surface pair >= 4.5:1 and every control boundary >= 3:1
           against the real admin theme values, both themes. */
        :host {
            --gb-surface: var(--color-component-bg-100, #fafafa);
            --gb-surface-2: var(--color-component-bg-200, #f2f3f5);
            --gb-line: var(--color-component-border-200, #d5d8de);
            --gb-line-soft: var(--color-component-border-100, #e8eaee);
            --gb-strong: #3d4147;
            --gb-muted: #5d6470;
            --gb-ui-border: #79818f;
            --gb-amber: #f59e0b;
            --gb-amber-hover: #e18f06;
            --gb-amber-edge: #b45309;
            --gb-amber-ink: #231602;
            --gb-danger-ink: #b91c1c;
            --gb-ok: #10b981; --gb-warn: #f59e0b; --gb-bad: #ef4444; --gb-info: #3b82f6;
            --gb-blue: #2a78d6;
            --gb-tint-ok:   color-mix(in srgb, var(--gb-ok) 10%, var(--gb-surface));
            --gb-tint-warn: color-mix(in srgb, var(--gb-warn) 12%, var(--gb-surface));
            --gb-tint-bad:  color-mix(in srgb, var(--gb-bad) 10%, var(--gb-surface));
            --gb-tint-info: color-mix(in srgb, var(--gb-info) 10%, var(--gb-surface));
            --gb-line-ok:   color-mix(in srgb, var(--gb-ok) 45%, transparent);
            --gb-line-warn: color-mix(in srgb, var(--gb-warn) 50%, transparent);
            --gb-line-bad:  color-mix(in srgb, var(--gb-bad) 45%, transparent);
            --gb-line-info: color-mix(in srgb, var(--gb-info) 45%, transparent);
            --gb-shadow-1: 0 1px 2px rgba(15, 23, 42, 0.06);
        }
        :host-context([data-theme='dark']) {
            --gb-strong: var(--color-text-100, hsl(210, 16%, 93%));
            --gb-muted: hsl(205, 14%, 74%);
            --gb-ui-border: hsl(203, 12%, 50%);
            --gb-amber-edge: #f59e0b;
            --gb-danger-ink: #f87171;
            --gb-blue: #3987e5;
            --gb-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.35);
        }

        /* ── Buttons (self-owned) ─────────────────────────────────── */
        .gbtn {
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            min-height: 36px; padding: 0 16px; border-radius: 8px;
            font-size: 13px; font-weight: 600; line-height: 1.2; white-space: nowrap;
            border: 1px solid transparent; background: none; cursor: pointer;
            color: var(--gb-strong); text-decoration: none;
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
        }
        .gbtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .gbtn:focus-visible, .tab:focus-visible, .seg:focus-visible {
            outline: 2px solid var(--gb-amber-edge); outline-offset: 2px;
        }
        .gbtn-sm { min-height: 30px; padding: 0 12px; font-size: 12px; }
        .gbtn-primary { background: var(--gb-amber); border-color: var(--gb-amber-edge); color: var(--gb-amber-ink); box-shadow: var(--gb-shadow-1); }
        .gbtn-primary:hover:not(:disabled) { background: var(--gb-amber-hover); }
        .gbtn-outline { border-color: var(--gb-ui-border); background: var(--gb-surface); }
        .gbtn-outline:hover:not(:disabled) { border-color: var(--gb-amber-edge); background: var(--gb-surface-2); }
        .gbtn-ghost { color: var(--gb-muted); }
        .gbtn-ghost:hover:not(:disabled) { color: var(--gb-strong); background: var(--gb-surface-2); }
        .gbtn-danger { color: var(--gb-danger-ink); }
        .gbtn-danger:hover:not(:disabled) { color: var(--gb-danger-ink); background: var(--gb-tint-bad); }
        .gbtn-hero { color: #e2e8f0; }
        .gbtn-hero:hover:not(:disabled) { color: #ffffff; background: rgba(255, 255, 255, 0.12); }
        .gbtn-hero:focus-visible { outline-color: #f59e0b; }

        /* ── Hero ─────────────────────────────────────────────────── */
        .hulo-hero {
            display: flex; align-items: center; gap: 18px;
            padding: 20px 22px; border-radius: 14px;
            background: linear-gradient(135deg, #0f1419 0%, #1e293b 100%);
            color: #fff;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.15), 0 8px 24px rgba(15, 23, 42, 0.08);
        }
        .hulo-hero-logo { flex: 0 0 auto; width: 56px; height: 56px; }
        .hulo-hero-logo svg { width: 100%; height: 100%; display: block; }
        .hulo-hero-text { flex: 1 1 auto; min-width: 0; }
        .hulo-hero-title { color: #fff; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
        .hulo-hero-sub { color: #cbd5e1; font-size: 13px; line-height: 1.5; margin: 4px 0 0; max-width: 720px; }
        .hulo-hero-actions { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }

        /* ── Help drawer ──────────────────────────────────────────── */
        .hulo-help-drawer { background: var(--gb-tint-warn); border: 1px solid var(--gb-line-warn); border-radius: 12px; padding: 20px 22px; color: var(--gb-strong); }
        .hulo-help-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
        .hulo-help-card { background: var(--gb-surface); border-radius: 10px; padding: 16px; border: 1px solid var(--gb-line); }
        .hulo-help-num { width: 24px; height: 24px; border-radius: 999px; background: var(--gb-amber); color: var(--gb-amber-ink); font-weight: 800; font-size: 13px; display: grid; place-items: center; margin-bottom: 8px; }
        .hulo-help-card h4 { margin: 0 0 4px; font-size: 14px; color: var(--gb-strong); }
        .hulo-help-card p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--gb-muted); }
        .hulo-help-links { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--gb-line-warn); display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; }
        .hulo-help-links a { color: var(--gb-strong); text-decoration: underline; text-underline-offset: 2px; font-weight: 600; }
        .hulo-help-links a:hover { color: var(--gb-amber-edge); }

        /* ── Cards + layout ───────────────────────────────────────── */
        .card { background: var(--gb-surface); border: 1px solid var(--gb-line); border-radius: 12px; overflow: visible; min-width: 0; box-shadow: var(--gb-shadow-1); }
        .card-block { padding: 18px 20px; }
        .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
        .row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
        .step-title { font-size: 15px; font-weight: 700; color: var(--gb-strong); margin: 0 0 4px; }
        .step-title small { font-weight: 500; font-size: 12px; color: var(--gb-muted); }
        .hint { font-size: 12px; color: var(--gb-muted); margin: 2px 0 12px; line-height: 1.5; }
        .mono { font-family: ui-monospace, monospace; }
        .small { font-size: 11.5px; }
        .muted { color: var(--gb-muted); }
        .nowrap { white-space: nowrap; }
        .warn-inline { color: var(--gb-amber-edge); font-weight: 600; }
        .link-more { color: var(--gb-amber-edge); font-weight: 600; font-size: 12.5px; text-decoration: none; }
        .link-more:hover { text-decoration: underline; }
        .feature-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--gb-strong); }
        .feature-list li { display: flex; align-items: flex-start; gap: 10px; line-height: 1.45; }
        .feature-list .status-dot { margin-top: 5px; }
        .code-block {
            margin: 0 0 14px; padding: 14px 16px; border-radius: 10px; overflow-x: auto;
            background: var(--gb-surface-2); border: 1px solid var(--gb-line);
            color: var(--gb-strong); font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.55;
        }

        /* ── Top bar ──────────────────────────────────────────────── */
        .top-bar { border-left: 4px solid var(--gb-amber); }
        .lbl { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gb-muted); }
        .form-select, .form-input {
            padding: 7px 10px; border-radius: 8px; min-height: 36px;
            border: 1px solid var(--gb-ui-border); background: var(--gb-surface);
            color: var(--gb-strong); font-size: 13px;
        }
        .form-select { min-width: 160px; }
        .form-select:focus, .form-input:focus {
            outline: none; border-color: var(--gb-amber-edge);
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--gb-amber) 30%, transparent);
        }
        .plan-select { padding: 5px 9px; border: 1px solid #d1d5db; border-radius: 7px; font-size: 12.5px; background: #fff; color: #0f172a; }
        .mode-seg { display: inline-flex; border: 1px solid var(--gb-ui-border); border-radius: 999px; overflow: hidden; }
        .seg {
            padding: 7px 14px; min-height: 34px; border: 0; background: none; cursor: pointer;
            font-size: 12px; font-weight: 700; color: var(--gb-muted);
        }
        .seg + .seg { border-left: 1px solid var(--gb-line); }
        .seg:hover { color: var(--gb-strong); background: var(--gb-surface-2); }
        .seg.active { background: var(--gb-amber); color: var(--gb-amber-ink); }
        .status-sentence {
            margin: 0; padding: 10px 14px; border-radius: 8px;
            font-size: 13px; line-height: 1.5; color: var(--gb-strong);
            background: var(--gb-tint-ok); border: 1px solid var(--gb-line-ok); border-left-width: 4px;
        }
        .status-sentence.status-off { background: var(--gb-surface-2); border-color: var(--gb-line); color: var(--gb-muted); }
        .status-sentence.status-danger { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); font-weight: 600; }
        .tabs { display: flex; gap: 4px; margin-top: 14px; flex-wrap: wrap; border-top: 1px solid var(--gb-line-soft); padding-top: 12px; }
        .tab {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 7px 14px; min-height: 34px; border-radius: 999px;
            border: 1px solid transparent; background: none; cursor: pointer;
            font-size: 13px; font-weight: 600; color: var(--gb-muted);
            transition: background 0.12s ease, color 0.12s ease;
        }
        .tab:hover { color: var(--gb-strong); background: var(--gb-surface-2); }
        .tab.active { background: var(--gb-amber); border-color: var(--gb-amber-edge); color: var(--gb-amber-ink); }
        .tab-count {
            font-size: 10px; font-weight: 800; min-width: 16px; height: 16px;
            padding: 0 4px; border-radius: 999px; display: inline-grid; place-items: center;
            background: color-mix(in srgb, currentColor 18%, transparent);
        }

        /* ── KPI tiles ────────────────────────────────────────────── */
        .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
        .kpi { background: var(--gb-surface); border: 1px solid var(--gb-line); border-radius: 12px; padding: 16px 18px; min-width: 0; }
        .kpi-alert { border-color: var(--gb-line-warn); border-left: 4px solid var(--gb-amber); }
        .kpi-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gb-muted); }
        .kpi-num { margin-top: 6px; font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--gb-strong); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
        .kpi-sub { margin-top: 4px; font-size: 12px; color: var(--gb-muted); }
        .kpi-sub a { color: var(--gb-amber-edge); font-weight: 600; text-decoration: none; }
        .kpi-sub a:hover { text-decoration: underline; }

        /* ── Pills + chips ────────────────────────────────────────── */
        .level-pill {
            font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
            color: var(--gb-strong); border: 1px solid var(--gb-line); background: var(--gb-surface-2);
        }
        .lvl-info { background: var(--gb-tint-info); border-color: var(--gb-line-info); }
        .lvl-warn { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); }
        .lvl-bad, .lvl-rejected { background: var(--gb-tint-bad); border-color: var(--gb-line-bad); }
        .lvl-approved { background: var(--gb-tint-ok); border-color: var(--gb-line-ok); }
        .mini-chip {
            font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
            background: var(--gb-surface); border: 1px solid var(--gb-line-warn);
            color: var(--gb-strong); margin: 1px; display: inline-block; vertical-align: middle;
        }
        .exp-soon { color: var(--gb-danger-ink); font-weight: 700; }
        .drop-bad { color: var(--gb-danger-ink); font-weight: 700; }

        /* ── Tables ───────────────────────────────────────────────── */
        .table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .table th {
            text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
            text-transform: uppercase; color: var(--gb-muted);
            padding: 8px 10px; border-bottom: 1px solid var(--gb-line);
        }
        .table td { padding: 9px 10px; border-bottom: 1px solid var(--gb-line-soft); color: var(--gb-strong); vertical-align: top; }
        .table tbody tr:hover { background: var(--gb-surface-2); }
        .table td a { color: var(--gb-blue); font-weight: 600; text-decoration: none; }
        .table td a:hover { text-decoration: underline; }
        .table .num-col { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .table th.num-col { text-align: right; }
        .table.kv td { padding: 6px 8px; font-size: 12.5px; }
        .table.kv .kv-key { color: var(--gb-muted); white-space: nowrap; width: 42%; }
        .detail-cell { max-width: 320px; overflow-wrap: anywhere; }
        .mini-track { display: inline-block; height: 8px; width: 100%; max-width: 320px; background: var(--gb-surface-2); border-radius: 999px; overflow: hidden; vertical-align: middle; }
        .mini-fill { display: block; height: 100%; background: var(--gb-amber); border-radius: 999px; }
        .case-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
        .picker { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
        .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--gb-ui-border); flex: 0 0 auto; display: inline-block; }
        .status-dot.on { background: var(--gb-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gb-ok) 25%, transparent); }

        .subsection-title {
            margin: 20px 0 10px; font-size: 11px; font-weight: 700;
            letter-spacing: 0.06em; text-transform: uppercase; color: var(--gb-muted);
        }
        .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 24px; }
        .settings-section .subsection-title { margin-top: 8px; }

        /* ── Banners ──────────────────────────────────────────────── */
        .update-banner {
            display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;
            padding: 12px 16px; border-radius: 10px; font-size: 13px; color: var(--gb-strong);
            background: var(--gb-tint-info); border: 1px solid var(--gb-line-info);
        }
        .update-banner.major { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); }
        .update-banner .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .eval-actions { align-items: center; }
        .eval-email { padding: 5px 9px; border: 1px solid var(--gb-ui-border); border-radius: 7px; font-size: 12.5px; min-width: 190px; background: #fff; color: #0f172a; }

        @media (prefers-reduced-motion: reduce) {
            .gbtn, .tab, .seg { transition: none; }
        }
        @media (max-width: 640px) {
            .hulo-hero { flex-wrap: wrap; }
            .hulo-hero-actions { width: 100%; justify-content: flex-end; }
            .form-select { min-width: 0; flex: 1; }
            .two-col { grid-template-columns: 1fr; }
        }

        .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 14px; }
        .kpi { background: var(--gb-surface); border: 1px solid var(--gb-line); border-radius: 12px; padding: 14px 16px; box-shadow: var(--gb-shadow-1); }
        .kpi-label { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--gb-muted); }
        .kpi-num { font-size: 24px; font-weight: 800; color: var(--gb-strong); margin-top: 4px; line-height: 1.1; }
        .kpi-sub { font-size: 12px; color: var(--gb-muted); margin-top: 4px; }
        .table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--gb-muted); padding: 8px 10px; border-bottom: 1px solid var(--gb-line); }
        .table td { padding: 9px 10px; border-bottom: 1px solid var(--gb-line-soft); vertical-align: top; color: var(--gb-strong); }
        .table td.num, .table th.num { text-align: right; white-space: nowrap; }
        .pill { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--gb-line); background: var(--gb-surface-2); color: var(--gb-strong); }
        .pill.ok, .pill.active, .pill.won { background: var(--gb-tint-ok); border-color: var(--gb-line-ok); }
        .pill.failed, .pill.lost, .pill.past_due { background: var(--gb-tint-bad); border-color: var(--gb-line-bad); color: var(--gb-danger-ink); }
        .pill.pending, .pill.open, .pill.trialing, .pill.paused { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); }
        .picker { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 18px; }
        .form-row label { display: block; font-size: 12px; font-weight: 700; color: var(--gb-muted); margin-bottom: 4px; }
        .form-row.wide { grid-column: 1 / -1; }
        .prov-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
        .prov-card { border: 1px solid var(--gb-line); border-radius: 12px; padding: 14px 16px; background: var(--gb-surface); }
        .prov-card h4 { margin: 0 0 4px; font-size: 15px; display: flex; align-items: center; gap: 8px; }
        .caps { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
        .cap { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--gb-surface-2); border: 1px solid var(--gb-line-soft); color: var(--gb-muted); }
        .cap.on { color: var(--gb-strong); border-color: var(--gb-line-ok); background: var(--gb-tint-ok); }
        .url { font-family: ui-monospace, monospace; font-size: 11.5px; word-break: break-all; color: var(--gb-strong); }
        .bar { display: flex; gap: 2px; align-items: flex-end; height: 64px; margin: 8px 0 4px; }
        .bar > div { flex: 1; background: var(--gb-amber); border-radius: 3px 3px 0 0; min-height: 2px; }
        .gb-switch { width: 40px; height: 22px; border-radius: 999px; border: 1px solid var(--gb-ui-border); background: var(--gb-surface-2); position: relative; cursor: pointer; padding: 0; }
        .gb-switch.on { background: var(--gb-amber); border-color: var(--gb-amber-edge); }
        .gb-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .12s; }
        .gb-switch.on .gb-switch-knob { left: 20px; }
        .gb-switch-group { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; }
        .code-inline { font-family: ui-monospace, monospace; font-size: 12px; background: var(--gb-surface-2); padding: 1px 6px; border-radius: 6px; }
        .connect-panel { margin-top: 12px; padding: 14px; border-radius: 10px; background: var(--gb-surface-2); border: 1px solid var(--gb-line); }
        .picker.small a { font-size: 12.5px; font-weight: 600; color: var(--gb-strong); text-decoration: underline; text-underline-offset: 2px; }
`],
})
export class HuloPaymentsComponent implements OnInit, OnDestroy {
    loading = true;
    busy = false;
    showHelp = false;
    meta: any = null;
    tab: Tab = 'overview';
    days = 30;
    dash: any = null;
    txns: any = null; txnKind = 'all'; txnStatus = 'all'; txnSearch = ''; txnPage = 1;
    kinds = ['authorize', 'capture', 'cancel', 'refund', 'dispute', 'failure', 'renewal', 'paylink'];
    subs: any = null; subStatus = 'all'; subSearch = '';
    providers: any = null; events: any[] = [];
    settingsList: any[] | null = null; cfg: any = null; cfgIdx = 0;
    linkOrder = ''; linkProvider = ''; linkHours = 72; link: any = null; links: any = null; copied = false;
    connectFor = ''; connectChannel: number = 1; connectArgs: any = {}; connectResult: any = null;

    constructor(private http: HttpClient, private notification: NotificationService, private modal: ModalService, private cdr: ChangeDetectorRef) {}

    /** Request options that authenticate against the API whether the admin UI
     *  uses cookie sessions (same origin) or bearer tokens (any origin). */
    private h(extra: { params?: any } = {}): { headers: { [k: string]: string }; withCredentials: boolean; params?: any; observe: 'body'; responseType: 'json' } {
        const headers: { [k: string]: string } = {};
        try {
            const raw = localStorage.getItem('vnd_authToken');
            const token = raw ? (raw.startsWith('"') ? JSON.parse(raw) : raw) : '';
            if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch { /* storage unavailable */ }
        return { ...extra, headers, withCredentials: true, observe: 'body', responseType: 'json' };
    }

    ngOnInit() { this.checkClaim(false); this.reloadAll(); }
    ngOnDestroy() { this.stopClaimPoll(); }

    reloadAll() { this.loadMeta(); this.loadDashboard(); this.go(this.tab); }

    loadMeta() {
        this.http.get<any>(`${API}/meta`, this.h()).subscribe({ next: m => { this.meta = m; this.loading = false; this.cdr.markForCheck(); }, error: () => { this.loading = false; this.cdr.markForCheck(); } });
    }

    go(t: Tab) {
        this.tab = t;
        if (t === 'overview') this.loadDashboard();
        if (t === 'transactions') this.loadTxns();
        if (t === 'subscriptions') this.loadSubs();
        if (t === 'paylink') this.loadLinks();
        if (t === 'providers') this.loadProviders();
        if (t === 'settings') this.loadSettings();
    }

    loadDashboard() { this.http.get<any>(`${API}/dashboard`, this.h({ params: { days: String(this.days) } })).subscribe({ next: d => { this.dash = d; this.cdr.markForCheck(); }, error: () => undefined }); }
    loadTxns() {
        const params: any = { kind: this.txnKind, status: this.txnStatus, page: String(this.txnPage) };
        if (this.txnSearch) params.q = this.txnSearch;
        this.http.get<any>(`${API}/transactions`, this.h({ params })).subscribe({ next: t => { this.txns = t; this.cdr.markForCheck(); }, error: () => undefined });
    }
    loadSubs() {
        const params: any = { status: this.subStatus };
        if (this.subSearch) params.q = this.subSearch;
        this.http.get<any>(`${API}/subscriptions`, this.h({ params })).subscribe({ next: s => { this.subs = s; this.cdr.markForCheck(); }, error: () => undefined });
    }
    loadLinks() { this.http.get<any>(`${API}/transactions`, this.h({ params: { kind: 'paylink', perPage: '20' } })).subscribe({ next: t => { this.links = t; this.cdr.markForCheck(); }, error: () => undefined }); }
    loadProviders() {
        this.http.get<any>(`${API}/providers`, this.h()).subscribe({ next: p => { this.providers = p; this.cdr.markForCheck(); }, error: () => undefined });
        this.http.get<any[]>(`${API}/events`, this.h()).subscribe({ next: e => { this.events = e; this.cdr.markForCheck(); }, error: () => undefined });
    }
    loadSettings() { this.http.get<any[]>(`${API}/settings`, this.h()).subscribe({ next: s => { this.settingsList = s; this.cfg = s[this.cfgIdx] || s[0]; this.cdr.markForCheck(); }, error: () => undefined }); }

    saveSettings() {
        this.busy = true;
        this.http.post<any>(`${API}/settings`, this.cfg, this.h()).subscribe({
            next: () => { this.busy = false; this.notification.success('Settings saved'); this.cdr.markForCheck(); },
            error: e => { this.busy = false; this.notification.error(this.errMsg(e, 'Could not save settings')); this.cdr.markForCheck(); },
        });
    }

    moveProvider(i: number, dir: number) {
        const o = this.cfg.providerOrder; const j = i + dir;
        if (j < 0 || j >= o.length) return;
        [o[i], o[j]] = [o[j], o[i]];
    }
    providerCodes(): string[] { return Object.keys(PROVIDER_NAMES); }
    providerName(code: string): string { return PROVIDER_NAMES[code] || code; }
    surcharge(code: string) { return this.cfg.surcharges[code] || { type: 'percent', value: 0, label: '' }; }
    setSurcharge(code: string, key: string, value: any) { this.cfg.surcharges = { ...this.cfg.surcharges, [code]: { ...this.surcharge(code), [key]: key === 'value' ? Number(value) || 0 : value } }; }

    subAction(s: any, action: 'pause' | 'resume') {
        this.busy = true;
        this.http.post<any>(`${API}/subscriptions/${s.id}/${action}`, {}, this.h()).subscribe({
            next: () => { this.busy = false; this.loadSubs(); this.loadDashboard(); },
            error: e => { this.busy = false; this.notification.error(this.errMsg(e, `Could not ${action}`)); this.cdr.markForCheck(); },
        });
    }
    async cancelSub(s: any) {
        const atEnd = await this.confirm('Cancel subscription', `Cancel ${s.variantName} for ${s.customerEmail}?`, 'At period end', 'primary');
        if (atEnd === null) return;
        this.busy = true;
        this.http.post<any>(`${API}/subscriptions/${s.id}/cancel`, { atPeriodEnd: atEnd }, this.h()).subscribe({
            next: () => { this.busy = false; this.notification.success(atEnd ? 'Will cancel at the end of the paid period' : 'Subscription cancelled'); this.loadSubs(); this.loadDashboard(); },
            error: e => { this.busy = false; this.notification.error(this.errMsg(e, 'Could not cancel')); this.cdr.markForCheck(); },
        });
    }
    runScheduler() {
        this.busy = true;
        this.http.post<any>(`${API}/scheduler/run`, {}, this.h()).subscribe({
            next: r => { this.busy = false; this.notification.success(`Renewals: ${r.charged} charged, ${r.failed} failed, ${r.canceled} ended`); this.loadSubs(); },
            error: e => { this.busy = false; this.notification.error(this.errMsg(e, 'Scheduler failed')); this.cdr.markForCheck(); },
        });
    }

    configuredCount(): number { return (this.dash?.providers || []).filter((p: any) => p.configured).length; }
    linkProviders(): any[] { return (this.dash?.providers || []).filter((p: any) => p.configured && p.capabilities.payByLink); }

    channelNames(ids: number[]): string {
        const chans: any[] = this.providers?.channels || [];
        return (ids || []).map(id => { const c = chans.find(x => x.id === id); return c ? (c.code === '__default_channel__' ? 'default' : c.code) : String(id); }).join(', ') || 'all';
    }
    openConnect(p: any) {
        if (this.connectFor === p.code) { this.connectFor = ''; return; }
        this.connectFor = p.code; this.connectResult = null;
        this.connectChannel = (this.providers?.channels || [])[0]?.id || 1;
        this.connectArgs = {};
        for (const f of p.connectFields || []) this.connectArgs[f.name] = f.defaultValue || '';
    }
    testConnect(p: any) {
        this.busy = true; this.connectResult = null;
        this.http.post<any>(`${API}/connect/${p.code}/test`, { args: this.connectArgs }, this.h()).subscribe({
            next: r => { this.busy = false; this.connectResult = r; this.cdr.markForCheck(); },
            error: e => { this.busy = false; this.connectResult = { ok: false, message: this.errMsg(e, 'Could not reach the provider') }; this.cdr.markForCheck(); },
        });
    }
    connect(p: any) {
        this.busy = true; this.connectResult = null;
        this.http.post<any>(`${API}/connect/${p.code}`, { channelId: this.connectChannel, args: this.connectArgs }, this.h()).subscribe({
            next: r => { this.busy = false; this.connectResult = r; this.notification.success(`${p.name} connected`); this.loadProviders(); this.loadDashboard(); this.cdr.markForCheck(); },
            error: e => { this.busy = false; this.connectResult = { ok: false, message: e?.error?.message || this.errMsg(e, 'Connect failed') }; this.cdr.markForCheck(); },
        });
    }
    createLink() {
        this.busy = true; this.link = null; this.copied = false;
        this.http.post<any>(`${API}/pay-link`, { orderCode: this.linkOrder.trim(), methodCode: this.linkProvider || undefined, expiresInHours: this.linkHours }, this.h()).subscribe({
            next: r => { this.busy = false; this.link = r; this.loadLinks(); this.cdr.markForCheck(); },
            error: e => { this.busy = false; this.notification.error(this.errMsg(e, 'Could not create the link')); this.cdr.markForCheck(); },
        });
    }
    copy(text: string) { navigator.clipboard?.writeText(text).then(() => { this.copied = true; this.cdr.markForCheck(); setTimeout(() => { this.copied = false; this.cdr.markForCheck(); }, 2000); }); }

    mainCurrency(): string { const c = Object.keys(this.dash?.subscriptions?.mrr || {})[0]; return c || 'GBP'; }
    mrrLabel(): string { const m = this.dash?.subscriptions?.mrr || {}; const keys = Object.keys(m); return keys.length ? keys.map(k => this.money(m[k], k)).join(' + ') : '—'; }
    providerStat(code: string, key: string): number { const r = (this.dash?.ledger?.byProvider || []).find((x: any) => x.provider === code); return Number(r?.[key] || 0); }
    dayBars(): Array<{ day: string; volume: number; pct: number }> {
        const rows: any[] = this.dash?.ledger?.byDay || [];
        const byDay = new Map<string, number>();
        for (const r of rows) { const d = String(r.day).slice(0, 10); byDay.set(d, (byDay.get(d) || 0) + Number(r.volume || 0)); }
        const max = Math.max(1, ...byDay.values());
        return [...byDay.entries()].map(([day, volume]) => ({ day, volume, pct: Math.max(3, Math.round(volume / max * 100)) }));
    }

    private confirm(title: string, body: string, okLabel: string, style: 'primary' | 'danger'): Promise<boolean | null> {
        return new Promise(resolve => {
            this.modal.dialog({ title, body, buttons: [{ type: 'secondary', label: 'Back' }, { type: 'danger', label: 'Cancel now', returnValue: false }, { type: style, label: okLabel, returnValue: true }] })
                .subscribe({ next: v => resolve(v === undefined ? null : !!v), error: () => resolve(null) });
        });
    }

    private errMsg(e: any, fallback: string): string { return e?.error?.message || e?.error?.error || e?.message || fallback; }

    money(minor: number | null | undefined, currency?: string | null): string {
        if (minor == null || isNaN(Number(minor))) return '—';
        try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'GBP').toUpperCase() }).format(Number(minor) / 100); }
        catch { return `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`; }
    }
    relative(iso: string): string {
        if (!iso) return '—';
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
        if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
        if (diff < 7 * 86400) return `${Math.round(diff / 86400)} d ago`;
        return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }

    // ── Licence & billing (same flow as every HULO plugin) ───────────

    licenceKeyInput = '';
    activating = false;
    buyPlan: 'monthly' | 'annual' | 'lifetime' = 'monthly';
    buying = false;
    claim: any = null;
    portalOpening = false;
    private claimTimer: any = null;

    buyLicence() {
        this.buying = true;
        this.http.post<any>(`${API}/licence/purchase-link`, { plan: this.buyPlan }, this.h()).subscribe({
            next: r => {
                this.buying = false;
                if (r?.url) {
                    window.open(r.url, '_blank', 'noopener');
                    this.claim = { state: 'pending' };
                    this.startClaimPoll();
                }
                this.cdr.markForCheck();
            },
            error: e => { this.buying = false; this.notification.error(this.errMsg(e, 'Could not start checkout — try again shortly')); this.cdr.markForCheck(); },
        });
    }

    buyLifetime() { this.buyPlan = 'lifetime'; this.buyLicence(); }

    checkClaim(force = false) {
        this.http.get<any>(`${API}/licence/claim-status` + (force ? '?check=1' : ''), this.h()).subscribe({
            next: r => {
                const wasPending = this.claim?.state === 'pending';
                this.claim = r;
                if (r?.state === 'pending') { if (!this.claimTimer) this.startClaimPoll(); }
                else this.stopClaimPoll();
                if (r?.licensed && (wasPending || r?.state === 'installed') && !this.meta?.licensed) {
                    this.notification.success('Licence installed — all features enabled');
                    this.loadMeta();
                }
                this.cdr.markForCheck();
            },
            error: () => undefined,
        });
    }

    private startClaimPoll() { this.stopClaimPoll(); this.claimTimer = setInterval(() => this.checkClaim(false), 15000); }
    private stopClaimPoll() { if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; } }

    licenceLabel(): string {
        const l: any = this.meta?.licence;
        if (!l) return 'active licence';
        const d = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        if (l.master) return 'master licence — covers every HULO plugin on this server';
        if (l.plan === 'lifetime') return 'lifetime licence — never expires, every update included';
        if (l.trialEndsAt && new Date(l.trialEndsAt).getTime() > Date.now()) {
            return `free trial on the ${l.plan} plan — first charge on ${d(l.trialEndsAt)}; cancel any time before then via Manage billing`;
        }
        return `${l.plan} subscription — renews automatically${l.expiresAt ? ' (current key valid until ' + d(l.expiresAt) + ')' : ''}`;
    }

    openPortal() {
        this.portalOpening = true;
        this.http.post<any>(`${API}/licence/portal-link`, {}, this.h()).subscribe({
            next: r => { this.portalOpening = false; if (r?.url) window.open(r.url, '_blank', 'noopener'); this.cdr.markForCheck(); },
            error: e => { this.portalOpening = false; this.notification.error(this.errMsg(e, 'Could not open the billing portal')); this.cdr.markForCheck(); },
        });
    }

    activateLicence() {
        const key = (this.licenceKeyInput || '').trim();
        if (!key) return;
        this.activating = true;
        this.http.post<any>(`${API}/licence/activate`, { key }, this.h()).subscribe({
            next: r => {
                this.activating = false;
                this.licenceKeyInput = '';
                this.notification.success(r?.message || 'Licence activated — all features enabled');
                this.loadMeta();
                this.cdr.markForCheck();
            },
            error: e => {
                this.activating = false;
                this.notification.error(this.errMsg(e, 'That key did not validate — check it was copied completely'));
                this.cdr.markForCheck();
            },
        });
    }

    updateAvailable(): boolean {
        const u = this.meta?.update;
        return !!(u && u.latest && u.updateAvailable !== false && u.latest !== this.meta?.version);
    }


}
