import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from './supabase'

// Resolved avatar URL for the current user: the saved profiles.avatar_url
// (user-set or captured from Google on signup) with a live fallback to the
// OAuth picture in user_metadata. Shares the ['profile-avatar', id] query key
// with ProfilePage's editor, so an upload there refreshes the navbar too.
export function useAvatarUrl() {
    const { user } = useAuth()
    const { data } = useQuery({
        queryKey: ['profile-avatar', user?.id],
        queryFn: async () => {
            const { data } = await supabase.from('profiles').select('avatar_url').eq('id', user.id).maybeSingle()
            return data || {}
        },
        enabled: !!user,
        staleTime: 60_000,
    })
    return (
        data?.avatar_url ||
        user?.user_metadata?.avatar_url ||
        user?.user_metadata?.picture ||
        null
    )
}
