# AutoApply email worker (`aa-email-worker`)

A Cloudflare Email Worker that handles every address on `apply.vloombox.in` (catch-all), for example
`first.k7q2@apply.vloombox.in` or, with a per-company tag, `first.k7q2.acme@apply.vloombox.in`. For each mail it:

1. Rejects only obvious abuse: a mail over 10 MB, or a recipient local part over 64 chars. Unknown aliases are **accepted**; the API stores them with `user_id NULL`.
2. Stores the raw message in R2 (`AA_MAIL`) at `mail/YYYY/MM/DD/<uuid>.eml` (UTC date).
3. Parses it with `postal-mime` and extracts verification **codes** and **links**. This is a port of `AutoJobApplier/cloud_hunter/mail_otp.py`: the same `CODE_RE` / `LINK_RE` / `VERIFY_HINT`, the `<style>/<script>/<head>` strip, `find_code` for alphanumeric codes such as Greenhouse's 8-char `X7kP2mQa`, and the link skip list. The bot knew which code length it was waiting for. This worker doesn't, so it returns every plausible candidate and filters out prices, phone numbers, dates, years, zip codes, street numbers, job/requisition ids and promo codes.
4. Decides `is_human`. It is true only for a personal-looking sender with no automated-mail signals: no no-reply/careers/ATS-system sender, no List-*/Precedence/Auto-Submitted headers, no codes or verification links, and no ATS template phrases.
5. POSTs the contract body (`docs/autoapply-contract.md`, "Inbound mail") to `{AA_API_BASE}/api/inbound/email`. It signs the request with `X-AA-Timestamp` and `X-AA-Signature = hex(HMAC_SHA256(AA_INBOUND_SECRET, ts + "." + rawBody))`. It tries 3 times (waits of 1 s, then 3 s), with a fresh timestamp each try, inside `ctx.waitUntil`. A failure is logged with its `raw_key`, so the mail can be replayed from R2.

```
src/index.js     email() handler, sign(), deliver()
src/extract.js   pure functions: codes, links, is_human, payload
test/            node:test suites + fixture .eml files + vectors/hmac_vector.json (shared with the API)
```

## Test

```bash
npm install
npm test                 # node --test  (22 tests)
npm run dry-run          # wrangler deploy --dry-run --outdir dist (no login needed)
```

`test/vectors/hmac_vector.json` holds `{secret, ts, body, expected_signature}`. The API's verifier should test against the same file.

## One-time setup (owner)

Prerequisite: the **vloombox.in** zone uses Cloudflare DNS (nameservers at Cloudflare). Email Routing only works on a zone that Cloudflare serves. The API itself can stay on Railway under any domain; set `AA_API_BASE` accordingly.

1. **Log in**: `npx wrangler login`
2. **R2 bucket**: `npx wrangler r2 bucket create aa-mail`
   - Optional retention, for example deleting raw mail after 90 days: `npx wrangler r2 bucket lifecycle add aa-mail expire-raw mail/ --expire-days 90`
3. **Secret**, which must equal `AA_INBOUND_SECRET` on Railway: `npx wrangler secret put AA_INBOUND_SECRET` (generate one with `openssl rand -hex 32`)
4. **API base**: check `AA_API_BASE` in `wrangler.toml` (currently `https://www.vloombox.in`)
5. **Deploy**: `npm run deploy`
6. **Email Routing** (Dashboard -> vloombox.in -> Email -> Email Routing):
   - If it is not on yet, *Enable Email Routing*.
   - *Settings -> Subdomains -> Add subdomain* `apply.vloombox.in`. Cloudflare creates these records **on the subdomain**:
     - `MX apply.vloombox.in -> route1.mx.cloudflare.net` (and route2 / route3, with the priorities Cloudflare shows)
     - `TXT apply.vloombox.in "v=spf1 include:_spf.mx.cloudflare.net ~all"`
     - Remove any other MX record on `apply.vloombox.in`. MX records on the root `vloombox.in` (your normal mailbox) are untouched.
   - *Routing rules -> Catch-all address* (for `apply.vloombox.in`): Action **Send to a Worker** -> `aa-email-worker`, then **Enable**.
7. **Outbound relay** (`relay@apply.vloombox.in` via Resend, done by the API): add the domain in Resend and create the DKIM / return-path records it lists. Resend uses its own subdomain for the bounce MX (`send.apply.vloombox.in`), so it does not clash with the Cloudflare MX above.

## Testing with a real mail

```bash
npx wrangler tail aa-email-worker          # live logs: {"msg":"mail", to, from, codes, links, is_human, raw_key}
```

- Send a mail from Gmail to `test.abcd@apply.vloombox.in` and watch the tail. The API gets an event with `user_id NULL` (unknown alias).
- Trigger a real verification. For example, start a Workday or Greenhouse account with `<your alias>.test@apply.vloombox.in` and check that `codes` / `links` in the tail and in `aa_mail_events` are right.
- Fetch the stored raw mail: `npx wrangler r2 object get aa-mail/mail/2026/11/16/<uuid>.eml --file x.eml --remote`
- To test locally without DNS, run `npx wrangler dev`, then post a raw message:
  `curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@b.com&to=x.k7q2@apply.vloombox.in" --data-binary @test/fixtures/workday_code.eml`
  (uses a local R2 simulation; set `AA_INBOUND_SECRET` in `.dev.vars`).

## Limits and costs to watch

- **Workers Free**: 100k invocations a day, and **10 ms CPU per invocation**. Parsing a normal ATS mail takes a few ms, but a large HTML or attachment-heavy mail can exceed 10 ms. When that happens the mail fails, and the sender retries or bounces it. If `wrangler tail` shows `exceededCpu`, switch to Workers Paid ($5/mo, 30 s CPU).
- **Email Routing**: free, with a 25 MiB maximum message size at Cloudflare (this worker rejects anything over 10 MB). Email Workers have a separate daily limit on free plans; check *Email Routing -> Overview*.
- **R2 free tier**: 10 GB-month storage, 1M Class A (put) and 10M Class B (get) operations a month, and no egress fees. One mail is one put. At roughly 50 KB a mail, 10 GB is about 200k mails, so set the lifecycle rule above.
- **`waitUntil`**: the POST runs after the mail is accepted. If the API is down for the whole retry window (about 4 s), the event is lost, and only the R2 copy and the error log remain. Replay it from R2 if needed.
- The API rejects a timestamp more than 60 s off. Workers clocks are NTP-synced, but the Railway host's clock must be too.
