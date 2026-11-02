# Cloudflare setup (Turnstile + site verification)

This deployment already uses Cloudflare for object storage (R2 — see
[`STORAGE_SETUP.md`](STORAGE_SETUP.md)). This page covers the two *verification* pieces that run
inside the app:

1. **Turnstile** — CAPTCHA-free human verification on the unauthenticated auth forms.
2. **Site / domain verification** — the token Cloudflare asks you to publish (meta tag or
   `/.well-known` file) when you verify a domain or a custom hostname.

Both are **opt-in by environment variable**. With no keys the widget is not rendered, no server
check runs, and the app behaves exactly as before — so local development, CI and a fresh deploy
never break waiting for Cloudflare.

## 1. Turnstile (bot protection on auth)

### What it protects

| Route | Method | Behaviour when configured |
|---|---|---|
| `POST /api/auth/login` | sign in | token required, verified server-side |
| `POST /api/auth/register` | create account | token required, verified server-side |
| `POST /api/auth/forgot-password` | reset request | token required, verified server-side |
| `POST /api/auth/reset-password` | choose new password | token required, verified server-side |

Google sign-in, email verification links and every authenticated route are unaffected.

### Create the widget

1. Cloudflare dashboard → **Turnstile** → **Add site**.
2. Hostname: your production domain (add `localhost` as a second widget if you want to test the
   widget locally; the *test keys* below are easier).
3. Widget mode: **Managed** (Cloudflare decides whether a visitor sees a checkbox).
4. Copy the **Site Key** (public) and the **Secret Key** (server only).

### Configure

```bash
TURNSTILE_SITE_KEY=0x4AAAAAAA...        # public, rendered into the forms
TURNSTILE_SECRET_KEY=0x4AAAAAAA...      # server only — never expose
```

`NEXT_PUBLIC_TURNSTILE_SITE_KEY` is accepted as an alias for the site key. Restart the app; the
forms now show the widget with a “Protected by Cloudflare Turnstile” note.

### How the check works

- The widget returns a single-use token valid for ~300 s. The browser posts it as
  `turnstileToken` in the JSON body.
- `src/lib/server/turnstile.ts` calls `https://challenges.cloudflare.com/turnstile/v0/siteverify`
  with the secret key, the token and the visitor IP, then compares the answered `hostname` with
  the request host (so a token minted for another site is rejected).
- Failure modes, all fail-closed:

  | Situation | HTTP | `code` |
  |---|---|---|
  | Token missing/blank | `400` | `turnstile_required` |
  | Cloudflare rejects the token (expired, reused, invalid) | `403` | `turnstile_failed` |
  | Token issued for a different hostname | `403` | `turnstile_hostname_mismatch` |
  | `siteverify` unreachable / non-2xx / timeout (6 s) | `503` | `turnstile_unavailable` |

  The forms re-render the widget automatically after any `turnstile_*` error so the next submit
  carries a fresh token.
- Rate limits still apply on top of this (per IP and per account), so Turnstile is a second layer,
  not the only one.

### Testing without a real Cloudflare account

Cloudflare publishes test keys that always pass:

```bash
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

Always-fail keys (`2x00000000000000000000AB` / `2x0000000000000000000000000000000AA`) are useful
for exercising the rejection path. Unit tests stub `siteverify` instead of calling it
(`tests/unit/turnstile.test.ts`), so the suite never needs network access.

### CSP

If you set a Content-Security-Policy at the proxy, allow Turnstile:

```
script-src 'self' … https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com;
connect-src 'self' … https://challenges.cloudflare.com;
```

## 2. Site / domain verification

Two token formats are supported, both optional:

| Variable | What the app does |
|---|---|
| `CLOUDFLARE_VERIFICATION_TOKEN` | Adds `<meta name="cf-verification" content="…">` to every page (Next.js `metadata.verification`). Use it when a verification screen asks for an HTML meta tag. |
| `CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN` | Serves the token at `/.well-known/cf-custom-hostname-challenge/<token>` (Cloudflare for SaaS custom hostnames). Any other value, or no token configured, answers `404`. |

```bash
CLOUDFLARE_VERIFICATION_TOKEN=abc123…
CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN=xyz789…
```

Verify:

```bash
curl -s https://<your-domain>/ | grep -o '<meta name="cf-verification"[^>]*>'
curl -s https://<your-domain>/.well-known/cf-custom-hostname-challenge/<token>
```

If Cloudflare instead gives you a **DNS TXT record** (the usual case for a zone you are adding to
Cloudflare, and for verifying a domain you want to use as an R2/SaaS custom hostname), there is
nothing to deploy — add the record in DNS and click verify. Do not invent a meta tag for a flow
that does not use one; the two variables above exist because those are the flows that read the
site itself.

> **Cloudflare in front of the app.** Putting the site behind the Cloudflare proxy is a DNS
> change, not a code change: point the zone at the host, enable “Full (strict)” TLS, and keep the
> origin reachable only through Cloudflare if you want the origin hidden. Nothing in the app needs
> to know it is behind Cloudflare — the session cookie already works with `X-Forwarded-*` headers.

## 3. What is still outstanding

| Item | Status |
|---|---|
| Cloudflare account with the production domain added | **Outstanding — site owner** |
| Turnstile widget + site key / secret key | **Outstanding** |
| Verification token for the domain (if Cloudflare shows one) | **Outstanding** |
| R2 bucket + API token (see [`STORAGE_SETUP.md`](STORAGE_SETUP.md)) | **Outstanding** |

Until they arrive: Turnstile is disabled, no verification tag is emitted, and nothing pretends to
be verified.
