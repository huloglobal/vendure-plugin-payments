<p align="center"><a href="https://huloglobal.com/vendure-plugins/payments/"><img src="https://huloglobal.com/vendure-plugins/logos/payments.svg?v=2" width="96" height="96" alt="HULO Payments logo"></a></p>

# @huloglobal/vendure-plugin-payments

[![npm](https://img.shields.io/npm/v/@huloglobal/vendure-plugin-payments)](https://www.npmjs.com/package/@huloglobal/vendure-plugin-payments)
[![Vendure](https://img.shields.io/badge/Vendure-%3E%3D3.5%20%3C4-1d4ed8)](https://vendure.io)

One payments plugin for [Vendure](https://www.vendure.io/). **Stripe, Adyen,
PayPal, Mollie, Square, Braintree, GoCardless, Checkout.com, Coinbase
Commerce, bank transfer and pay-later** behind a single contract, so every
provider gets the same features and every payment lands in the same ledger:

- **Hosted checkout page** — one mutation and a redirect; the plugin's own
  page shows every enabled method, drives each provider's client and brings
  the customer back paid. Nothing provider-specific in your storefront.

- **Hosted / embedded sessions** — Stripe Payment Element, Adyen Drop-in,
  PayPal buttons, Mollie hosted checkout; cards, Apple Pay, Google Pay,
  Link, iDEAL, Klarna, Bancontact, SEPA and whatever the provider enables.
  3-D Secure / SCA handled by the provider.
- **Server-side verification** — the storefront never decides a payment
  state; the plugin re-reads the intent / session / order from the provider
  and checks amount, currency and order code before `addPaymentToOrder`.
- **Capture control** — automatic or manual capture per method, partial
  captures, cancels, full and partial refunds from the normal Vendure
  refund flow.
- **Signed, idempotent webhooks** — Stripe signatures, Adyen HMAC (+ basic
  auth), PayPal signature verification, Mollie fetch-back. Duplicate
  deliveries are ignored; results update Vendure payments and refunds.
- **Disputes** — chargebacks reported by Stripe, Adyen, PayPal, Mollie,
  Square, Checkout.com and GoCardless land in the ledger and alert ops
  (Braintree, Coinbase Commerce, bank transfer and pay later report none).
- **Dashboard-refund reconciliation** — a refund made in the provider's own
  dashboard becomes a settled Vendure refund on the order's payment, once,
  with an order-history note; never more than is left to refund, and never
  counted twice with a refund made from the order page. Per channel, off
  until you turn it on (Settings → Routing).
- **Saved cards** — Stripe Customers and Adyen stored payment methods for
  signed-in customers; list and remove from the shop API.
- **Subscriptions** — mark any product variant as billed daily / weekly /
  monthly / yearly (with a trial); the order charges the first period,
  then Stripe, PayPal and Mollie bill natively and Adyen renewals are
  charged by the plugin's scheduler from the stored card. Customers see and
  cancel their subscriptions through the shop API; admins pause, resume,
  cancel and see MRR.
- **Pay links** — one click in the admin (or one service call from another
  plugin) creates a link for any unpaid order (draft orders, accepted quotes,
  phone orders): this shop's own hosted payment page, or a provider-hosted
  link. See [Pay links](#pay-links).
- **Routing, rules and surcharges** — provider order per channel, fallback
  to the next provider after a decline, an eligibility checker (amount band,
  currencies, countries, customer groups, signed-in only) usable on any
  payment method, and optional per-provider surcharges.
- **Rate limits** — per-IP limits on the public routes (hosted page,
  webhooks, CSP reports); see `rateLimits`.
- **Ledger + dashboard** — authorisations, captures, refunds, disputes,
  failures, renewals and pay-links by provider and day, success rate,
  webhook deliveries, subscriptions, settings — under **Sales → Payments**.

Works on MySQL, MariaDB and PostgreSQL. No provider SDKs: each provider is
a few REST calls on the platform `fetch`.

## In the admin

- **Payments** (Sales → Payments): a set-up checklist (licensed), dashboard, a **Payment methods** tab (every provider × every channel, Add / Connect per cell), transactions, subscriptions, pay links, the Providers tab with one-step Connect, and Settings (routing, fallback, refund reconciliation, surcharges, hosted page, operations, weekly report).
- **Dashboard → Add widget → Payments**: last 7 days' takings, settled payments and disputes on the Admin home page.
- **Settings → Payment methods**: a **Connect a payment provider** button; every HULO method in the list shows a brand mark, one status word (Live / Test mode / Ready, disabled / Not set up) and the first line of its description; and under each method a panel that explains the provider, lists what customers can pay with, tests the keys you typed, shows the webhook URL to paste and whether its secret is saved, and walks through going live.

## Install

```bash
yarn add @huloglobal/vendure-plugin-payments
```

```ts
// vendure-config.ts
import { HuloPaymentsPlugin } from '@huloglobal/vendure-plugin-payments';

plugins: [
  HuloPaymentsPlugin.init({
    publicBaseUrl: 'https://shop.example.com',        // webhook + return URLs
    licenceKey: process.env.HULO_LICENCE_KEY_PAYMENTS, // optional — or activate in the admin
    ops: { email: 'ops@example.com', webhookUrl: process.env.OPS_SLACK_WEBHOOK },
    email: { accentColor: '#155dfc', logoUrl: 'https://shop.example.com/logo.png', footerText: 'Example Ltd, registered in England 01234567' }, // optional look of the alert e-mails
    hostedReturnHosts: ['shop.example.com'],          // optional: hosts the hosted checkout may return to
    hostedCsp: 'report-only',                         // optional: Content-Security-Policy on the hosted page ('enforce' | 'report-only' | 'off')
    rateLimits: { hostedPage: 120, hostedAction: 40, webhook: 1200, cspReport: 60 }, // optional, per minute per IP; false = off
  }),
  AdminUiPlugin.init({
    app: compileUiExtensions({ extensions: [HuloPaymentsPlugin.uiExtensions /* … */] }),
  }),
]
```

Then open **Sales → Payments → Providers** and click **Connect** on a
provider: paste the keys from its dashboard (linked from the card), click
*Test connection* to see which account they belong to, then *Connect*. The
plugin verifies the keys with the provider, registers the webhook itself
(Stripe, PayPal, and Adyen when the credential has the Management API
webhook role), stores the signing secret, and creates the Vendure payment
method on the channel you chose — nothing to copy back by hand. Mollie
needs no webhook setup at all.

Prefer the standard route? **Settings → Payment methods → Create** and pick
the handler *HULO Payments — Stripe / Adyen / PayPal / Mollie*; every field
explains where to find its value. Tables are created on boot; the only
migration is Vendure's own for the three subscription custom fields on
`ProductVariant` (`npx vendure migrate` on installs that use migrations).
Hosts on Vendure's UUID id strategy are supported: `hulo_hosted_session.orderId`
is text (installs from before 0.2.9 are widened on boot; if that ALTER is
refused the log names the statement to run by hand).

## Storefront

The simplest integration is the hosted page:

```graphql
mutation { huloHostedCheckout(returnUrl: "https://shop.example.com/checkout/return", cancelUrl: "https://shop.example.com/checkout", methodCode: "paypal") { url expiresAt } }
# methodCode is optional: it preselects that method on the page (one button per provider in your checkout).
# → redirect the customer to `url`; they return to returnUrl?order=CODE&result=paid|pending
```

Opening the link is read-only: crawlers and chat link-previews fetching it
leave the basket editable. The order enters `ArrangingPayment` when the
customer picks a method (the page's first `/session` call).

**Content-Security-Policy.** The page carries a CSP that allows its own
script by a per-request nonce and every provider client by host (Stripe,
Adyen via jsDelivr, PayPal, Square, Braintree), with `frame-ancestors
'none'`, `base-uri 'none'` and `form-action 'self'`. `hostedCsp` picks the
mode: `'report-only'` (default) sends `Content-Security-Policy-Report-Only`
and logs what a browser *would* have blocked (browsers post reports to
`POST /hulo-payments/csp-report`, answered 204, logged at most 20 times a
minute with page tokens masked); `'enforce'` blocks it; `'off'` keeps only
the frame-ancestors / base-uri policy. Run report-only for a while, and once
the server log shows no `hosted page CSP` warnings for the providers you
offer, switch to `'enforce'`. The Stripe flow is verified under `'enforce'`
on every release; a provider that loads a host not on the list would show
up in report-only mode first.

**Rate limits.** The public routes are limited per client IP and per
minute: the hosted page `GET` (120), its `/session` and `/complete` calls
(40), provider webhooks under `/hulo-payments/webhook/<provider>` (1200)
and CSP reports (60). Over the limit the answer is `429` with
`Retry-After` (providers retry webhooks later). The client IP is the TCP
peer; when the peer is a private address (a reverse proxy on the same host
or LAN) it is what the proxy reports: `CF-Connecting-IP`, else the
right-most public `X-Forwarded-For` entry, else `X-Real-IP`. Change the
numbers with `rateLimits`, or pass `rateLimits: false` when a proxy in
front already limits.

**Fallback after a decline (licensed).** With Settings → Routing → *Fall
back to the next provider on decline* on, a failed payment on the hosted
page answers with the other methods, next in the routing order first; the
page moves the failed method to the end and highlights the next one. For
your own checkout, call `huloPaymentProviders(failedMethodCode: "stripe")`
after a decline: the failed method comes last and the next one is
`preferred`. Nothing is charged automatically; the customer still chooses.
Unlicensed, or with the switch off, the list stays in routing order.

For an embedded checkout, drive the providers yourself:

```graphql
# 1. What to offer (preferred first, with public keys and capabilities)
query { huloPaymentProviders { methodCode provider name publicConfig capabilities surcharge preferred } }

# 2. A session for the active order
mutation { huloCreatePaymentSession(methodCode: "stripe", options: { returnUrl: "https://shop.example.com/checkout/return", savePaymentMethod: true }) {
  provider clientSecret sessionId sessionData checkoutUrl publicKey environment config amount currency } }

# 3. After the provider's client reports success, the normal Vendure step:
mutation { addPaymentToOrder(input: { method: "stripe", metadata: { paymentIntentId: "pi_…" } }) { ... on Order { id state } ... on ErrorResult { errorCode message } } }
```

| Provider | Client library | `metadata` for `addPaymentToOrder` |
| --- | --- | --- |
| Stripe | `@stripe/stripe-js` Payment Element with `clientSecret` | `{ paymentIntentId }` |
| Adyen | `@adyen/adyen-web` Drop-in with `sessionId` + `sessionData`, `clientKey`, `environment` | `{ sessionId, sessionResult }` from `onPaymentCompleted` |
| PayPal | `@paypal/paypal-js` buttons with `createOrder: () => sessionId` | `{ paypalOrderId }` |
| Mollie | redirect to `checkoutUrl`; on return | `{ molliePaymentId }` (the `sessionId`) |
| Square | Web Payments SDK with `config.applicationId` / `locationId` | `{ sourceId }` (the card token) |
| Braintree | Drop-in with `clientSecret` as the authorization | `{ nonce, deviceData }` |
| GoCardless | redirect to `checkoutUrl`; on return | `{ billingRequestId }` (the `sessionId`) |
| Checkout.com | redirect to `checkoutUrl`; on return | `{ sessionId }` |
| Coinbase Commerce | redirect to `checkoutUrl`; on return | `{ chargeCode }` (the `sessionId`) |
| Bank transfer / pay later | show `instructions` | `{}` |

Also available: `huloSavedPaymentMethods`, `huloRemoveSavedPaymentMethod`,
`huloMySubscriptions`, `huloCancelSubscription(id, atPeriodEnd)`,
`huloApplyPaymentSurcharge(methodCode)`.

## Pay links

Free. **Sales → Payments → Pay by link**: enter an order code and choose
*This shop's payment page* (the hosted page for that order, offering every
method enabled on its channel, bank transfer and pay later included) or *A
provider's payment page* (Stripe Checkout, Adyen, PayPal, Mollie, Square,
Checkout.com or Coinbase Commerce; providers other than Stripe need a
licence). Links last 1 hour to 30 days (default 3 days). A hosted link is
paid exactly like a checkout; a provider link is settled by the provider's
webhook. Each link is a `paylink` row in the ledger, `pending` until paid.

Admin REST (needs `UpdateOrder`; `ReadOrder` to list):

```http
POST /hulo-payments/pay-link   { "orderCode": "…", "mode": "hosted" | "provider", "methodCode": "stripe", "expiresInHours": 72, "returnUrl": "https://…" }
GET  /hulo-payments/pay-links?orderCode=…
```

Without `mode`, a request with a `methodCode` makes a provider link and one
without makes a hosted link.

**Service API (for other plugins).** `PayLinkService` is the stable
entry point (`HuloPayLinkService` is an alias of the same class); HULO
Quotations uses it for "Pay now", deposits and balances on accepted quotes.
Resolve it across plugin modules with Nest's `ModuleRef`. The simplest call:

```ts
import { PayLinkService, PayLinkError } from '@huloglobal/vendure-plugin-payments';

const payLinks = this.moduleRef.get(PayLinkService, { strict: false });
const { url, ref } = await payLinks.createPayLink(ctx, {
  orderCode: order.code,
  amount: 25000,               // optional, minor units: a deposit or balance instead of the whole order
  currency: 'GBP',             // must be the order's currency
  description: 'Deposit for quote Q-1042',
  customerEmail: 'buyer@example.com', // optional, default the order's customer
  returnUrl: 'https://shop.example.com/quote/thanks', // optional, https
  expiresInHours: 168,         // optional, 1–720, default 72
  reference: 'Q-1042',         // optional: ledger row + `reference` metadata on the payment
  metadata: { quotation: 'Q-1042' }, // optional, at most 10 string keys
});
```

Without `amount` the link is this shop's hosted page for what is left to
pay (every enabled method). With `amount` below what is left, it is a
**Stripe** link for that amount (free; needs an enabled Stripe method on
the order's channel): paying it adds a **partial payment** to the order,
which stays in `ArrangingPayment` until its settled payments cover the
total, then moves to `PaymentSettled` — a deposit and then a balance are two
links, two payments. `amount` may not exceed what is left to pay (the total
less settled and authorised payments), so a balance can never over-pay.

The fuller form, with the link details in the result:

```ts
const link = await payLinks.create(ctx, {
  orderCode: order.code,          // or orderId
  mode: 'hosted',                 // default; or 'provider' (+ methodCode)
  expiresInHours: 168,            // 1–720, default 72
  returnUrl: 'https://shop.example.com/quote/thanks', // https only; default <publicBaseUrl>/checkout/confirmation/<code>
  locale: 'en-GB',                // hosted page language
  createdBy: 'quotation:Q-1042',  // kept on the ledger row
  amount: 25000,                  // optional part payment (forces a Stripe link)
});
// → { url, ref, expiresAt, mode, provider, orderCode, amount, currency }
const issued = await payLinks.listForOrder(order.code);
// → [{ id, provider, mode, status: 'pending' | 'ok' | 'failed', amount, currency, ref, url, expiresAt, createdAt }]
```

`create` and `createPayLink` throw `PayLinkError` with a `code`: `invalid-input`,
`order-not-found`, `order-not-payable` (paid, shipped, cancelled or zero
total), `no-provider`, `licence-required` or `provider-error`. The order
must be in a state that can move to `ArrangingPayment` when the customer
pays (`Draft`, `AddingItems` with a customer and shipping method, or
`ArrangingPayment`). These two methods, their inputs and their results
keep their shape across minor versions.

## Subscriptions

Set **Subscription billing interval** (and optionally *every N intervals*
and *free trial days*) on a product variant. Its price is the price per
period. When an order containing it is paid through a HULO method the
plugin creates the subscription with the provider (or schedules it itself
for Adyen), records renewals in the ledger, alerts on failed renewals and
cancels after the configured number of failed daily attempts. PayPal
subscriptions need one customer approval; the approval link is exposed on
`huloMySubscriptions` and in the admin. Renewal periods are calendar months
and years (a monthly plan bills on the same day each month). The renewal
scheduler runs hourly on the worker; the plugin registers Nest's
`ScheduleModule` itself, so no host wiring is needed. Set
`disableScheduler: true` to run it elsewhere.

## Weekly report, setup checklist and dashboard widget

The weekly report and the set-up checklist are licensed (or evaluation)
features. On the free tier the checklist is not shown, nothing is mailed
and *Send me a test* answers 402; the report's settings are kept and it
resumes when a licence is activated.

**Set-up checklist.** The top of the Payments page lists what is still to
do, each item checked against the real state of the install: a provider
connected, a method enabled on a channel, `hostedReturnHosts` set, an ops
email, every connected provider's webhook secret saved, and a first payment
in the ledger. "Hide" puts it away until something that was done comes
undone; it disappears for good once everything is done.

**Weekly report.** Every **Monday at 08:00 (server-local time)** the plugin
emails what it did last week — payments settled and their value, refunds,
disputes opened, active subscriptions and MRR, pay-by-link takings and
failed renewals it went on to recover — each against the previous week,
plus up to three next steps from the checklist and, on the free tier or
during the evaluation, what a licence adds. Every figure comes from the
ledger; nothing is estimated.

- It goes to the address in **Settings → Weekly report**, otherwise the
  first ops email it finds (the `ops.email` option, then any channel's
  Settings → Operations address), then the licence holder, then the
  address left in "Email me before it ends".
- Turn it off or change the recipient on that card. **Send me a test**
  mails the week-to-date report now; **Preview** opens it in a new tab.
- It uses the same SMTP transport as ops alerts: `SMTP_SERVER` (or
  `SMTP_HOST`), `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` in
  the host environment, with `nodemailer` installed on the host. Without
  SMTP nothing is sent and nothing fails.
- The scheduler runs on the worker process, once per install however many
  workers you run, and is off when `disableScheduler: true`.

**Dashboard widget.** Dashboard → Add widget → **Payments** shows takings,
settled payments and disputes for the last 7 days, the licence notice when
a trial or key is about to end, and a link to the Payments page. Needs
`ReadOrder`.

**Ops alerts.** Disputes, amount mismatches, failed renewals and
subscriptions that could not be created go to the channel's own
Settings → Operations address first, then the `ops.email` plugin option.
The e-mails have an HTML and a plain-text part and use the channel's
hosted-page brand name, accent colour and logo; the optional `email`
plugin option (`accentColor`, default `#155dfc`, `logoUrl`, `storeName`,
`supportEmail`, `footerText`) is the fallback. `renderEmail()` is exported
if you want your own payment e-mails in the same design.

**Channels.** Administrators working in a channel other than the default
one see and act on that channel's ledger, settings, payment methods and
subscriptions only; the webhook event log is shown in the default channel.

The anonymous usage numbers (counts and totals, never customer data) that
the evaluation ping sends to the licence server keep flowing after
purchase via the daily heartbeat; `HULO_HEARTBEAT_DISABLED=true` stops
them.

## Tiers

| Free tier | Licensed |
| --- | --- |
| Stripe: sessions, wallets, 3-D Secure, automatic/manual capture, refunds, disputes, signed webhooks; bank transfer; pay later | Adyen, PayPal, Mollie, Square, Braintree, GoCardless, Checkout.com, Coinbase Commerce |
| Hosted checkout page; pay links (hosted page, or Stripe links) | Provider pay links for the licensed providers |
| Provider routing order; dashboard-refund reconciliation; per-IP rate limits | Fallback to the next provider after a decline |
| Ledger, dashboard, webhook log, dashboard widget | Subscriptions and the renewal scheduler |
| `hulo-payment-rules` eligibility checker | Saved cards, surcharges |
| | Weekly report and set-up checklist |

Unlicensed installs run everything for 14 days (no card needed); after
that the licence is bought from the admin banner. Details and pricing:
https://huloglobal.com/vendure-plugins/payments/

## Webhook events handled

Each provider posts to its own endpoint on the Vendure server:
`<publicBaseUrl>/hulo-payments/webhook/<handler code>`, e.g.
`https://shop.example.com/hulo-payments/webhook/hulo-stripe` (the
Providers tab shows the exact URL; Connect registers it where the
provider's API allows).

Stripe `payment_intent.succeeded / amount_capturable_updated / payment_failed / canceled`, `charge.refunded`, `charge.refund.updated`, `refund.updated`, `charge.dispute.created / closed`, `checkout.session.completed`, `invoice.paid / payment_failed`, `customer.subscription.updated / deleted / paused`.
Adyen `AUTHORISATION`, `CAPTURE`, `CAPTURE_FAILED`, `CANCELLATION`, `REFUND`, `REFUND_FAILED`, `CHARGEBACK`, `NOTIFICATION_OF_CHARGEBACK`, `CHARGEBACK_REVERSED`, `RECURRING_CONTRACT`.
PayPal `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*`, `PAYMENT.AUTHORIZATION.*`, `CUSTOMER.DISPUTE.*`, `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED`.
Mollie: every payment webhook (status, refunds, chargebacks, subscription payments).
