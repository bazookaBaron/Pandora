import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const required = [
  "GSC_SERVICE_ACCOUNT_EMAIL",
  "GSC_PRIVATE_KEY",
  "GSC_SITE_URL",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const email = process.env.GSC_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GSC_PRIVATE_KEY.replace(/\\n/g, "\n");
const siteUrl = process.env.GSC_SITE_URL;
const outputPath = process.env.GSC_REPORT_PATH || "gsc-report.json";

function b64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const assertion = `${unsigned}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Google OAuth failed (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function querySearchAnalytics(token, body) {
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Search Console query failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

function cleanRows(rows = [], dimensions = []) {
  return rows.map((row) => ({
    ...Object.fromEntries(dimensions.map((dim, i) => [dim, row.keys?.[i] ?? null])),
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

async function main() {
  // GSC data is not real-time. A 3-day lag avoids producing misleading empty reports.
  const endDate = isoDate(daysAgo(3));
  const startDate = isoDate(daysAgo(30));
  const token = await getAccessToken();

  const base = {
    startDate,
    endDate,
    dataState: "final",
    rowLimit: 1000,
  };

  const [daily, queries, pages, queryPages, countries, devices] = await Promise.all([
    querySearchAnalytics(token, { ...base, dimensions: ["date"] }),
    querySearchAnalytics(token, { ...base, dimensions: ["query"] }),
    querySearchAnalytics(token, { ...base, dimensions: ["page"] }),
    querySearchAnalytics(token, { ...base, dimensions: ["query", "page"] }),
    querySearchAnalytics(token, { ...base, dimensions: ["country"] }),
    querySearchAnalytics(token, { ...base, dimensions: ["device"] }),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    siteUrl,
    period: { startDate, endDate, lagDays: 3 },
    daily: cleanRows(daily.rows, ["date"]),
    queries: cleanRows(queries.rows, ["query"]),
    pages: cleanRows(pages.rows, ["page"]),
    queryPages: cleanRows(queryPages.rows, ["query", "page"]),
    countries: cleanRows(countries.rows, ["country"]),
    devices: cleanRows(devices.rows, ["device"]),
  };

  const out = path.resolve(outputPath);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote GSC report to ${out}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
