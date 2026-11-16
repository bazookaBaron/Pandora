/**
 * Forward human (recruiter) mail that reached an apply alias to the user's
 * real contact_email through Resend. Never throws.
 *   From:     "<from_name or from> via Vloombox" <relay@AA_MAIL_DOMAIN>
 *   Reply-To: the original sender (or the mail's own reply_to)
 */
const clean = (s) => String(s || "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
const esc = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function buildForward({ payload, contactEmail, domain }) {
  const p = payload || {};
  const sender = String(p.from || "").trim();
  const name = clean(p.from_name) || clean(sender) || "Recruiter";
  const replyTo = [p.reply_to, sender].map((x) => String(x || "").trim()).find((x) => EMAIL_RE.test(x)) || undefined;
  const subject = String(p.subject || "(no subject)").replace(/[\r\n]+/g, " ").slice(0, 300);
  const excerpt = String(p.text_excerpt || "");
  const note = `Forwarded by Vloombox AutoApply. This message was sent to your apply address (${p.to || ""}). Reply directly to answer ${sender || "the sender"}.`;
  return {
    to: contactEmail,
    from: `"${name} via Vloombox" <relay@${domain}>`,
    replyTo,
    subject,
    text: `${excerpt}\n\n--\n${note}`,
    html: `<div style="white-space:pre-wrap;font-family:system-ui,sans-serif">${esc(excerpt)}</div><hr><p style="color:#666;font-size:12px">${esc(note)}</p>`,
    tag: "autoapply-forward",
  };
}

export async function forwardHumanMail({ db, resend, payload, event, profile, domain = process.env.AA_MAIL_DOMAIN || "apply.vloombox.in" }) {
  try {
    if (!payload || payload.is_human !== true || !profile || !profile.contact_email) return { skipped: true };
    if (!EMAIL_RE.test(String(profile.contact_email))) return { skipped: true };
    const msg = buildForward({ payload, contactEmail: profile.contact_email, domain });
    const r = await resend.sendEmail(msg);
    if (r && r.id) {
      await db.from("aa_mail_events").update({ forwarded_at: new Date().toISOString() }).eq("id", event.id);
      return { forwarded: true };
    }
    return { forwarded: false };
  } catch (e) {
    console.error("[autoapply/forward]", (e && e.message) || String(e));
    return { forwarded: false };
  }
}
