# Changelog

All notable changes to `@huloglobal/vendure-plugin-payments` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
