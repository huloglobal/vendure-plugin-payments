# Changelog

All notable changes to `@huloglobal/vendure-plugin-payments` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.9] — 2026-09-28

Follow-up to the 0.2.8 audit — no new features. One column type change on
`hulo_hosted_session` is applied on boot; nothing else to migrate.

### Added
- **Content-Security-Policy on the hosted page.** A per-request nonce on
  the page's inline script and a policy listing every provider client host
  (Stripe, Adyen via jsDelivr, PayPal, Square, Braintree) for `script-src`,
  `frame-src` and `connect-src`, with `img-src * data:`, `style-src 'self'
  'unsafe-inline'`, `frame-ancestors 'none'`, `base-uri 'none'`,
  `form-action 'self'`. New plugin option `hostedCsp: 'enforce' |
  'report-only' | 'off'` (default `'report-only'`: the policy is sent as
  `Content-Security-Policy-Report-Only` and violations posted to the new
  `POST /hulo-payments/csp-report` route are logged, rate-limited, tokens
  masked). The Stripe hosted flow was verified under `'enforce'` in a real
  browser (Payment Element mounted, session created, zero violations).
- **Postgres corpus test** (`src/pg-corpus.test.ts`, runs when
  `HULO_PG_URL` is set): every SQL statement in `src/**` is translated by
  the licence-sdk adapter and prepared against a scratch PostgreSQL 17 with
  quoted-camelCase stand-ins for the Vendure tables the plugin reads.
  66 statements pass.

### Changed
- Unit test files are no longer compiled into `dist` (they were published
  with the package before).

### Fixed
- **Adyen pay-by-link never recorded a payment.** `confirmPayment` insisted
  on a Drop-in `sessionId` + `sessionResult`, which a payment link does not
  have. The AUTHORISATION / CAPTURE notification now confirms the payment
  (Authorized or Settled per the event, `transactionId` = pspReference,
  amount and currency checked against the order). The facts are registered
  by the webhook path and consumed once by the handler, so a storefront
  cannot forge a `pspReference` through `addPaymentToOrder`.
- **Adyen manual capture from the order page** could not re-check the
  session: `sessionResult` is now kept in the payment metadata.
- **Webhook settle mark** (`markSettledByWebhook`) is a map with a 60 s
  TTL and is cleared in a `finally` around `settlePayment`, so a failed
  settle can no longer leave a stale "trust me" entry for that payment.
- **Renewals counted twice in the ledger.** Stripe renewal intents are
  stamped `huloRenewal` and their `payment_intent.*` events ignored; Adyen
  notifications whose merchant reference is a scheduler reference
  (`<order>-R<yyyymmdd>-<variant>-a<n>`) are ignored. The scheduler's
  `renewal` row is the only one.
- **Refund webhooks settled the wrong refund.** `refund.settled` now
  targets the Vendure refund by the provider's refund id (Stripe `re_…` from
  `charge.refunded`'s refund list or the new `refund.updated` /
  `charge.refund.updated` handling, Adyen's REFUND pspReference), then by
  exact amount, then the only pending one — never "the first pending refund"
  when several are open. A refund already settled from the handler is not
  written to the ledger a second time.
- **Adyen sessions** now include a "Shipping & fees" line for
  `amount − Σ lines` (Klarna / Afterpay reject sessions whose lines do not
  sum to the amount).
- **Hosted page GET froze carts.** Opening the link moved the order to
  `ArrangingPayment`, so link previews and crawlers locked baskets. The GET
  is read-only (an `AddingItems` order still lists its providers); the
  transition happens in `POST …/session`, before the provider session is
  created.
- **Mollie `cancelSubscription`** uses the stored customer reference instead
  of listing up to 250 subscriptions to find it; the provider contract
  gained an optional `providerCustomerRef` argument.
- **UUID id strategy.** `hulo_hosted_session.orderId` was `INT`; it is now
  `VARCHAR(36)` (widened on boot with a guarded `ALTER`, MariaDB/MySQL and
  Postgres) and compared as text.

## [0.2.8] — 2026-09-28

Reliability and security pass — no new features. Two columns on
`hulo_hosted_session`, a unique key on `hulo_subscription`, one index on
`hulo_payment_txn` and a best-effort index on Vendure's `payment` table are
added on boot; nothing to migrate.

### Fixed
- **Webhook-created payments.** Payments recorded from a webhook (pay-by-link
  completion, a redirect-flow `payment.settled` arriving before the customer
  returns) called `addPaymentToOrder` outside a transaction, which Vendure
  3.7 rejects; the event was then marked processed and lost. Every webhook is
  now applied inside one transaction with the order row locked, in the
  order's own channel with that channel's method code.
- **Duplicate payments.** A webhook racing the customer's own completion (or
  Stripe's `checkout.session.completed` + `payment_intent.succeeded` pair)
  can no longer record two payments: both paths lock the order and skip a
  reference that is already on a live payment. The hosted `/complete` route
  also holds a one-minute lease on the session row so a double submit is
  answered from the order's state.
- **Payment matching** ignores Declined/Cancelled/Error payments, so an
  Adyen decline-then-retry settles the retry instead of the failure.
- **Webhook redelivery.** A processing error now releases the idempotency
  claim and answers 5xx, so the provider redelivers instead of the paid
  event being lost.
- **Subscription double charge.** Due renewals are claimed with a
  conditional `UPDATE` before the provider is called (the hourly cron and
  the admin "run now" run in different processes); the charge reference
  includes the attempt number so a retry never replays a cached refusal.
  Subscription rows are claimed with a pending row + unique key before the
  provider subscription is created (the bus fires for PaymentAuthorized and
  PaymentSettled seconds apart). Monthly and yearly periods are calendar
  arithmetic instead of 30/365 days. The plugin registers `ScheduleModule`
  itself, so renewals run on hosts that never wired it; `disableScheduler`
  is honoured.
- **Hosted checkout page.** Values embedded in the page script are
  serialised so they can never close the script block; `returnUrl` and
  `cancelUrl` must be absolute http(s) URLs (optionally restricted with the
  new `hostedReturnHosts` option); `methodCode` and `locale` are validated;
  client metadata is allow-listed and server-side session ids win; provider
  and Vendure error text no longer reaches the customer; clickjacking and
  referrer headers are set; each link allows at most 30 provider sessions;
  expiry is stored as a date (no UTC/local drift); expired rows are purged.
- **Postgres.** Raw queries on Vendure tables quote their camelCase columns
  (`channelId`, `paymentMethodId`, `transactionId`, `orderId`); the
  subscription updater no longer quotes the plugin's own columns; the
  channel lookup goes through the dialect adapter. Payment methods were
  silently absent on Postgres before.
- **Handler args.** Numeric strings with leading zeros (UK account numbers,
  sort codes) stay strings instead of being converted to numbers.
- **Stripe pay-by-link** uses one line for the order total so the intent
  equals `order.totalWithTax` and the webhook accepts it; **GoCardless
  refunds** send the required `total_amount_confirmation`; refund
  idempotency keys are per minute, not per second.
- **Permissions and scoping.** Self-update and licence activate/deactivate
  need SuperAdmin; admins in a non-default channel only see and act on that
  channel's ledger, settings, methods and connections; settings, pay-link
  return URLs, days and e-mails are validated; short secrets are fully
  redacted; the licence lead request times out after 8 s.
- Ops alerts never hold a webhook response (dispute alerts are
  fire-and-forget), use one pooled SMTP transport with timeouts and log
  non-2xx replies. `ALTER TABLE … IF NOT EXISTS` is replaced by an
  information-schema check (MySQL 8 boots again).

### Changed
- Admin UI: OnPush change detection, `trackBy` on every table, daily bars
  computed once per load, tab switches keep loaded data (Refresh reloads),
  every provider named in Transactions/Subscriptions/Routing and available
  in the Surcharges table, the providers cache expires after 60 s and is
  cleared after Connect, the pay-by-link capability chip reads the right
  key, the method panel shows the method being edited, and the action-bar
  button needs only ReadOrder.
- `hulo_payment_event` rows older than 180 days and expired hosted sessions
  older than 7 days are purged.

## [0.2.7] — 2026-09-25

### Fixed
- Payments → Payment methods tab: every channel cell stacks its status chip and buttons left-aligned with the same widths, columns are fixed-width and rows vertically centred, so nothing drifts out of line on multi-channel installs.

## [0.2.6] — 2026-09-25

### Fixed
- Settings → Payment methods: the status chips sit in their own fixed column (mark · status · name), so they line up down the page whatever the method name length; the Payment methods tab's status chips and buttons share fixed widths for the same reason.

## [0.2.5] — 2026-09-25

### Fixed
- **Sharing a Stripe account with Vendure's own Stripe plugin no longer produces webhook errors.** Events for PaymentIntents the plugin did not create (they lack its `vendureOrderId` stamp) are acknowledged and ignored instead of being applied to the order; the plugin never adds a payment to an order that already carries another method's payment.
- A configured but disabled method still answers its webhook endpoint with 200 after verifying the signature, so the provider does not mark the endpoint as failing while the method is switched off.
- Enabling, disabling or editing a payment method in Settings takes effect immediately (the plugin's method cache is cleared on the Vendure event) instead of after up to 30 seconds.

## [0.2.4] — 2026-09-23

### Added
- **Payment methods tab** on the Payments page: every provider for every channel in one table, one status word per cell (Not added / Not set up / Ready, disabled / Test mode / Live). **Add** creates the payment method on that channel — disabled, no keys, with a descriptive name such as "Adyen · cards, wallets & 100+ local methods" — so it is visible under Settings → Payment methods straight away; **Connect** opens the Connect panel for that channel. "Add every missing method" fills the whole table in one click. The button on Settings → Payment methods now opens this tab.
- `POST /hulo-payments/methods { provider, channelId }` behind it (admin, CreatePaymentMethod), idempotent per provider and channel.

## [0.2.3] — 2026-09-23

### Added
- `huloHostedCheckout(methodCode)`: the storefront can preselect one of the enabled methods, so a "Pay with PayPal" button opens the hosted page straight on PayPal. Without it the page opens on the first method in the channel's order, as before.

## [0.2.2] — 2026-09-23

### Changed
- **Settings → Payment methods reads at a glance.** The Name column of the list now shows, for every HULO method, a brand mark, the name, one status word (Live / Test mode / Ready, disabled / Not set up) and the first line of the description — so twenty methods scan in seconds without opening each one. Other plugins' methods are untouched.
- **Providers tab regrouped.** Providers are listed under four plain headings — Cards & wallets; PayPal, bank & local methods; Crypto; Offline & on account — as compact rows (mark, name, what customers can pay with, one status word). A row expands to the details, dashboard links, its payment methods and the Connect panel; nothing else is on screen until you ask for it.

## [0.2.1] — 2026-09-23

### Added
- **Settings → Payment methods explains itself.** Any payment method that uses a HULO handler now shows a panel under the form: what the provider is, what customers can pay with, what the method supports (holds, refunds, subscriptions, saved cards, pay-by-link), where the keys come from with links to the provider dashboard, a **Test these keys** button that checks the unsaved form values, the webhook URL with a copy button and a saved/not-saved status, and the go-live checklist. Offline methods (bank transfer, pay later) get a plain-language "how it works" instead of keys and webhooks.
- **Connect a payment provider** button on the payment-methods list, opening the Payments page on the Providers tab. The Payments page accepts `?tab=` and `?connect=<provider>` deep links.

## [0.2.0] — 2026-09-22

### Added
- **Hosted checkout page.** `huloHostedCheckout(returnUrl)` returns a URL the storefront redirects to; the page shows every enabled method in the channel's preferred order, drives each provider's own client (Stripe Payment Element, Adyen Drop-in, PayPal buttons, Square Web Payments, Braintree Drop-in, hosted redirects, bank-transfer instructions), records the payment and sends the customer back with `?order=&result=`. No provider code in the storefront. Branding (name, colour, logo) per channel in Settings.
- **Seven more payment systems**, all behind the same contract: Square (cards, Apple Pay, Google Pay, Cash App Pay, Afterpay; holds, refunds, payment links, signed webhooks), Braintree (cards, PayPal, Venmo, wallets; holds, refunds), GoCardless (Bacs, SEPA, ACH direct debit, Instant Bank Pay; native subscriptions), Checkout.com (hosted payments page; holds, refunds, disputes, payment links, workflow webhooks), Coinbase Commerce (crypto), bank transfer and pay-later / invoice (offline methods settled from the order page, free tier).
- **Get-started wizard** on the Payments page until the first provider is connected; Connect works for every provider, including automatic webhook setup for Square and Checkout.com.

## [0.1.0] — 2026-09-21

### Added
- **Four providers, one contract.** Stripe (Payment Intents + Payment Element), Adyen (Sessions + Drop-in), PayPal (Orders v2) and Mollie (Payments API) as Vendure payment method handlers with server-side verification of amount, currency and order code.
- **Capture control and refunds.** Automatic or manual capture per method, partial capture, cancel, full and partial refunds through Vendure's refund flow.
- **Signed, idempotent webhooks** per provider at `/hulo-payments/webhook/<provider>`, updating payments, refunds and subscriptions; disputes recorded and alerted.
- **Saved cards** (Stripe Customers, Adyen stored methods) with shop-API listing and removal.
- **Subscriptions** from product-variant custom fields: native billing on Stripe, PayPal and Mollie, scheduler-billed renewals for Adyen, dunning, MRR, customer self-service.
- **Pay by link** for any unpaid order from the admin (Stripe Checkout, Adyen Pay by Link, PayPal approve links, Mollie Payment Links).
- **Routing and rules.** Provider order per channel with fallback, the `hulo-payment-rules` eligibility checker, optional surcharges.
- **One-step Connect** on every provider card: verifies the keys with the provider, creates the webhook through the provider's API (Stripe, PayPal, Adyen Management API) and stores its secret, then creates the Vendure payment method — with links straight into each provider's dashboard, API keys and webhook pages.
- **Ledger and dashboard** under Sales → Payments: volume by provider and day, success rate, refunds, disputes, subscriptions, webhook log, settings, licence card.
