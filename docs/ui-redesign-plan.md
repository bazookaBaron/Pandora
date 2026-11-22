# UI redesign plan: minimal, production-style

## Problem
- Three 48px full-width tab blocks (Jobs / Auto Apply / Referrals) in a second fixed row; nav is 120px tall.
- Monospace everywhere, UPPERCASE 0.7rem labels, scanline texture, cyan glow, pink + cyan + violet accents, chunky filled pills.
- Controls are tiles / segmented strips / sliders where a dropdown would do. Many inline styles per page.

## Design direction
- Neutral zinc palette, ONE accent (indigo-blue). Semantic green / red / amber only for status. No scanlines, no glow, no heavy shadows.
- 4/8px spacing scale (--sp-*), type scale 12/14/16/20/24/32 (--fs-*), system sans (mono only for code).
- 1px borders, radius 6px (cards 8px), controls 32-36px (--ctl-h), content max width 1120px.
- Tokens in index.css (:root dark + [data-theme=light]); legacy token names (--pop, --warm, --subtle...) stay as aliases so every page re-themes without markup churn.

## Shared components
- Navbar: single 56px bar: brand | text tabs (Jobs, Auto Apply, Referrals) with 2px active underline | Prep dropdown, theme, profile. Mobile: brand + hamburger; the menu holds the tabs, Prep, profile. The second tab row is removed (--nav-h = 56px).
- Layout.jsx: PageHeader (24px title, 14px muted subtitle), Section/Card flat 8px, FilterBar compact, StatChip inline. New `Menu` (dropdown actions).
- Buttons: .primary-btn/.secondary-btn/.aa-btn/.nav-pill share 32-36px height, sentence case, no uppercase, no glow. Inputs 36px.

## Per page
- Jobs: Listings/Analytics as underline tabs; filters become one search row plus one row of compact selects (work mode, company type, level, posted, source, sort) replacing the two segmented strips. Job rows stay compact lists.
- Market Analytics: inherits cards/stat tokens; sentence-case section titles.
- Auto Apply Overview: pipeline cards compact; batches as a compact list grouped Ongoing/Completed.
- Auto Apply Buy: kind / pack size / window days become three selects in one card (slider replaced with a days select); must-apply and supply panels below; summary row with Pay.
- Auto Apply Batch detail: primary action + "More" dropdown (pause / cancel) instead of 3-4 buttons; status filter select stays; compact table rows.
- Auto Apply Setup / onboarding: stepper becomes a compact underline stepper; on mobile a select of steps. 36px inputs.
- Auto Apply Inbox / Account / Stats: sub-nav is underline text tabs, restyled; pill tabs lighter.
- Referrals: tabs become underline tabs; flat cards.
- Prep (DSA/LLD/HLD/Interview) and Auth: inherit tokens, inputs and buttons; no markup change.

## Out of scope
Behaviour, routes, data hooks and API calls are untouched; only markup and CSS.
