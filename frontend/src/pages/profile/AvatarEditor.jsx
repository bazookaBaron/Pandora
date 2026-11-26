import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getInitials, stringToColor } from '../../lib/avatar'
import { toast } from '../../lib/toast'
import { errorText } from '../../lib/errorText'

// The `avatars` storage bucket is public; RLS lets a user write only under a
// folder named for their uid. profiles.avatar_url (RLS: own row) is the source
// of truth; falls back to the live Google picture from user_metadata.
export default function AvatarEditor({ user }) {
    const qc = useQueryClient()
    const fileRef = useRef(null)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')

    const { data: profile } = useQuery({
        queryKey: ['profile-avatar', user?.id],
        queryFn: async () => {
            const { data } = await supabase.from('profiles').select('avatar_url').eq('id', user.id).maybeSingle()
            return data || {}
        },
        enabled: !!user,
    })

    const src = profile?.avatar_url || user?.user_metadata?.avatar_url || user?.user_metadata?.picture || null

    const onFile = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        setErr('')
        if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { setErr('Use a JPG, PNG, WEBP or GIF.'); return }
        if (file.size > 2 * 1024 * 1024) { setErr('Image must be under 2 MB.'); return }
        setBusy(true)
        try {
            const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
            const path = `${user.id}/avatar_${Date.now()}.${ext}`
            const up = await supabase.storage.from('avatars').upload(path, file, { cacheControl: '3600', contentType: file.type })
            if (up.error) throw up.error
            const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path)
            const upd = await supabase.from('profiles').update({ avatar_url: pub.publicUrl }).eq('id', user.id)
            if (upd.error) throw upd.error
            try {
                const { data: list } = await supabase.storage.from('avatars').list(user.id)
                const stale = (list || []).map(o => `${user.id}/${o.name}`).filter(p => p !== path)
                if (stale.length) await supabase.storage.from('avatars').remove(stale)
            } catch { /* best effort */ }
            // show the new picture at once (navbar shares this key), then reconcile
            qc.setQueryData(['profile-avatar', user.id], (old) => ({ ...(old || {}), avatar_url: pub.publicUrl }))
            qc.invalidateQueries({ queryKey: ['profile-avatar', user.id] })
            toast.success('Profile picture updated.')
        } catch (e2) {
            setErr(e2?.message || 'Upload failed.')
            toast.error(`Could not update your picture: ${errorText(e2, 'Upload failed.')}`)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="profile-avatar-box">
            {src ? (
                <img className="profile-avatar" src={src} alt="" referrerPolicy="no-referrer" style={{ objectFit: 'cover' }} />
            ) : (
                <div className="profile-avatar" style={{ background: stringToColor(user?.email) }}>{getInitials(user)}</div>
            )}
            <button
                type="button"
                className="profile-avatar-edit"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label="Change profile photo"
                title="Change profile photo"
            >
                {busy ? <span className="sys-spin" aria-hidden="true" /> : <Pencil size={12} aria-hidden="true" />}
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={onFile} />
            {err && <div className="profile-avatar-err" role="alert">{err}</div>}
        </div>
    )
}
