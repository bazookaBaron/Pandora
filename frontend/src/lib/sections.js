// ── Sections (WS-M0) ────────────────────────────────────────────────
// The 5 top-level sections of the site. ONE source of truth for the bottom tab
// bar, the desktop top bar, PageHeader tones, the Prepare hub and the
// first-visit picker. Section ids are stable API: do not rename them.
//
//   import { SECTIONS, sectionFor, getSection } from '../lib/sections'
//   sectionFor('/dsa/company/google')  -> SECTIONS.prepare
//   getSection('autoapply').tone        -> 'var(--pop)'
//
// tone      -> a CSS colour (existing brand token) for strips, active tabs, primary buttons
// toneDim   -> the matching soft background (color-mix of the tone, no new colours)
// icon      -> lucide-react export name (components import the icon by this name)
// prefixes  -> route prefixes owned by the section ('/' matches only '/')

// Shown once VITE_AUTOAPPLY=1 at build time; the /autoapply pages still work by direct link.
export const AUTOAPPLY_ENABLED = import.meta.env.VITE_AUTOAPPLY === '1'

const dim = (token) => `color-mix(in srgb, ${token} 12%, transparent)`

export const SECTIONS = {
    jobs: {
        id: 'jobs',
        tab: 'Jobs',
        name: 'Find jobs',
        title: 'Find jobs',
        subtitle: 'Fresh tech jobs, updated every day',
        icon: 'Briefcase',
        tone: 'var(--accent)',
        toneDim: dim('var(--accent)'),
        to: '/',
        prefixes: ['/', '/jobs'],
    },
    prepare: {
        id: 'prepare',
        tab: 'Prepare',
        name: 'Prepare for interviews',
        title: 'Prepare for interviews',
        subtitle: 'DSA, design and interview questions',
        icon: 'BookOpen',
        tone: 'var(--green)',
        toneDim: dim('var(--green)'),
        to: '/prepare',
        prefixes: ['/prepare', '/dsa', '/lld', '/hld', '/interview', '/questions', '/optimizer'],
    },
    autoapply: {
        id: 'autoapply',
        tab: 'Auto Apply',
        name: 'We apply for you',
        title: 'We apply for you',
        subtitle: 'Pick a pack. We apply to jobs for you.',
        icon: 'Zap',
        tone: 'var(--pop)',
        toneDim: dim('var(--pop)'),
        to: '/autoapply',
        prefixes: ['/autoapply'],
    },
    referrals: {
        id: 'referrals',
        tab: 'Referrals',
        name: 'Get referred',
        title: 'Get referred',
        subtitle: 'Ask employees at your target company',
        icon: 'Users',
        tone: 'var(--warm)',
        toneDim: dim('var(--warm)'),
        to: '/referrals',
        prefixes: ['/referrals'],
    },
    me: {
        id: 'me',
        tab: 'Me',
        name: 'Account',
        title: 'Account',
        subtitle: 'Your profile, plan and settings',
        icon: 'User',
        tone: 'var(--muted)',
        toneDim: dim('var(--muted)'),
        to: '/profile',
        prefixes: [
            '/profile', '/pricing', '/auth', '/about', '/faq', '/legal', '/terms', '/privacy',
            '/refunds', '/contact', '/blog', '/subscription', '/dashboard',
        ],
    },
}

/** Section ids in tab order. Auto Apply drops out when the build flag is off (4 tabs). */
export const SECTION_ORDER = ['jobs', 'prepare', ...(AUTOAPPLY_ENABLED ? ['autoapply'] : []), 'referrals', 'me']

/** Sections in tab order (respects VITE_AUTOAPPLY). */
export const NAV_SECTIONS = SECTION_ORDER.map((id) => SECTIONS[id])

/** Section by id; unknown ids fall back to jobs. */
export const getSection = (id) => SECTIONS[id] || SECTIONS.jobs

function matches(prefix, pathname) {
    if (prefix === '/') return pathname === '/'
    return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * Section that owns a pathname (longest matching prefix wins). Unknown paths -> jobs
 * (the home page is the job board). Auto Apply paths still map to 'autoapply' when
 * the flag is off, so a direct link keeps its tone.
 */
export function sectionFor(pathname = '/') {
    const p = String(pathname || '/').split(/[?#]/)[0] || '/'
    let best = null
    let bestLen = -1
    for (const s of Object.values(SECTIONS)) {
        for (const pre of s.prefixes) {
            if (matches(pre, p) && pre.length > bestLen) { best = s; bestLen = pre.length }
        }
    }
    return best || SECTIONS.jobs
}

/** Full-height editor screens (LLD / HLD workspaces): no bottom bar on phones, more room for the editor. */
export const isWorkspacePath = (pathname = '') => /^\/(lld|hld)\/[^/]+/.test(pathname)

/** Where the Me tab goes: profile when signed in, sign-in page when not. */
export const meTarget = (signedIn) => (signedIn ? '/profile' : '/auth')
