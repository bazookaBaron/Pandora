import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { planLimits, deserializeLimit } from '../../config/tiers.js'
import { apiFetch } from './apiClient'

// ── Server-backed entitlements ──────────────────────────────────────
// Single source of truth for the current user's plan + monthly usage.
// Backed by GET /api/entitlements/me. The client is optimistic only —
// the server re-checks every gated action and is authoritative.
//
//   const { plan, limits, usage, can, isLoading } = useEntitlements()
//   can('resume_optimizer')   // metered: used < limit (Infinity-safe)
//   can('hld_catalog')        // catalog: limits.hld_catalog_access === 'full'

const FREE_LIMITS = planLimits('free')

function normalizeLimits(raw) {
    if (!raw || typeof raw !== 'object') return { ...FREE_LIMITS }
    const out = {}
    for (const [k, v] of Object.entries(raw)) out[k] = deserializeLimit(v)
    return out
}

function toNumericLimit(v) {
    if (typeof v === 'number') return v
    if (v === 'unlimited' || v === Infinity) return Infinity
    const n = Number(v)
    return Number.isNaN(n) ? 0 : n
}

export function useEntitlements() {
    const { user } = useAuth()

    const query = useQuery({
        queryKey: ['entitlements', user?.id ?? null],
        queryFn: () => apiFetch('/api/entitlements/me'),
        enabled: !!user,
        // The server re-checks every GATED action regardless of this cache, so
        // staleness was never a security question — but it IS what the paywall
        // UI (locked/unlocked cards, the pricing page's "current plan" badge)
        // renders from, and a long-lived tab left open across an upgrade could
        // sit on a pre-upgrade "free" snapshot indefinitely: the global
        // QueryClient default disables refetchOnWindowFocus (perf), and
        // nothing else here was forcing a re-check. 60s + refetching on focus
        // means switching back to that tab corrects it within a minute instead
        // of needing a manual reload.
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        // Not fully logged in yet → server 401s. Don't retry, just fall to free.
        retry: (count, err) => (err && err.status === 401 ? false : count < 1),
    })

    const data = query.data || null
    const plan = data?.plan || 'free' // fail safe = most restrictive
    const limits = data?.limits ? normalizeLimits(data.limits) : { ...FREE_LIMITS }
    const usage = data?.usage || {}
    // 'INR' fail-safe matches the server's own default (lib/geo.js: unknown
    // country → INR, never USD) — same reasoning applies here for a
    // logged-out/not-yet-loaded viewer.
    const currency = data?.currency === 'USD' ? 'USD' : 'INR'

    function can(feature) {
        if (feature === 'hld_catalog') return limits.hld_catalog_access === 'full'
        const u = usage[feature]
        if (!u) return false
        return (u.used ?? 0) < toNumericLimit(u.limit)
    }

    return {
        plan,
        limits,
        usage,
        currency,
        can,
        isLoading: query.isLoading,
        isError: query.isError,
        refetch: query.refetch,
    }
}

// Cheap plan-only check (still subscribes to the same query).
export function usePlan() {
    return useEntitlements().plan
}
