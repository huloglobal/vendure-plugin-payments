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
- **Disputes** — chargebacks land in the ledger and alert ops.
- **Saved cards** — Stripe Customers and Adyen stored payment methods for
  signed-in customers; list and remove from the shop API.
- **Subscriptions** — mark any product variant as billed daily / weekly /
  monthly / yearly (with a trial); the order charges the first period,
  then Stripe, PayPal and Mollie bill natively and Adyen renewals are
  charged by the plugin's scheduler from the stored card. Customers see and
  cancel their subscriptions through the shop API; admins pause, resume,
  cancel and see MRR.
- **Pay by link** — one click in the admin creates a provider-hosted payment
  link for any unpaid order (draft orders, accepted quotes, phone orders);
  the webhook settles it.
- **Routing, rules and surcharges** — provider order per channel with
  fallback on decline, an eligibility checker (amount band, currencies,
  countries, customer groups, signed-in only) usable on any payment method,
  and optional per-provider surcharges.
- **Ledger + dashboard** — authorisations, captures, refunds, disputes,
  failures, renewals and pay-links by provider and day, success rate,
  webhook deliveries, subscriptions, settings — under **Sales → Payments**.

Works on MySQL, MariaDB and PostgreSQL. No provider SDKs: each provider is
a few REST calls on the platform `fetch`.

## In the admin

- **Payments** (Sales → Payments): dashboard, transactions, subscriptions, pay-by-link, the Providers tab with one-step Connect, and Settings.
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

## Storefront

The simplest integration is the hosted page:

```graphql
mutation { huloHostedCheckout(returnUrl: "https://shop.example.com/checkout/return", cancelUrl: "https://shop.example.com/checkout", methodCode: "paypal") { url expiresAt } }
# methodCode is optional: it preselects that method on the page (one button per provider in your checkout).
# → redirect the customer to `url`; they return to returnUrl?order=CODE&result=paid|pending
```

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

## Subscriptions

Set **Subscription billing interval** (and optionally *every N intervals*
and *free trial days*) on a product variant. Its price is the price per
period. When an order containing it is paid through a HULO method the
plugin creates the subscription with the provider (or schedules it itself
for Adyen), records renewals in the ledger, alerts on failed renewals and
cancels after the configured number of failed daily attempts. PayPal
subscriptions need one customer approval; the approval link is exposed on
`huloMySubscriptions` and in the admin.

## Tiers

| Free tier | Licensed |
| --- | --- |
| Stripe: sessions, wallets, 3-D Secure, automatic/manual capture, refunds, disputes, signed webhooks; bank transfer; pay later | Adyen, PayPal, Mollie, Square, Braintree, GoCardless, Checkout.com, Coinbase Commerce |
| Hosted checkout page | |
| Ledger, dashboard, webhook log | Subscriptions and the renewal scheduler |
| `hulo-payment-rules` eligibility checker | Saved cards, pay-by-link, provider routing, surcharges |

Unlicensed installs run everything for 14 days; the trial (card required,
nothing charged until day 15) and the licence are bought from the admin
banner. Details and pricing: https://huloglobal.com/vendure-plugins/payments/

## Webhook events handled

Stripe `payment_intent.succeeded / amount_capturable_updated / payment_failed / canceled`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created / closed`, `checkout.session.completed`, `invoice.paid / payment_failed`, `customer.subscription.updated / deleted / paused`.
Adyen `AUTHORISATION`, `CAPTURE`, `CAPTURE_FAILED`, `CANCELLATION`, `REFUND`, `REFUND_FAILED`, `CHARGEBACK`, `NOTIFICATION_OF_CHARGEBACK`, `CHARGEBACK_REVERSED`, `RECURRING_CONTRACT`.
PayPal `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*`, `PAYMENT.AUTHORIZATION.*`, `CUSTOMER.DISPUTE.*`, `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED`.
Mollie: every payment webhook (status, refunds, chargebacks, subscription payments).
