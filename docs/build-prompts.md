# New Filament Store — Build Prompts (pointer)

The authoritative build-prompts document (Prompts G, 0–16) lives in Google Drive:

- **Title:** `claude code build prompts.md`
- **Drive file id (docx):** `13FOlFQqYhJle2jwO5gBxq7EQDIFGLq5T`
- **Native Google Doc id:** `1AvkAlkM5sDh_mk9L0ZJKXbtr_nhbsX6xvnJWj35NIiM`

Companion spec: [`docs/tech-spec.md`](./tech-spec.md) (v1.6) — the full technical specification, verbatim from Drive.

Build progress and per-prompt deviations are tracked in [`BUILD_LOG.md`](../BUILD_LOG.md) at the repo root.

## Prompt sequence (summary)

- **G** — Global rules (conventions, testing discipline, process).
- **0** — Orientation, environment, scaffolding (`npm run gate`, test harness, `.env.example`).
- **1** — Worker app, pg-boss, domain events outbox + dispatcher.
- **2** — Full schema migration set (SPEC §13 + §17.8 deltas).
- **3** — Identity, auth (Auth.js), consent.
- **4** — Inbound shipments & presale stock pools.
- **5** — Pricing engine (SPEC §15).
- **6** — Mollie payments & payment timing (>30-day bank-only rule).
- **7** — Interest flags & prospective products.
- **8** — OpenRouter wrapper & sales agent (SSE chat, tools).
- **9** — SendGrid compose/send pipeline, suppression, caps.
- **10** — Approval queue & escalations UI (SPEC §17).
- **11** — Notification agent: scanners & reactions.
- **12** — Marketing agent (nightly segmentation).
- **13** — Subscriptions: mandates, credits, dunning.
- **14** — Storefront commerce UX.
- **15** — Digest, observability, ops.
- **16** — Full-system verification, hardening, handover.

Each prompt ends with a GATE (`npm run gate` green, sometimes `npm run smoke`); do not begin the next prompt until the gate passes. Commit at each green gate as `build(N): <title>`.

**Resumption:** read `BUILD_LOG.md` for the last completed prompt N, run `npm run gate` (fix to green if red), then continue from Prompt N+1.
