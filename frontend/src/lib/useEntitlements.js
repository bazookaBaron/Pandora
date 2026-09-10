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
        staleTime: 5 * 60_000, // server re-checks every gated action; a stale client copy is fine
        // Not fully logged in yet → server 401s. Don't retry, just fall to free.
        retry: (count, err) => (err && err.status === 401 ? false : count < 1),
    })

    const data = query.data || null
    const plan = data?.plan || 'free' // fail safe = most restrictive
    const limits = data?.limits ? normalizeLimits(data.limits) : { ...FREE_LIMITS }
    const usage = data?.usage || {}

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
