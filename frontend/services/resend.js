/**
 * Resend transport — SERVER ONLY.
 *
 * Sends the referral-feature notification emails through the Resend REST API.
 * DORMANT when RESEND_API_KEY is unset: every send logs and skips, and nothing
 * here ever throws or rejects — callers fan these out fire-and-forget after the
 * HTTP response is already sent, so a transport failure must not crash anything.
 *
 * The API key and the upstream response body never reach a client and are only
 * logged through redact().
 */
import { redact } from "../lib/aiClient.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** True when a Resend API key is configured. */
export function isEnabled() {
  return !!process.env.RESEND_API_KEY;
}

function fromAddress() {
  // Local/dev fallback: Resend's shared onboarding sender works without a
  // verified domain.
  return process.env.REFERRAL_FROM_EMAIL || "onboarding@resend.dev";
}

/**
 * Send a single email. Never throws.
 *
 * @param {{ to: string|string[], subject: string, html: string, text?: string,
 *           tag?: string }} msg
 * @returns {Promise<{ id?: string } | { skipped: true } | { error: true, status: number }>}
 */
export async function sendEmail({ to, subject, html, text, tag }) {
  if (!isEnabled()) {
    console.warn("[resend] skipped (no RESEND_API_KEY):", tag, "->", to);
    return { skipped: true };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromAddress(), to, subject, html, text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        "[resend] FAILED",
        tag,
        "->",
        to,
        redact(`${res.status} ${body}`).slice(0, 500),
      );
      return { error: true, status: res.status };
    }

    const data = await res.json().catch(() => ({}));
    return { id: data && data.id };
  } catch (e) {
    console.error(
      "[resend] FAILED",
      tag,
      "->",
      to,
      redact((e && e.message) || String(e)),
    );
    return { error: true, status: 0 };
  }
}

/**
 * Fan sendEmail() out over a list. Never rejects.
 *
 * @param {Array<Parameters<typeof sendEmail>[0]>} list
 * @returns {Promise<{ sent: number, skipped: number, failed: number }>}
 */
export async function sendMany(list) {
  const results = await Promise.allSettled(
    (list || []).map((msg) => sendEmail(msg)),
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") {
      failed += 1;
      continue;
    }
    const v = r.value || {};
    if (v.skipped) skipped += 1;
    else if (v.error) failed += 1;
    else sent += 1;
  }

  console.log("[resend] sendMany:", { sent, skipped, failed });
  return { sent, skipped, failed };
}
