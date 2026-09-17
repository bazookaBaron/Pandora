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

const WRAP_OPEN =
  '<div style="background:#0b0b0c;color:#e5e5e5;' +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  'padding:32px 24px;">' +
  '<div style="max-width:520px;margin:0 auto;">';
const WRAP_CLOSE = "</div></div>";

function h1(text) {
  return `<h1 style="font-size:18px;line-height:1.3;margin:0 0 16px;color:#ffffff;">${esc(
    text,
  )}</h1>`;
}

function p(html) {
  return `<p style="margin:6px 0;font-size:14px;line-height:1.6;color:#e5e5e5;">${html}</p>`;
}

function button(href, label) {
  return (
    `<a href="${esc(href)}" style="display:inline-block;margin-top:18px;` +
    "background:#e5e5e5;color:#0b0b0c;text-decoration:none;font-weight:600;" +
    `padding:10px 18px;border-radius:6px;">${esc(label)}</a>`
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

  const html =
    WRAP_OPEN +
    h1(subject) +
    lines.map((l) => p(esc(l))).join("") +
    button(requestUrl, "Review request") +
    `<p style="margin:22px 0 0;font-size:12px;line-height:1.5;color:#8a8a8a;">` +
    "You receive these because referral notifications are enabled in your profile." +
    "</p>" +
    WRAP_CLOSE;

  return { subject, html, text };
}

/**
 * Daily batched digest for a company-subscription job alert. One email per
 * subscriber per company that has new postings in the last 24h (see
 * server.js: sendCompanySubscriptionDigest). No unsubscribe token — this is
 * an opted-in transactional alert for a paid feature; the email just points
 * back to the Profile page, where the subscription can be removed.
 *
 * @param {{ companyName: string,
 *           newJobs: Array<{ title: string, url: string, location?: string|null,
 *                             seniority?: string|null }>,
 *           manageUrl: string }} args
 */
export function companyJobAlertEmail({ companyName, newJobs, manageUrl }) {
  const jobs = Array.isArray(newJobs) ? newJobs : [];
  const count = jobs.length;
  const subject = `${count} new job${count === 1 ? "" : "s"} at ${companyName}`;

  const jobLine = (j) => {
    const meta = [j.location, j.seniority].filter(Boolean).join(" · ");
    return meta ? `${j.title} (${meta}) — ${j.url}` : `${j.title} — ${j.url}`;
  };

  const text =
    `${subject}\n\n` +
    jobs.map(jobLine).join("\n") +
    `\n\nManage your subscriptions: ${manageUrl}\n`;

  const jobRow = (j) => {
    const meta = [j.location, j.seniority].filter(Boolean).join(" · ");
    return (
      `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);">` +
      `<a href="${esc(j.url)}" style="color:#ffffff;font-weight:700;text-decoration:none;font-size:14px;">${esc(
        j.title,
      )}</a>` +
      (meta
        ? `<div style="color:#a1a1aa;font-size:12px;margin-top:2px;">${esc(meta)}</div>`
        : "") +
      `</div>`
    );
  };

  const html =
    WRAP_OPEN +
    h1(subject) +
    p(`New postings at <strong style="color:#ffffff;">${esc(companyName)}</strong> since your last digest:`) +
    `<div style="margin-top:10px;">${jobs.map(jobRow).join("")}</div>` +
    button(manageUrl, "Manage subscriptions") +
    `<p style="margin:22px 0 0;font-size:12px;line-height:1.5;color:#8a8a8a;">` +
    "You receive this once every 24 hours because you subscribed to job alerts for this company. " +
    `Manage or stop these emails any time from your <a href="${esc(manageUrl)}" style="color:#8a8a8a;">Profile page</a>.` +
    "</p>" +
    WRAP_CLOSE;

  return { subject, html, text };
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

  const html =
    WRAP_OPEN +
    h1(subject) +
    p(
      `${esc(name)} has accepted to help with your referral to ` +
        `<strong style="color:#ffffff;">${esc(company)}</strong>. ` +
        "If you haven't received the referral yet, reach out directly: " +
        `<a href="mailto:${esc(accepterEmail)}" style="color:#ffffff;">${esc(
          accepterEmail,
        )}</a>.`,
    ) +
    WRAP_CLOSE;

  return { subject, html, text };
}
