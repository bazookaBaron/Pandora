import { BookOpen, Briefcase, User, Users, Zap } from 'lucide-react'

// lucide components for the section `icon` names in lib/sections.js.
// Imported by name (not `import * as`) so only these 5 icons ship.
export const SECTION_ICONS = { Briefcase, BookOpen, Zap, Users, User }

/** lucide component for a section object or icon name (falls back to Briefcase). */
export function sectionIcon(sectionOrName) {
    const name = typeof sectionOrName === 'string' ? sectionOrName : sectionOrName?.icon
    return SECTION_ICONS[name] || Briefcase
}
