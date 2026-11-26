/**
 * Small decorative line illustration for empty states (currentColor, 64x64 viewBox, aria-hidden).
 * Kinds: inbox, batches, accounts, search, jobs, stats, code, diagram, people, doc, lock, questions,
 *        referrals, bell, error.
 *
 *   <EmptyArt kind="search" tone="history" size={56} />
 *
 * Usually rendered for you by <EmptyState art="search" tone="…" /> (components/shared/states).
 */
const ART = {
    inbox: <><rect x="10" y="18" width="44" height="30" rx="4" /><path d="M10 34h12l4 6h12l4-6h12" /><path d="M24 12l8-6 8 6" /></>,
    batches: <><rect x="12" y="10" width="40" height="44" rx="4" /><path d="M20 22h24M20 30h24M20 38h14" /><circle cx="46" cy="44" r="7" /><path d="M43 44l2 2 4-4" /></>,
    accounts: <><rect x="14" y="26" width="36" height="26" rx="4" /><path d="M22 26v-6a10 10 0 0 1 20 0v6" /><circle cx="32" cy="38" r="3" /><path d="M32 41v4" /></>,
    search: <><circle cx="28" cy="28" r="13" /><path d="M38 38l12 12" /><path d="M22 28h12" /></>,
    jobs: <><rect x="10" y="20" width="44" height="30" rx="4" /><path d="M24 20v-5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5" /><path d="M10 32h44" /></>,
    stats: <><path d="M12 52h40" /><rect x="16" y="34" width="7" height="14" rx="1" /><rect x="29" y="24" width="7" height="24" rx="1" /><rect x="42" y="14" width="7" height="34" rx="1" /></>,
    code: <><rect x="8" y="12" width="48" height="40" rx="4" /><path d="M8 22h48" /><path d="M26 32l-6 6 6 6" /><path d="M38 32l6 6-6 6" /></>,
    diagram: <><rect x="8" y="10" width="18" height="14" rx="3" /><rect x="38" y="10" width="18" height="14" rx="3" /><rect x="23" y="40" width="18" height="14" rx="3" /><path d="M17 24v6h30v-6" /><path d="M32 30v10" /></>,
    people: <><circle cx="24" cy="24" r="7" /><path d="M11 50a13 13 0 0 1 26 0" /><circle cx="43" cy="26" r="5" /><path d="M38 40a10 10 0 0 1 15 10" /></>,
    doc: <><path d="M18 8h20l10 10v38H18z" /><path d="M38 8v10h10" /><path d="M25 30h16M25 38h16M25 46h10" /></>,
    lock: <><rect x="14" y="28" width="36" height="26" rx="4" /><path d="M22 28v-8a10 10 0 0 1 20 0v8" /><circle cx="32" cy="40" r="3" /><path d="M32 43v4" /></>,
    questions: <><path d="M10 14h32v22H24l-8 7v-7h-6z" /><path d="M22 21a4 4 0 1 1 5 4v2" /><path d="M27 31v.5" /><path d="M46 26h8v20h-5v6l-7-6H30v-6" /></>,
    referrals: <><circle cx="18" cy="22" r="7" /><circle cx="46" cy="22" r="7" /><path d="M6 48a12 12 0 0 1 24 0" /><path d="M34 48a12 12 0 0 1 24 0" /><path d="M27 22h10" /><path d="M33 18l4 4-4 4" /></>,
    bell: <><path d="M20 42V28a12 12 0 0 1 24 0v14l4 5H16z" /><path d="M28 52a4 4 0 0 0 8 0" /></>,
    error: <><path d="M32 10l24 42H8z" /><path d="M32 26v12" /><path d="M32 44v.5" /></>,
}

export const EMPTY_ART_KINDS = Object.keys(ART)

export default function EmptyArt({ kind = 'search', tone = 'history', size = 56, className = '' }) {
    return (
        <span className={`sys-empty-art tone-${tone} ${className}`.trim()} aria-hidden="true">
            <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                {ART[kind] || ART.search}
            </svg>
        </span>
    )
}
