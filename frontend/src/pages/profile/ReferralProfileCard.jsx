import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { SectionHead, Button } from '../../components/ui'
import CompanyAutocomplete from '../../components/shared/CompanyAutocomplete'
import Skeleton from './Skeleton'

export default function ReferralProfileCard({ user }) {
    const { data: profile, isLoading } = useQuery({
        queryKey: ['referral-profile', user?.id],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('profiles')
                .select('company, position, years_of_experience, receive_referral_notifications')
                .eq('id', user.id)
                .maybeSingle()
            if (error) throw error
            return data || {}
        },
        enabled: !!user,
        staleTime: 60_000,
    })

    const [company, setCompany] = useState('')
    const [position, setPosition] = useState('')
    const [yoe, setYoe] = useState('')
    const [notify, setNotify] = useState(true)
    const [hydrated, setHydrated] = useState(false)
    const [saving, setSaving] = useState(false)
    const [status, setStatus] = useState({ msg: '', type: '' })

    useEffect(() => {
        if (!profile || hydrated) return
        setCompany(profile.company || '')
        setPosition(profile.position || '')
        setYoe(profile.years_of_experience == null ? '' : String(profile.years_of_experience))
        setNotify(profile.receive_referral_notifications ?? true)
        setHydrated(true)
    }, [profile, hydrated])

    const save = async (e) => {
        e.preventDefault()
        setSaving(true)
        setStatus({ msg: '', type: '' })
        const { error } = await supabase.from('profiles').upsert({
            id: user.id,
            company: company.trim() || null,
            position: position.trim() || null,
            years_of_experience: yoe === '' ? null : Number(yoe),
            receive_referral_notifications: notify,
        }, { onConflict: 'id' })
        setSaving(false)
        setStatus(error
            ? { msg: error.message || 'Could not save — try again.', type: 'error' }
            : { msg: 'Referral profile saved.', type: 'ok' })
    }

    return (
        <section className="card profile-card" aria-labelledby="pf-ref-h">
            <SectionHead icon={Users} title="Referral profile" tone="success" id="pf-ref-h" />
            {isLoading ? (
                <Skeleton rows={3} last="50%" />
            ) : (
                <form onSubmit={save} className="profile-form">
                    <div className="sys-field">
                        <label className="sys-field-label" htmlFor="pf-company">Current company</label>
                        <CompanyAutocomplete id="pf-company" value={company} onChange={setCompany} />
                    </div>
                    <div className="profile-form-row">
                        <div className="sys-field">
                            <label className="sys-field-label" htmlFor="pf-position">Position</label>
                            <input id="pf-position" type="text" className="input-field" placeholder="e.g. Senior Software Engineer"
                                value={position} onChange={e => setPosition(e.target.value)} />
                        </div>
                        <div className="sys-field">
                            <label className="sys-field-label" htmlFor="pf-yoe">Years</label>
                            <input id="pf-yoe" type="number" min={0} step={0.5} className="input-field" placeholder="e.g. 4"
                                value={yoe} onChange={e => setYoe(e.target.value)} />
                        </div>
                    </div>
                    <label className="profile-check">
                        <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
                        <span>Email me referral requests for my company</span>
                    </label>
                    <div className="profile-actions">
                        <Button type="submit" variant="primary" busy={saving} busyLabel="Saving…">Save</Button>
                    </div>
                    {status.msg && (
                        <p className={`sys-note ${status.type === 'error' ? 'is-danger' : 'is-ok'}`} role="status">{status.msg}</p>
                    )}
                </form>
            )}
        </section>
    )
}
