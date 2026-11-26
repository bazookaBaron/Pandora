// ── Copy glossary (WS-M0) ───────────────────────────────────────────
// One term per concept, everywhere. Pages import these instead of typing their
// own words, so "Pack" is never "Batch" on another screen.
// Rules (plan §5): class-8 reading level, <= 12 words per sentence, benefit
// first, numbers over adjectives, buttons are verbs.
//
//   import { TERMS, GLOSSARY, CTA } from '../lib/copy'
//   <h2>{TERMS.pack.plural}</h2>         -> "Packs"
//   <HelpChip term="pack" />             -> opens GLOSSARY.pack
//
// Old internal words that must NOT appear on screen any more (left: old, right: use):
//   Batch -> Pack · Needs you -> Answers needed · Accounts -> Job portal logins
//   Not applied -> Skipped · Stats -> Results · LLD -> Low-level design · HLD -> System design

/** Plain on-screen names. `one` / `plural` where both forms are used. */
export const TERMS = {
    pack: { one: 'Pack', plural: 'Packs' },
    answersNeeded: { one: 'Answers needed', plural: 'Answers needed' },
    portalLogins: { one: 'Job portal login', plural: 'Job portal logins' },
    skipped: { one: 'Skipped', plural: 'Skipped' },
    applied: { one: 'Applied', plural: 'Applied' },
    results: { one: 'Results', plural: 'Results' },
    inbox: { one: 'Inbox', plural: 'Inbox' },
    lld: { one: 'Low-level design', plural: 'Low-level design' },
    hld: { one: 'System design', plural: 'System design' },
    dsa: { one: 'DSA', plural: 'DSA' },
    interviewQuestions: { one: 'Interview questions', plural: 'Interview questions' },
    resumeCheck: { one: 'Resume check', plural: 'Resume check' },
    referral: { one: 'Referral', plural: 'Referrals' },
    plan: { one: 'Plan', plural: 'Plans' },
    matchCount: { one: 'matching job', plural: 'matching jobs' },
}

/** Common button labels (verbs). */
export const CTA = {
    seeJobs: 'See jobs',
    seePacks: 'See packs',
    getStarted: 'Get started',
    answerNow: 'Answer now',
    continue: 'Continue',
    back: 'Back',
    apply: 'Apply',
    signIn: 'Sign in',
    askReferral: 'Ask for a referral',
    startPractice: 'Start practising',
    checkResume: 'Check my resume',
    done: 'Done',
    close: 'Close',
    notNow: 'Not now',
}

/**
 * Short 2-line explanations, shown by <HelpChip term="…">.
 * Each: { term, short } — `short` is at most 2 short sentences.
 */
export const GLOSSARY = {
    pack: {
        term: 'Pack',
        short: 'A pack is a set of job applications you buy, like 50 or 100. We find matching jobs and apply to them for you.',
    },
    answersNeeded: {
        term: 'Answers needed',
        short: 'Some job forms ask questions we cannot answer for you. Answer them here and we keep applying.',
    },
    portalLogins: {
        term: 'Job portal logins',
        short: 'Some company sites need an account to apply. We save the login we create so you can sign in later.',
    },
    skipped: {
        term: 'Skipped',
        short: 'We did not apply to this job. The reason is shown, for example the job closed or did not match.',
    },
    results: {
        term: 'Results',
        short: 'How your applications are doing: how many we sent, replies and interviews.',
    },
    matchCount: {
        term: 'Matching jobs',
        short: 'Open jobs that fit your role, experience and location right now. The number changes every day.',
    },
    dsa: {
        term: 'DSA',
        short: 'Data structures and algorithms. These are the coding questions asked in most tech interviews.',
    },
    lld: {
        term: 'Low-level design',
        short: 'Design the classes and code for one feature, like a parking lot. Often called LLD.',
    },
    hld: {
        term: 'System design',
        short: 'Design a whole system, like a chat app, with servers and databases. Often called HLD.',
    },
    referral: {
        term: 'Referral',
        short: 'An employee recommends you for a job at their company. Referred people get more interviews.',
    },
    resumeCheck: {
        term: 'Resume check',
        short: 'Paste a job post and we tailor and score your resume for it.',
    },
    plan: {
        term: 'Plan',
        short: 'Free works for most things. Pro and Max unlock more practice, AI help and Auto Apply.',
    },
}

/** Glossary entry by key; undefined when the key is unknown. */
export const glossary = (key) => GLOSSARY[key]
