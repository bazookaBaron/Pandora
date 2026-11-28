# Subscriptions (Razorpay recurring)

Pro/Max are sold only as Razorpay subscriptions. One-time orders remain for AutoApply/wallet.

## Env (Railway)
- RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
- RAZORPAY_SUBSCRIPTIONS_ENABLED=true (kill switch; off => pricing shows "Coming soon", no one-time fallback)
- INR plans: RAZORPAY_PLAN_{PRO,MAX}_{MONTHLY,YEARLY}
- USD plans: RAZORPAY_PLAN_{PRO,MAX}_{MONTHLY,YEARLY}_USD
- TRUST_GEO_HEADERS=true when behind Cloudflare (uses cf-ipcountry); TRUST_PROXY_HOPS=2 on Railway (verified 2026-11-28: its edge adds two X-Forwarded-For hops; with 1, req.ip is a proxy address that geoip maps to BR). Add 1 more if Cloudflare is put in front.

## Webhook events
subscription.activated, .charged, .pending, .halted, .cancelled, .completed, .updated, payment.failed
(order.paid stays enabled for AutoApply and in-flight legacy orders.)

## Gating paid-only features (AutoApply / wallet)
```js
import { requiresActivePlan } from "../lib/entitlements.js";
const gate = await requiresActivePlan(userId);          // { ok, plan, required }
if (!gate.ok) return res.status(402).json({ error: "plan_required" });
```
Uses the effective plan (halted, lapsed, grace-expired => free). `planAtLeast(plan, min)` is the pure variant.
