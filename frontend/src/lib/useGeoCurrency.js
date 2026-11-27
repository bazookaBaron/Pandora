import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './apiClient'
import { useEntitlements } from './useEntitlements'
import { useAuth } from '../contexts/AuthContext'

/**
 * The currency to PRICE in, with an explicit "known" flag so the UI can show a
 * skeleton instead of flashing INR and then switching to USD.
 *
 *   signed in, country stored  -> entitlements currency (authoritative; what checkout bills)
 *   otherwise (logged out, or country not detected yet) -> GET /api/geo
 *
 * `ready` is false until one of those has answered.
 */
export function useGeoCurrency() {
    const { user } = useAuth()
    const ent = useEntitlements()
    const needGeo = !user || (!ent.isLoading && !ent.currencyKnown)
    const geo = useQuery({
        queryKey: ['geo'],
        // Short timeout: if the lookup hangs, fall back to INR fast instead of a long skeleton.
        queryFn: () => apiFetch('/api/geo', { timeout: 4000 }),
        enabled: needGeo,
        staleTime: 10 * 60_000,
        retry: 1,
    })
    if (user && ent.currencyKnown) return { currency: ent.currency, ready: true }
    if (geo.data?.currency) return { currency: geo.data.currency === 'USD' ? 'USD' : 'INR', ready: true }
    // The geo lookup itself failed: INR is the server's own fail-safe, so stop waiting.
    if (geo.isError) return { currency: 'INR', ready: true }
    return { currency: 'INR', ready: false }
}
