# HUMAN-OPS — tasks a person must do (not automatable in code)

These are external-provider / DNS / account tasks that gate going live. The code
is written to a wrapper boundary so each is a config change, not a code change.

## SendGrid (email — SPEC §4.6)

- [ ] **Authenticate a dedicated sending subdomain** (e.g. `mail.filament.shop.cleverdeals.net`)
      with its own **SPF + DKIM** DNS records. Without this, marketing mail lands
      in spam.
- [ ] **Separate transactional vs marketing streams** — SendGrid subusers, or at
      minimum separate sender identities. Order confirmations must never share
      reputation with promotions. Set `SENDGRID_FROM_TRANSACTIONAL` /
      `SENDGRID_FROM_MARKETING` accordingly.
- [ ] Create an **Event Webhook** pointing at `POST /api/v1/webhooks/sendgrid`
      and set `SENDGRID_WEBHOOK_KEY` to match the signing secret.
- [ ] Put the real `SENDGRID_API_KEY` in `apps/api/.env`. Until then the code
      runs in sandbox (no real delivery).

## Mollie (payments — SPEC §4.7, §16)

- [ ] **Request Pay-by-Bank activation** via Mollie support early — it was in
      beta at spec time and is the headline method for >30-day pre-orders.
- [ ] Enable **recurring mandates** on the account (subscriptions, §13.7).
- [ ] Configure the **webhook URL** → `POST /api/v1/webhooks/mollie`.
- [ ] Put the real **test** key in `apps/api/.env` first (`MOLLIE_API_KEY=test_…`),
      exercise the flows, then swap to the live key at launch. Until then the
      in-memory fake is used.
- Note: some issuing banks settle bank transfers as standard (not instant); the
  code treats the `pending → paid` transition as the trigger, not checkout
  completion.

## OpenRouter (LLM — SPEC §4.5)

- [ ] Create an API key with a **low daily spend cap** and put it in
      `OPENROUTER_API_KEY`. `OPENROUTER_DAILY_CAP_MICROUSD` enforces a second cap
      in-app. Until a key is set, the scripted fake is used.

## Auth.js / Google (storefront login — SPEC F9)

- [ ] Create a **Google OAuth client** and set `GOOGLE_CLIENT_ID` /
      `GOOGLE_CLIENT_SECRET`. Facebook is code-complete but flag-gated
      (`AUTH_FACEBOOK_ENABLED=false`).

## Backups (SPEC §6)

- [ ] Set `BACKUP_RCLONE_REMOTE` (Backblaze B2 / S3) and schedule `infra/backup.sh`.
- [ ] **Test a restore** on staging before launch (see `docs/RESTORE.md`).

## Sentry (optional — SPEC §6)

- [ ] Set `SENTRY_DSN` + `SENTRY_ENABLED=true` to turn on error alerts on the API
      + worker.
