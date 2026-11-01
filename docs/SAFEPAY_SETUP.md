# Safepay setup (payments)

PDF Pro talks to [Safepay](https://getsafepay.com) for card payments. Two integration
surfaces exist and this codebase uses **both, for different jobs** — do not mix them:

| Surface                | Used for                                             | Endpoint                                                         |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Legacy hosted checkout | The pay button, redirect back with `tracker` + `sig` | `POST /order/v1/init` → `…/components?env=…&beacon=…&order_id=…` |
| v1 REST API            | Server-to-server payment lookup                      | `GET /reporter/api/v2/payments/{tracker}`                        |
| Webhooks               | Activation, renewals, failures, refunds              | Merchant dashboard → webhook URL                                 |

Everything is configured with environment variables or the admin dashboard; no code changes
are needed to change prices or currencies.

## 1. Merchant prerequisites (external, cannot be automated)

| Requirement                                                                      | Status                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Approved Safepay merchant account (Pakistan entity, business documents verified) | **Outstanding — must be confirmed by you**                         |
| Live `SAFEPAY_API_KEY` and `SAFEPAY_SECRET_KEY`                                  | **Outstanding**                                                    |
| Webhook signing secret (`SAFEPAY_WEBHOOK_SECRET`)                                | **Outstanding**                                                    |
| Recurring/subscription capability enabled on the merchant account                | **Outstanding — confirm with Safepay support**                     |
| Settlement account and payout schedule                                           | Confirm with Safepay                                               |
| Currencies enabled (PKR by default; USD/EUR require Safepay approval)            | Confirm with Safepay                                               |
| International card acceptance                                                    | Confirm with Safepay — may be limited to domestic cards by default |

While these are missing, the app hides the pay button and tells the user that card payments
are not configured yet. It never fakes a payment.

## 2. Environment variables

```bash
SAFEPAY_ENV=sandbox                 # sandbox | production
SAFEPAY_API_KEY=sec_xxx             # merchant API key (server only)
SAFEPAY_SECRET_KEY=sec_xxx          # merchant secret key (server only)
SAFEPAY_WEBHOOK_SECRET=whsec_xxx    # webhook HMAC-SHA512 secret
SAFEPAY_V1_SECRET=sec_xxx           # legacy redirect signature secret (defaults to SAFEPAY_SECRET_KEY)
# SAFEPAY_API_BASE=                 # optional host override
# SAFEPAY_CHECKOUT_BASE=            # optional checkout host override
BILLING_GRACE_DAYS=3                # Premium days granted while a failed renewal retries
```

`SAFEPAY_API_KEY`/`SAFEPAY_SECRET_KEY` are read server-side only (`src/lib/server/config.ts`).

## 3. Webhook endpoint

1. Deploy the app behind HTTPS so the public URL is reachable.
2. In the Safepay dashboard, add the webhook URL:

   ```
   https://<your-domain>/api/payments/safepay/webhook
   ```

3. Subscribe to `payment:created` (and `payment:refunded` if the account supports it).
4. Copy the signing secret into `SAFEPAY_WEBHOOK_SECRET` and restart.

Verification: `X-SFPY-SIGNATURE` is the hex HMAC-SHA512 of the **raw request body**. Invalid
signatures get `401`, are stored with `signature_valid = false` for forensics, and never
change a subscription. Check deliveries in the admin dashboard → _Email & webhooks_.

A successful delivery looks like:

```json
{
  "token": "evt_…",
  "type": "payment:created",
  "notification": {
    "tracker": "track_…",
    "state": "PAID",
    "amount": "1500.00",
    "currency": "PKR",
    "metadata": { "order_id": "<local payment id>" }
  }
}
```

Amounts arrive as decimal strings and are compared in minor units (`1500.00` → `150000`).

## 4. Checkout flow as implemented

1. `POST /api/billing/checkout` → creates a `pending` subscription and a `pending` payment row,
   then returns a Safepay redirect URL. **No Premium is granted here.**
2. The user pays on Safepay's hosted page.
3. Safepay redirects to `/billing/return?tracker=…&sig=…`; the page posts to
   `/api/billing/verify-return`, which verifies the redirect signature and fetches the payment
   state from Safepay's API before activating anything.
4. The signed webhook activates Premium. If the webhook arrives first, the return page simply
   reports "paid"; if the return page arrives first, it shows "pending" and polls (every 4 s,
   15 attempts) until the webhook lands.
5. `/billing/cancelled` is shown when the user abandons the hosted page. The pending rows are
   marked `cancelled` by the maintenance job after 24 hours.

## 5. Recurring billing

The seeded plans use `billing_mode = 'one_time'`, because recurring capability depends on the
merchant account. When Safepay enables subscriptions for you:

1. Create the plan in the Safepay dashboard (a `plan_id` must exist there).
2. Admin → _Pricing_ → set `providerPlanId` and switch `billingMode` to `recurring`.
3. Renewals then arrive as webhooks and extend `current_period_end` automatically; the
   maintenance job expires anything that lapses.

`POST /api/billing/cancel` cancels at period end and notifies the user; `cancel_now` (admin)
ends access immediately. If the provider cannot be reached for a recurring cancellation, the
API returns `502` and changes nothing — it never claims a cancellation it did not perform.

## 6. Lifecycle states

| State       | Meaning                                                              | Premium?                                        |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `free`      | No subscription                                                      | No (Free quota: 200 MB)                         |
| `pending`   | Checkout created, payment not confirmed                              | No                                              |
| `active`    | Verified payment; `current_period_end` in the future (or open-ended) | Yes (Premium quota: 2 GB)                       |
| `past_due`  | Renewal failed, still inside `grace_until`                           | Yes, with a payment warning                     |
| `cancelled` | Cancelled; access continues until `current_period_end`               | Yes until the term ends                         |
| `expired`   | Term ended / grace ended                                             | No — files are kept, uploads blocked above the Free quota |

## 7. Testing without a live merchant account

- `SAFEPAY_WEBHOOK_SECRET` is enough to exercise the webhook path: sign a body with
  HMAC-SHA512 and `POST` it to the endpoint. `tests/integration/billing.test.ts` does exactly
  this against a real server and asserts activation, idempotency, amount mismatches, refunds,
  grace periods and expiry.
- There is **no** environment flag that grants Premium without a verified payment. Do not add
  one before a release.

## 8. Going live checklist

- [ ] Merchant account approved, live keys issued
- [ ] `SAFEPAY_ENV=production`
- [ ] Webhook URL registered and tested with a live 1 PKR payment
- [ ] Prices set in Admin → Pricing (minor units) and reviewed
- [ ] Refund policy and support email configured (Admin → Settings)
- [ ] `BILLING_GRACE_DAYS` agreed with support/finance
- [ ] Cron (`/api/cron/maintenance`) scheduled every 15 minutes
- [ ] A real payment, a failed payment, a refund and an expiry tested on production keys
