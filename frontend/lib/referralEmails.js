/**
 * Pure email-content builders for the referral feature.
 *
 * NO transport here — services/resend.js does the sending. Each builder returns
 * `{ subject, html, text }`.
 *
 * Privacy:
 *   • referralRequestCreated() fans out to many co-workers → it carries NO
 *     names, NO emails and NO resume content, only the coarse job/poster info.
 *   • referralAccepted() goes to one person (the poster) and DELIBERATELY
 *     includes the accepter's email — handing that over is the whole point.
 */

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Shared email layout ──────────────────────────────────────────────
// Email clients strip <style> blocks and most modern CSS, so everything is
// table-based with inline styles. Colours mirror the site's dark theme
// (src/index.css: zinc surfaces, --pop cyan accent).
const C = {
  page: "#09090b",
  card: "#18181b",
  cardInner: "#1f1f23",
  border: "#27272a",
  text: "#e4e4e7",
  bright: "#fafafa",
  muted: "#a1a1aa",
  faint: "#71717a",
  pop: "#22d3ee",
  popDim: "#0e3a42",
};
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Wrap body HTML in the branded shell: hidden preheader, wordmark header,
 * content card, footer.
 *
 * @param {{ preheader?: string, body: string, footer?: string }} args
 */
function layout({ preheader = "", body, footer = "" }) {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">' +
    "<title>Vloombox</title></head>" +
    `<body style="margin:0;padding:0;background:${C.page};">` +
    // Preheader: the grey preview line shown next to the subject in inboxes.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">` +
    '<tr><td align="center" style="padding:32px 16px;">' +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT};">` +
    // Header: wordmark
    '<tr><td style="padding:0 4px 20px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    `<td style="width:28px;height:28px;background:${C.pop};border-radius:8px;text-align:center;vertical-align:middle;` +
    `font-size:16px;font-weight:900;color:${C.page};line-height:28px;">V</td>` +
    `<td style="padding-left:10px;font-size:17px;font-weight:800;letter-spacing:-0.02em;color:${C.bright};">Vloombox</td>` +
    "</tr></table></td></tr>" +
    // Card
    `<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:28px 24px;">` +
    body +
    "</td></tr>" +
    // Footer
    `<tr><td style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:${C.faint};text-align:center;">` +
    footer +
    `<div style="margin-top:8px;">© ${new Date().getUTCFullYear()} Vloombox · Interview prep, jobs &amp; referrals</div>` +
    "</td></tr>" +
    "</table></td></tr></table></body></html>"
  );
}

function eyebrow(text) {
  return (
    `<div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;` +
    `color:${C.pop};margin:0 0 10px;">${esc(text)}</div>`
  );
}

function h1(text) {
  return `<h1 style="font-size:22px;line-height:1.3;margin:0 0 12px;color:${C.bright};font-weight:800;letter-spacing:-0.02em;">${esc(
    text,
  )}</h1>`;
}

function p(html) {
  return `<p style="margin:0 0 10px;font-size:14px;line-height:1.65;color:${C.text};">${html}</p>`;
}

function button(href, label) {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr>' +
    `<td style="background:${C.pop};border-radius:8px;">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;` +
    `color:${C.page};text-decoration:none;font-family:${FONT};">${esc(label)}</a>` +
    "</td></tr></table>"
  );
}

function chip(text) {
  return (
    `<span style="display:inline-block;margin:6px 6px 0 0;padding:3px 9px;border-radius:999px;` +
    `background:${C.popDim};color:${C.pop};font-size:11px;font-weight:600;">${esc(text)}</span>`
  );
}

/**
 * Notify a co-worker that someone at their company wants a referral.
 * No PII: no names, no emails, no resume.
 *
 * @param {{ jobTitle?: string|null, jobId?: string|null,
 *           posterPosition?: string|null, posterYoe?: number|string|null,
 *           requestUrl: string }} args
 */
export function referralRequestCreated({
  jobTitle,
  jobId,
  posterPosition,
  posterYoe,
  requestUrl,
}) {
  const subject = "New referral request at your company";

  const title = jobTitle ? String(jobTitle).trim() : "";
  const jid = jobId != null && String(jobId).trim() !== "" ? String(jobId).trim() : "";
  const pos = posterPosition ? String(posterPosition).trim() : "";
  const yoe =
    posterYoe != null && String(posterYoe).trim() !== ""
      ? `${String(posterYoe).trim()} yrs experience`
      : "";

  const postedBy = pos
    ? `Posted by a ${pos}${yoe ? `, ${yoe}` : ""}`
    : `Posted by someone at your company${yoe ? `, ${yoe}` : ""}`;

  const lines = [];
  lines.push(title ? `Role: ${title}` : "A colleague is looking for a referral.");
  if (jid) lines.push(`Job ID: ${jid}`);
  lines.push(postedBy);

  const text = `${subject}\n\n${lines.join("\n")}\n\nReview the request: ${requestUrl}\n`;

  const html = layout({
    preheader: title ? `Someone at your company wants a referral for ${title}` : subject,
    body:
      eyebrow("Referral request") +
      h1(subject) +
      lines.map((l) => p(esc(l))).join("") +
      button(requestUrl, "Review request"),
    footer: "You receive these because referral notifications are enabled in your profile.",
  });

  return { subject, html, text };
}

// Max postings listed in one alert email; the rest are summarised with a
// link to the company's jobs page so a busy company doesn't produce a
// 300-row email.
const JOB_ALERT_MAX_LISTED = 15;

/**
 * Batched job alert for a company subscription. One email per subscriber per
 * company with new postings (see server.js: sendCompanySubscriptionDigest).
 * No unsubscribe token — this is an opted-in alert for a paid feature; the
 * email points back to the Profile page, where the subscription is removed.
 *
 * @param {{ companyName: string,
 *           newJobs: Array<{ title: string, url: string, location?: string|null,
 *                             seniority?: string|null }>,
 *           companyUrl?: string|null,
 *           manageUrl: string }} args
 */
export function companyJobAlertEmail({ companyName, newJobs, companyUrl, manageUrl }) {
  const jobs = Array.isArray(newJobs) ? newJobs : [];
  const count = jobs.length;
  const listed = jobs.slice(0, JOB_ALERT_MAX_LISTED);
  const more = count - listed.length;
  const roles = `${count} new role${count === 1 ? "" : "s"}`;
  const subject = `${roles} at ${companyName}`;
  const allUrl = companyUrl || manageUrl;

  const jobLine = (j) => {
    const meta = [j.location, j.seniority].filter(Boolean).join(" · ");
    return meta ? `• ${j.title} (${meta})\n  ${j.url}` : `• ${j.title}\n  ${j.url}`;
  };

  const text =
    `${subject}\n\n` +
    listed.map(jobLine).join("\n\n") +
    (more > 0 ? `\n\n…and ${more} more: ${allUrl}` : "") +
    `\n\nManage your job alerts: ${manageUrl}\n`;

  const jobCard = (j) => {
    const chips = [j.location, j.seniority && cap(j.seniority)].filter(Boolean).map(chip).join("");
    return (
      '<tr><td style="padding:0 0 10px;">' +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
      `style="background:${C.cardInner};border:1px solid ${C.border};border-radius:10px;">` +
      '<tr><td style="padding:14px 16px;">' +
      `<a href="${esc(j.url)}" style="font-size:15px;line-height:1.4;font-weight:700;color:${C.bright};text-decoration:none;">${esc(
        j.title,
      )}</a>` +
      (chips ? `<div>${chips}</div>` : "") +
      `<div style="margin-top:10px;"><a href="${esc(j.url)}" style="font-size:13px;font-weight:700;color:${C.pop};text-decoration:none;">View job &rarr;</a></div>` +
      "</td></tr></table>" +
      "</td></tr>"
    );
  };

  const html = layout({
    preheader: listed[0] ? `${listed[0].title}${count > 1 ? ` and ${count - 1} more` : ""}` : subject,
    body:
      eyebrow("Job alert") +
      h1(subject) +
      p(
        `Fresh openings at <strong style="color:${C.bright};">${esc(companyName)}</strong>, ` +
          "a company you're following. Apply early: new postings fill fast.",
      ) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">' +
      listed.map(jobCard).join("") +
      "</table>" +
      (more > 0
        ? p(`<span style="color:${C.muted};">…and ${more} more new role${more === 1 ? "" : "s"}.</span>`)
        : "") +
      button(allUrl, companyUrl ? `See all ${companyName} jobs` : "Open Vloombox"),
    footer:
      `You're getting this because you follow ${esc(companyName)} on Vloombox. ` +
      `<a href="${esc(manageUrl)}" style="color:${C.muted};text-decoration:underline;">Manage job alerts</a>`,
  });

  return { subject, html, text };
}

function cap(s) {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Tell the poster that someone accepted their referral request. Includes the
 * accepter's email on purpose.
 *
 * @param {{ accepterName?: string|null, accepterEmail: string, company: string }} args
 */
export function referralAccepted({ accepterName, accepterEmail, company }) {
  const name = accepterName ? String(accepterName).trim() : "Someone";
  const subject = `${name} accepted your referral request`;

  const sentence =
    `${name} has accepted to help with your referral to ${company}. ` +
    `If you haven't received the referral yet, reach out directly: ${accepterEmail}.`;

  const text = `${subject}\n\n${sentence}\n`;

  const html = layout({
    preheader: `Good news: your referral to ${company} has a taker`,
    body:
      eyebrow("Referral accepted") +
      h1(subject) +
      p(
        `${esc(name)} has accepted to help with your referral to ` +
          `<strong style="color:${C.bright};">${esc(company)}</strong>. ` +
          "If you haven't received the referral yet, reach out directly: " +
          `<a href="mailto:${esc(accepterEmail)}" style="color:${C.pop};">${esc(
            accepterEmail,
          )}</a>.`,
      ),
  });

  return { subject, html, text };
}
