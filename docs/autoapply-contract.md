# AutoApply contract (shared by every component)

Schema: `sql/20_autoapply.sql` (tables prefixed `aa_`). Design: https://claude.ai/artifact/BWrNwVY5YGNRwHBtz73B2a

## Components and owners

| Component | Where | Owns |
|---|---|---|
| API | `Pandora/frontend/routes/autoapply.js`, `Pandora/frontend/lib/autoapply/*` | profile/answers/resume, orders + Razorpay, batches control, needs-you resolve, inbox/accounts read, inbound mail endpoint, recruiter-mail forwarding, refunds cron |
| Web UI | `Pandora/frontend/src/pages/autoapply/*`, `src/lib/useAutoApply.js` | all AutoApply screens |
| Email Worker | `Pandora/email-worker/` (Cloudflare Worker) | receive mail for `*@apply.vloombox.in`, extract codes/links, store raw in R2, POST to API |
| Scheduler + discovery | `AutoJobApplier/cloud_hunter/saas/discovery/`, `saas/scheduler.py` | fill `aa_jobs` (LinkedIn + boards), shortlist, queue, batch status moves, expiry -> `refund_due` |
| Workers | `AutoJobApplier/cloud_hunter/saas/worker/` | claim tasks, apply via existing `ats.py`, OTP from `aa_mail_events`, vault, credits capture, site budget |

Shared Python helper: `cloud_hunter/saas/db.py` (connect via `SUPABASE_DB_URL`).

`tenant_host` is the site-budget and portal-account key: the apply URL's host, except on ATS hosts shared by many companies (Greenhouse, Lever, Ashby, SmartRecruiters), where it is `<host>/<board slug>`, e.g. `job-boards.greenhouse.io/razorpay`.

## Config (single source: `Pandora/frontend/config/tiers.js` -> `AUTO_APPLY`; Python reads the same numbers from env or `saas/config.json`)

```js
AUTO_APPLY = {
  plans: ['pro', 'max'],                // active Pro/Max required to buy
  monthly_cap: 1000,                    // applications per account per IST calendar month (purchase + claim checks)
  daily_cap: 60,                        // applied per user per IST day
  per_company_7d: 3,                    // applied per user per company_key in rolling 7 days
  window_days_max: 30, window_days_default: 30,   // job posting age the user may choose (1..30)
  credit_validity_days: 90,
  review_hours: 6,                      // shortlist review window when review_before_apply = true
  tenant_daily_cap_default: 150,        // platform-wide submissions per tenant_host per IST day
  packs: {                              // paise, GST inclusive
    service: { 50: 59900, 80: 79900, 100: 99900 },
    product: { 50: 89900, 80: 119900, 100: 149900 },   // confirmed 2026-11-17
  },
}
```

`company_kind`: `service` = IT services / consulting / outsourcing (names in `cloud_hunter/config.json` -> `service_companies.names`); `product` = everything else that is a real employer; `unknown` = not yet classified (never shortlisted for either pack until classified). A service pack only shortlists `service` jobs, a product pack only `product` jobs.

## Status meanings

Batch: `pending_payment` (order created) -> `paid` (API, after signature verify; ledger `purchase` +credits_total, `purchased_at`, `expires_at` = +90 d) -> `shortlisting` (scheduler) -> `review` (if review_before_apply; `review_until` set) -> `running` -> `waiting_supply` (no more matching jobs right now; scheduler keeps refilling) -> `completed` (credits_used = credits_total). User can `paused`/resume and `cancelled`. At `expires_at` with credits left: scheduler -> `refund_due`; API cron refunds `price_paise * remaining / credits_total` via Razorpay, writes ledger `refund` (-remaining), -> `refunded`. Cancel with credits left also goes to `refund_due`.

Task: `shortlisted` (scheduler) -> `removed` (user, during review) | `queued` (scheduler, after review or immediately) -> `claimed` -> `running` -> `waiting_code` -> `submitting` -> `applied` (ledger `capture` -1, batch credits_used +1) | `skipped` | `failed` (retryable: back to `queued`, attempt+1, not_before backoff, max 2 retries) | `needs_you` (row in `aa_needs_you`). Credits are only ever spent by `applied`.

When a needs-you item is resolved with `answered`, the API upserts `aa_answers` and sets the task back to `queued` (attempt unchanged). `done_by_user` sets the task `skipped` with `reason_code='done_by_user'` (no credit). `dismissed`/`expired` -> `skipped`.

## Standard answers (`aa_answers.question_key`)

`fields.*` map 1:1 to `answers.json -> fields` in the bot: `fields.first_name, fields.last_name, fields.phone, fields.linkedin, fields.github, fields.website, fields.current_company, fields.current_title, fields.address_line1, fields.city, fields.state, fields.postal_code, fields.country, fields.school, fields.degree`.

`facts.*`: `facts.total_experience_years` (number), `facts.notice_period_days` (number), `facts.current_ctc_lpa`, `facts.expected_ctc_lpa` (numbers, INR lakh/yr), `facts.work_authorized_in` (comma ISO-2 list, e.g. `IN`), `facts.needs_sponsorship` (`yes|no`), `facts.willing_to_relocate` (`yes|no`), `facts.currently_employed` (`yes|no`), `facts.earliest_start_days` (number), `facts.graduation_year`, `facts.highest_degree`, `facts.date_of_birth` (optional, YYYY-MM-DD), `facts.gender`, `facts.ethnicity`, `facts.disability`, `facts.veteran` (each: a free value or `decline`; default `decline`), `facts.how_did_you_hear` (default `LinkedIn`).

Learned answers from needs-you use `q.<sha1 of normalised label>[:16]` keys and store the label in the needs-you payload.

The API serves the list with labels/types: `GET /api/autoapply/answers` -> `{questions: [{key, label, type: 'text'|'number'|'select'|'date', options?, required, help?}], answers: {key: value}}`.

## Vault format (Node and Python must match)

Key: env `AA_VAULT_KEY` = base64 of 32 random bytes. Secret string -> UTF-8 -> AES-256-GCM with a random 12-byte nonce and AAD = `<user_id>|<tenant_host>`. Stored as base64(`nonce || ciphertext || tag(16)`). Python: `cryptography.hazmat.primitives.ciphers.aead.AESGCM`; Node: `crypto.createCipheriv('aes-256-gcm')`.

## Inbound mail (Email Worker -> API)

`POST {AA_API_BASE}/api/inbound/email`, headers `X-AA-Timestamp: <unix seconds>`, `X-AA-Signature: hex(HMAC_SHA256(AA_INBOUND_SECRET, timestamp + "." + rawBody))`. API rejects if |now - ts| > 60 s or signature mismatch (timing-safe compare). Body:

```json
{ "to": "debopriyo.k7q2.acme@apply.vloombox.in", "from": "no-reply@myworkday.com", "from_name": "Acme Careers",
  "subject": "Verify your account", "received_at": "2026-11-16T10:00:00Z",
  "codes": ["482913"], "links": ["https://acme.wd3.myworkdayjobs.com/...verify..."],
  "is_human": false, "text_excerpt": "first 2000 chars of the text body", "raw_key": "mail/2026/11/16/<uuid>.eml",
  "reply_to": null, "message_id": "<...>" }
```

Alias resolution: local part before `@`; the user's alias is the first two dot-separated parts (`first.k7q2`); anything after is a per-company tag. API inserts `aa_mail_events` (user_id NULL if unknown), then `rpc('aa_notify_mail', {p_user, p_event})`. If `is_human` and user has `contact_email`, forward through Resend: From `"<from_name or from> via Vloombox" <relay@apply.vloombox.in>`, Reply-To original sender, set `forwarded_at`. Respond `200 {ok:true}` fast.

Workers wait for codes with `LISTEN aa_mail` (payload `<user_id>:<event_id>`) plus a 2 s poll fallback on `aa_mail_events WHERE user_id=$1 AND received_at > $since AND consumed_by_task IS NULL`, matching sender domain / company / tag.

## HTTP API (all under `requireAuth`, JSON; errors `{error: {code, message}}`)

| Method + path | Body / query | Response |
|---|---|---|
| `GET /api/autoapply/me` | | `{eligible, plan, onboarding_done, profile, prefs, email: {mode, alias, address, contact_email}, review_before_apply, usage: {month_purchased, month_applied, monthly_cap, remaining_purchasable, today_applied, daily_cap}, config: AUTO_APPLY (packs, limits)}` |
| `PUT /api/autoapply/profile` | `{profile?, prefs?, email_mode?, contact_email?, review_before_apply?, consent?: true, onboarding_done?}` | `{ok, profile row}`; creates `apply_alias` on first save |
| `POST /api/autoapply/resume` | multipart `resume` (pdf/docx <= 5 MB) | `{resume_path, parsed: {profile draft}}` |
| `GET /api/autoapply/answers` / `PUT` | PUT `{answers: {key: value}}` | see above |
| `GET /api/autoapply/supply` | `?kind=service|product&window_days=1..30` | `{kind, window_days, count, by_ats: {workday: n, ...}, sample: [{company, title, location, posted_at}]}` (from `aa_jobs` matched to the user's prefs) |
| `POST /api/autoapply/orders` | `{pack_kind, pack_size, window_days}` | `{order_id, amount, currency, key_id, batch_id}`; 403 `not_eligible`, 409 `monthly_cap` |
| `POST /api/autoapply/orders/verify` | `{razorpay_order_id, razorpay_payment_id, razorpay_signature}` | `{batch}` (idempotent) |
| `GET /api/autoapply/batches` | | `{batches: [...]}` |
| `GET /api/autoapply/batches/:id` | | `{batch, counts: {status: n}, tasks: [{id, company, title, ats, status, reason_code, score, submitted_at, apply_url}]}` |
| `POST /api/autoapply/batches/:id/{approve,pause,resume,cancel}` | | `{batch}` |
| `POST /api/autoapply/batches/:id/tasks/:taskId/remove` | | `{task}` (only while batch `review`) |
| `GET /api/autoapply/needs-you` | | `{items: [{id, kind, payload, task: {company, title, apply_url}, created_at}]}` |
| `POST /api/autoapply/needs-you/:id` | `{action: 'done'|'answer'|'dismiss', answer?}` | `{item}` |
| `GET /api/autoapply/inbox` | `?limit=50` | `{mails: [{id, sender, subject, codes, is_human, received_at, text_excerpt}]}` |
| `GET /api/autoapply/accounts` | | `{accounts: [{tenant_host, login_email, status, created_at, last_used_at}]}` |
| `POST /api/autoapply/accounts/reveal` | `{tenant_host}` | `{password}` (rate-limited, logged) |
| `POST /api/inbound/email` | HMAC, no auth | `{ok}` |

Browser live updates: Supabase Realtime `postgres_changes` on `aa_tasks` and `aa_batches` filtered `user_id=eq.<uid>`.

## Environment variables

Web/API (Railway): `AA_VAULT_KEY`, `AA_INBOUND_SECRET`, `AA_MAIL_DOMAIN=apply.vloombox.in`, existing `RAZORPAY_*`, `RESEND_API_KEY`, `SUPABASE_*`.
Email Worker (Cloudflare): `AA_INBOUND_SECRET`, `AA_API_BASE`, R2 binding `AA_MAIL`.
Python scheduler/workers: `SUPABASE_DB_URL` (direct Postgres, port 5432, not the transaction pooler, LISTEN needs a session), `AA_VAULT_KEY`, `AA_MAIL_DOMAIN`, `OLLAMA_URL`, `R2_*` (optional; local disk if unset), `AA_WORKER_ID`.
