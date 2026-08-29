import { useSyncExternalStore } from 'react'

// ── Subscription tier ────────────────────────────────────────────────
// Resolution priority:
//   1. import.meta.env.VITE_FORCE_TIER   — deploy-time hard override ('free' | 'pro')
//   2. localStorage 'tier'               — runtime switch, no rebuild (dev / preview)
//   3. import.meta.env.VITE_DEFAULT_TIER — project default ('pro' if unset)
//
// SWITCHING (to preview the paywalled/free-tier UI):
//   • Profile page → "Preview tier" toggle
//   • DevTools console:  __setTier('free')   /   __setTier('pro')
//   • localStorage.setItem('tier', 'free') then reload
//
// When the real payment gateway lands, replace `readRemoteTier()` below with a
// lookup of the user's subscription (e.g. a `profiles.tier` column or Stripe
// customer metadata) and give it priority just under VITE_FORCE_TIER.

const KEY = 'tier'
const VALID = new Set(['free', 'pro'])

const FORCED = import.meta.env.VITE_FORCE_TIER
const DEFAULT_TIER = VALID.has(import.meta.env.VITE_DEFAULT_TIER)
    ? import.meta.env.VITE_DEFAULT_TIER
    : 'pro'

export const TIER_LIMITS = {
    free: { dsa: 5, lld: 3, hld: 3, resumeOptimizer: false, pagination: false },
    pro: { dsa: Infinity, lld: Infinity, hld: Infinity, resumeOptimizer: true, pagination: true },
}

function readTier() {
    if (VALID.has(FORCED)) return FORCED
    try {
        const v = localStorage.getItem(KEY)
        if (VALID.has(v)) return v
    } catch { /* storage unavailable */ }
    return DEFAULT_TIER
}

// ── tiny external store so every consumer re-renders on setTier ──────
const listeners = new Set()
const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb) }
const emit = () => listeners.forEach((cb) => cb())

export function setTier(tier) {
    if (!VALID.has(tier)) return
    try { localStorage.setItem(KEY, tier) } catch { /* ignore */ }
    emit()
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => { if (e.key === KEY) emit() })
    // dev convenience
    window.__setTier = setTier
}

export function useTier() {
    const tier = useSyncExternalStore(subscribe, readTier, () => DEFAULT_TIER)
    return {
        tier,
        limits: TIER_LIMITS[tier],
        isFree: tier === 'free',
        isPro: tier === 'pro',
        setTier,
        forced: VALID.has(FORCED),
    }
}
