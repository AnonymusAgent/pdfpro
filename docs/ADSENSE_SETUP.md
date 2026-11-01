# Google AdSense setup

Advertising is **off** in this build. Nothing renders until you supply an approved publisher
id and real ad-unit ids, and even then ads are shown only to Free accounts. There are no
placeholder ads, no revenue claims and no ad code on the PDF workspaces.

## How the app decides to show an ad

`GET /api/site-config` (and the server-rendered page) computes:

```
enabled = configured.enabled && publisherId matches /^ca-pub-\d{10,20}$/
show    = enabled && slots[placement] exists && plan === "free" && (consent granted || !requireConsent)
```

`src/components/ads/ad-slot.tsx` is the only component that mounts AdSense. It:

- loads `pagead2.googlesyndication.com/pagead/js/adsbygoogle.js` once, only when an ad is
  actually going to render;
- labels every unit **Advertisement**;
- never renders on `/editor`, `/convert`, `/ocr`, `/sign`, `/compare` or `/cloud` — the tool
  surfaces stay clean;
- renders nothing at all for Premium accounts.

## 1. External prerequisites

| Requirement                                         | Status                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Approved AdSense account for the production domain  | **Outstanding — must be approved by Google**                                      |
| Publisher id (`ca-pub-…`)                           | **Outstanding**                                                                   |
| Approved ad-unit ids for the placements you enable  | **Outstanding**                                                                   |
| Privacy policy page published (required by AdSense) | Provided: `/help` documents data handling; add your own policy URL if Google asks |
| Cookie/consent notice for EEA/UK traffic            | Built in — the consent banner gates ad loading                                    |

## 2. Configuration

Either use environment variables:

```bash
ADSENSE_ENABLED=true
ADSENSE_CLIENT_ID=ca-pub-1234567890123456
ADSENSE_SLOT_DASHBOARD=1234567890
ADSENSE_SLOT_CLOUD=2345678901
ADSENSE_SLOT_PRICING=3456789012
ADSENSE_SLOT_TOOLS=4567890123
```

…or set the same values in **Admin → AdSense & settings** (stored in the `settings` table and
applied within 5 seconds). The admin values win because they are read first when present.

Only placements with a numeric slot id (3–30 digits) render. `enabled` is forced back to
`false` whenever the publisher id is empty or malformed — that is deliberate: a typo must not
produce a broken ad slot.

`NEXT_PUBLIC_ADSENSE_CLIENT_ID` is not required; the client id is delivered through
`/api/site-config` after consent.

## 3. Placements

| Placement   | Page         | Notes                                                  |
| ----------- | ------------ | ------------------------------------------------------ |
| `dashboard` | `/dashboard` | Below the account cards, never inside the storage card |
| `cloud`     | `/cloud`     | Below the file list                                    |
| `pricing`   | `/pricing`   | Below the comparison table                             |
| `tools`     | `/tools`     | Below the tool directory                               |

Units are responsive (`data-full-width-responsive="true"`) and use `min-height` to avoid
layout shift.

## 4. Consent

`src/components/ads/consent-banner.tsx` shows a banner until the visitor chooses:

- **Accept** → advertising consent recorded, ad script may load.
- **Reject** → no ad requests are made at all.

The choice is stored under `pdfpro.ads.consent` in `localStorage` and can be changed from the
banner at any time. If your legal team requires a certified CMP (Google-certified for EEA),
disable `requireConsent` in the admin panel and integrate your CMP before going live — the
built-in banner is a simple gate, not a certified CMP.

## 5. Verification checklist before enabling

- [ ] AdSense account approved for the production domain
- [ ] Publisher id and at least one slot id entered
- [ ] Consent banner visible on a first visit, and no ad network request before consent
- [ ] Premium account sees **zero** ad markup (check `ins.adsbygoogle` count)
- [ ] Tools pages remain free of ads
- [ ] AdSense policy pages (privacy, cookies) reachable from the footer
- [ ] Page speed checked: the script is loaded on demand and only when ads render
