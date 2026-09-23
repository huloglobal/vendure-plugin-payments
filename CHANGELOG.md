# Changelog

All notable changes to `@huloglobal/vendure-plugin-payments` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
