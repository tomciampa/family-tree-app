# Email intake Worker

Cloudflare Worker for `talkthroughhistory.com`'s email-based upload feature.
Parses an inbound email (via `postal-mime`) and forwards it to the Next.js
app's `/api/email-intake` webhook. This is a separate deployment target
from the main app — it's not built or deployed by Vercel, and has its own
`package.json`/dependencies.

**Not deployed yet.** Built across Stage 1 (schema/webhook/Worker) and
Stage 2 (Settings UI, HEIC support) of this feature, for version control
in this repo; deployment is a deliberate manual step for afterward.

## Why a dedicated subdomain, not the root domain

See the Stage 1 investigation notes in the main app's history: the root
domain (`talkthroughhistory.com`) currently has no MX record at all, so
there's no live inbound-mail conflict today — but Cloudflare Email Routing
takes over MX for whatever domain/subdomain it's enabled on, and the root
domain's DMARC is already tuned for the existing Mailtrap outbound setup
(magic links, password reset). Keeping this experimental, second-deploy-
target feature on its own subdomain (e.g. `uploads.talkthroughhistory.com`)
isolates its DNS/MX footprint from that production auth-email path
entirely — nothing here can affect login email deliverability, and this
feature can be iterated on or rolled back without touching the root
domain's DNS at all.

## Before deploying the Worker

The Next.js side (`/api/email-intake`, the migrations, everything under
`src/app/api/email-intake` and the two `email_upload_intake`/
`documents_email_subject` migrations) must be committed, pushed, and
live in production *first* — confirmed directly (not assumed) that as of
this readiness check, `src/app/api/email-intake/` was still uncommitted,
and `https://talkthroughhistory.com/api/email-intake` returns a plain
404 in production (the route doesn't exist there yet), not the 401 a
deployed-but-secret-mismatched route would return. Deploying the Worker
before this is live means every real inbound email will bounce with
"Upload service temporarily unavailable" — the Worker's own honest
response to a webhook URL that doesn't resolve to anything yet.

Once the Next.js side is live, each family's own upload address is shown
in Settings (`/settings` → "Email upload address") with a copy button —
that's the address to actually give out once this Worker is deployed and
Email Routing is configured below.

## Manual deployment steps (not done yet)

1. Add `uploads.talkthroughhistory.com` (the subdomain the Stage 1 DNS
   investigation recommended, and what `wrangler.toml`'s `EMAIL_INTAKE_URL`
   and Settings' displayed address both already assume) to Cloudflare,
   and enable Email Routing for it.
2. `cd cloudflare-worker && npm install`
3. `npx wrangler login`
4. `EMAIL_INTAKE_URL` in `wrangler.toml` is already set to the real,
   confirmed production webhook URL (`https://talkthroughhistory.com/api/email-intake`
   — confirmed via `vercel domains ls`: the production domain is the bare
   apex, no `www.`). Nothing to change here unless the domain changes.
5. `npx wrangler secret put EMAIL_INTAKE_SECRET` — must be set to the
   exact same value as the Next.js app's own `EMAIL_INTAKE_SECRET` env
   var in Vercel. Generate a fresh secret for this — don't reuse the
   local-dev value from `.env.local`, and don't reuse any other existing
   key in this project.
6. `npx wrangler deploy`
7. In Cloudflare's Email Routing settings for the subdomain, add a
   catch-all rule (since the family token is the entire local-part, not a
   fixed address) pointed at this Worker.
8. Send a real test email to a real family's own upload address (copy it
   from that family's Settings page) with an attachment, and confirm it
   lands in that family's photos or documents.

## Local development

`wrangler dev` can run this Worker locally, but actually *receiving* real
inbound email requires the Cloudflare-side Email Routing configuration
above — there's no local inbound-email simulator. `EMAIL_INTAKE_SECRET`
for local dev goes in a `.dev.vars` file (gitignored, never commit) in
this directory, e.g.:

```
EMAIL_INTAKE_SECRET=<same value as the Next.js app's .env.local>
```

The webhook itself (`/api/email-intake`) can be exercised directly with a
plain HTTP POST that mimics what this Worker sends — see the main app's
verification notes for this feature; that path needs no Cloudflare
deployment at all.
