// Avatar helpers shared by Navbar and the Profile page (were copied in both).
//
//   getInitials(user)            -> 'AM'   (Supabase user: full_name / name / email local part)
//   getInitials('Ada Lovelace')  -> 'AL'   (a plain string works too)
//   stringToColor(user.email)    -> stable background colour for the initials tile
//
// The palette is identity colour (same email -> same colour, unchanged from the
// old copies), not a semantic tone, so it stays a fixed hex list. Use white text on it.

export const AVATAR_COLORS = ['#22d3ee', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#60a5fa']

export function getInitials(userOrName) {
    const name = typeof userOrName === 'string'
        ? userOrName
        : (userOrName?.user_metadata?.full_name ||
            userOrName?.user_metadata?.name ||
            userOrName?.email?.split('@')[0] ||
            'U')
    const parts = String(name || 'U').split(' ').filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return (parts[0] || 'U').slice(0, 2).toUpperCase()
}

export function stringToColor(str = '') {
    const s = String(str || '')
    let hash = 0
    for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash)
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
