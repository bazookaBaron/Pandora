// Single source of truth for "what Vloombox is" copy. Imported by the About,
// Contact, FAQ, legal and footer pages so the description stays consistent.

export const VLOOMBOX_TAGLINE =
    'Everything you need to prepare for your next software or data interview — in one place.'

// One or two sentences. Footer, page intros, meta descriptions.
export const VLOOMBOX_BLURB =
    'Vloombox is an all-in-one interview-prep platform: practise data structures & algorithms, ' +
    'low-level and high-level system design, and curated interview questions; tailor your résumé ' +
    'to a specific job with AI; browse a continuously refreshed jobs board; and request referrals ' +
    'from people already working at your target company.'

// Longer form for the About page — an array of paragraphs.
export const VLOOMBOX_ABOUT = [
    'Vloombox started from a simple frustration: interview preparation is scattered across a dozen ' +
    'tools. One site for algorithms, another for system design, a separate tab for company research, ' +
    'a spreadsheet of job links, and a group chat where you ask around for referrals. Vloombox pulls ' +
    'all of it into a single workspace.',

    'Inside you get structured practice for data structures & algorithms, low-level (class) design ' +
    'and high-level (system) design, a growing bank of real interview questions grouped by topic, and ' +
    'an AI résumé optimiser that rewrites and scores your résumé against a specific job description. ' +
    'A jobs board aggregates fresh openings from hundreds of companies, and a referral board lets you ' +
    'ask people already inside a company to refer you — or refer others when you are the one on the inside.',
]

// What each area of the product does — used on the About page.
export const VLOOMBOX_FEATURES = [
    ['DSA practice', 'Data-structures & algorithms problems, filterable by company.'],
    ['Low-level design', 'Class-design problems with a paired diagram and code workspace.'],
    ['High-level design', 'System-design problems on a canvas, with an AI review of your design.'],
    ['Interview questions', 'Curated questions grouped by topic and difficulty.'],
    ['Résumé optimiser', 'AI tailoring and scoring of your résumé against a job description.'],
    ['Jobs board', 'Fresh tech openings aggregated from ~500 companies, refreshed through the day.'],
    ['Referral board', 'Request a referral for a target company, or give one when people target yours.'],
]
