/**
 * SEO <head> builders + route config for server-side head injection.
 *
 * Imported ONLY by server.js. Pure string builders — no HTML parser, no DOM.
 * The output is spliced into the built dist/index.html before it is sent, so
 * crawlers (and social unfurlers) see the correct title / description /
 * canonical / Open Graph / Twitter / JSON-LD in the RAW response, before any
 * JS runs.
 *
 * Only active on the Express-served (production / `npm run serve`) path. The
 * Vite dev server on :5173 serves the plain template — expected, prod is what
 * gets crawled.
 */

export const SITE = {
  name: "Vloombox",
  author: "Vloombox", // used for Article author
  twitter: "", // "@handle" if you have one, else "" (tag omitted when empty)
  defaultOgImage: "/og-default.png", // 1200x630, user adds to frontend/public/
  defaultDescription:
    "Vloombox — AI resume optimizer plus DSA, LLD, HLD and interview prep. Paste a job description and get a tailored, ATS-optimized PDF.",
};

// process.env.APP_BASE_URL (trailing slashes stripped) — else the request's
// own origin — else a localhost fallback.
export function baseUrl(req) {
  const fromEnv = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (req && typeof req.get === "function") {
    const host = req.get("host");
    if (host) return `${req.protocol}://${host}`;
  }
  return "http://localhost:3000";
}

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Serialize an object as a <script type="application/ld+json"> block, with "<"
// neutralized so a string value can never break out of the script element.
export function jsonLdScript(obj) {
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

// ── Route classification ─────────────────────────────────────────
const NOINDEX_EXACT = new Set(["/auth", "/profile", "/dashboard"]);
const NOINDEX_PREFIXES = ["/dsa", "/lld", "/hld", "/interview", "/referrals"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

// classifyRoute(pathname) -> { kind, key?, slug? }
//   kind: "public"  — a crawlable marketing/content route (key: home|pricing|blog|blogPost)
//         "noindex" — a private app route; gets robots=noindex + self canonical
//         "passthrough" — unknown; template served unchanged
export function classifyRoute(pathname) {
  const p = typeof pathname === "string" && pathname ? pathname : "/";

  // "/" now renders the Jobs section (auth-gated) — see App.jsx / task 4.
  if (p === "/") return { kind: "noindex" };
  if (p === "/optimizer") return { kind: "public", key: "home" };
  if (p === "/pricing") return { kind: "public", key: "pricing" };
  if (p === "/terms") return { kind: "public", key: "terms" };
  if (p === "/privacy") return { kind: "public", key: "privacy" };
  if (p === "/refunds") return { kind: "public", key: "refunds" };
  if (p === "/contact") return { kind: "public", key: "contact" };
  if (p === "/about") return { kind: "public", key: "about" };
  if (p === "/faq") return { kind: "public", key: "faq" };
  if (p === "/questions") return { kind: "public", key: "questions" };
  if (p === "/legal/privacy") return { kind: "public", key: "legalPrivacy" };
  if (p === "/legal/terms") return { kind: "public", key: "legalTerms" };
  if (p === "/legal/guidelines") return { kind: "public", key: "guidelines" };
  if (p === "/blog" || p === "/blog/") return { kind: "public", key: "blog" };

  if (p.startsWith("/blog/")) {
    let slug = p.slice("/blog/".length);
    try {
      slug = decodeURIComponent(slug);
    } catch {
      return { kind: "passthrough" };
    }
    if (SLUG_RE.test(slug)) return { kind: "public", key: "blogPost", slug };
    return { kind: "passthrough" };
  }

  if (NOINDEX_EXACT.has(p)) return { kind: "noindex" };
  for (const prefix of NOINDEX_PREFIXES) {
    if (p.startsWith(prefix)) return { kind: "noindex" };
  }

  return { kind: "passthrough" };
}

// ── Head-block builders ──────────────────────────────────────────

function metaTag(attr, key, value) {
  return `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
}

// Resolve the human-facing <title> + description + canonical + OG basics for a
// public route. Shared by buildHeadTags (OG/Twitter/JSON-LD) and renderIndex
// (the in-place <title> / <meta name="description"> replacement).
function routeMeta({ key, base, path, post }) {
  if (key === "home") {
    return {
      title: "Vloombox — Tailor Your Resume to Any Job with AI",
      description: SITE.defaultDescription,
      canonical: `${base}/optimizer`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "pricing") {
    return {
      title: "Pricing — Free, Pro & Max Plans | Vloombox",
      description:
        "Start free, then unlock Pro or Max for unlimited AI resume tailoring, system-design practice, and interview prep. One-time payment per term, billed in INR.",
      canonical: `${base}/pricing`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "terms") {
    return {
      title: "Terms & Conditions | Vloombox",
      description: "The terms that govern your use of Vloombox.",
      canonical: `${base}/terms`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "privacy") {
    return {
      title: "Privacy Policy | Vloombox",
      description: "What data Vloombox collects, why, and your choices.",
      canonical: `${base}/privacy`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "refunds") {
    return {
      title: "Refund & Cancellation Policy | Vloombox",
      description: "How refunds and cancellations work for Vloombox paid plans.",
      canonical: `${base}/refunds`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "contact") {
    return {
      title: "Contact & About | Vloombox",
      description: "How to reach the Vloombox team and what Vloombox is.",
      canonical: `${base}/contact`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  const staticMeta = {
    about: ["About Us | Vloombox", "About Vloombox.", "/about"],
    faq: ["FAQ | Vloombox", "Answers to common questions about Vloombox referrals and your data.", "/faq"],
    questions: ["Question Bank | Vloombox", "Curated interview questions across topics.", "/questions"],
    legalPrivacy: ["Privacy Policy | Vloombox", "Vloombox privacy policy.", "/legal/privacy"],
    legalTerms: ["Terms of Service | Vloombox", "Vloombox terms of service.", "/legal/terms"],
    guidelines: ["Community Guidelines | Vloombox", "Vloombox community guidelines.", "/legal/guidelines"],
  };
  if (staticMeta[key]) {
    const [title, description, path2] = staticMeta[key];
    return {
      title,
      description,
      canonical: `${base}${path2}`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "blog") {
    return {
      title:
        "Blog — Interview Prep, System Design & Resume Tips | Vloombox",
      description:
        "Practical guides on technical interview preparation, system design, and writing an ATS-friendly resume from the Vloombox team.",
      canonical: `${base}/blog`,
      ogType: "website",
      ogImage: base + SITE.defaultOgImage,
    };
  }
  if (key === "blogPost") {
    const p = post || {};
    return {
      title: p.meta_title || p.title || SITE.name,
      description: p.meta_description || p.excerpt || SITE.defaultDescription,
      canonical: `${base}/blog/${p.slug || ""}`,
      ogType: "article",
      ogImage: p.cover_image_url || base + SITE.defaultOgImage,
      post: p,
    };
  }
  // Unknown key — safe generic (renderIndex only calls this for known keys).
  return {
    title: SITE.name,
    description: SITE.defaultDescription,
    canonical: base + (path || "/"),
    ogType: "website",
    ogImage: base + SITE.defaultOgImage,
  };
}

// Build the newline-joined block of <link>/<meta>/<script> lines injected before
// </head> for a resolved public route. `post` is only used for key "blogPost".
export function buildHeadTags({ key, base, path, post }) {
  const m = routeMeta({ key, base, path, post });
  const lines = [];

  lines.push(`<link rel="canonical" href="${escapeHtml(m.canonical)}" />`);
  lines.push(metaTag("property", "og:type", m.ogType));
  lines.push(metaTag("property", "og:title", m.title));
  lines.push(metaTag("property", "og:description", m.description));
  lines.push(metaTag("property", "og:url", m.canonical));
  lines.push(metaTag("property", "og:site_name", SITE.name));
  lines.push(metaTag("property", "og:image", m.ogImage));
  lines.push(metaTag("name", "twitter:card", "summary_large_image"));
  lines.push(metaTag("name", "twitter:title", m.title));
  lines.push(metaTag("name", "twitter:description", m.description));
  lines.push(metaTag("name", "twitter:image", m.ogImage));
  if (SITE.twitter) {
    lines.push(metaTag("name", "twitter:site", SITE.twitter));
  }

  if (key === "blogPost") {
    const p = post || {};
    if (p.published_at) {
      lines.push(
        metaTag("property", "article:published_time", p.published_at),
      );
    }
    if (p.updated_at) {
      lines.push(metaTag("property", "article:modified_time", p.updated_at));
    }
    lines.push(
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: p.title,
        description: m.description,
        image: [m.ogImage],
        datePublished: p.published_at,
        dateModified: p.updated_at,
        author: { "@type": "Organization", name: SITE.author },
        publisher: {
          "@type": "Organization",
          name: SITE.name,
          logo: { "@type": "ImageObject", url: base + SITE.defaultOgImage },
        },
        mainEntityOfPage: m.canonical,
      }),
    );
  } else if (key === "home") {
    lines.push(
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SITE.name,
        url: `${base}/`,
      }),
    );
    lines.push(
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: SITE.name,
        url: `${base}/`,
        logo: base + SITE.defaultOgImage,
      }),
    );
  }

  return lines.join("\n");
}

// ── Full-document transform used by server.js ────────────────────
// String ops only (two anchored regexes + a "</head>" splice), never an HTML
// parser. Function replacements are used so a "$" in any interpolated text is
// treated literally.
export function renderIndex(template, { classify, base, path, post }) {
  const c = classify || { kind: "passthrough" };

  if (c.kind === "passthrough") return template;

  if (c.kind === "noindex") {
    const canonical = escapeHtml(base + (path || "/"));
    const inject =
      '<meta name="robots" content="noindex, follow" />\n' +
      `<link rel="canonical" href="${canonical}" />\n</head>`;
    return template.replace("</head>", () => inject);
  }

  // public
  const m = routeMeta({ key: c.key, base, path, post });
  const headTags = buildHeadTags({ key: c.key, base, path, post });
  const titleTag = `<title>${escapeHtml(m.title)}</title>`;
  const descTag = metaTag("name", "description", m.description);

  return template
    .replace(/<title>[\s\S]*?<\/title>/, () => titleTag)
    .replace(/<meta\s+name="description"[^>]*>/i, () => descTag)
    .replace("</head>", () => `${headTags}\n</head>`);
}
