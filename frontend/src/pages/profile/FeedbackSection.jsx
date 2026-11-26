import { useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { apiFetch } from '../../lib/apiClient'
import { SectionHead, Segmented, Button } from '../../components/ui'

const KINDS = [{ value: 'feature', label: 'Feature' }, { value: 'bug', label: 'Bug' }]

// Request a feature / report a bug.
export default function FeedbackSection() {
    const [kind, setKind] = useState('feature')
    const [message, setMessage] = useState('')
    const [status, setStatus] = useState({ type: '', msg: '' })
    const [sending, setSending] = useState(false)

    const submit = async (e) => {
        e.preventDefault()
        const body = message.trim()
        if (body.length < 10) {
            setStatus({ type: 'error', msg: 'Please add a little more detail (min. 10 characters).' })
            return
        }
        setSending(true)
        setStatus({ type: '', msg: '' })
        try {
            await apiFetch('/api/feedback', { json: { kind, message: body } })
            setStatus({ type: 'success', msg: 'Thanks — your message was sent.' })
            setMessage('')
        } catch (err) {
            setStatus({ type: 'error', msg: err?.body?.error || err?.message || 'Could not send. Try again.' })
        } finally {
            setSending(false)
        }
    }

    return (
        <section className="card profile-card" aria-labelledby="pf-feedback-h">
            <SectionHead icon={MessageSquare} title="Feedback" tone="history" id="pf-feedback-h"
                action={<Segmented label="Feedback type" value={kind} onChange={setKind} options={KINDS} />} />
            <form onSubmit={submit} className="profile-form">
                <label htmlFor="pf-feedback-msg" className="sys-sr">Message</label>
                <textarea
                    id="pf-feedback-msg"
                    className="input-field"
                    rows={3}
                    maxLength={4000}
                    placeholder={kind === 'bug'
                        ? 'What went wrong, and what were you doing?'
                        : 'What would you like Vloombox to do?'}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    style={{ resize: 'vertical', minHeight: 80 }}
                />
                <div className="profile-actions">
                    <Button type="submit" variant="primary" busy={sending} busyLabel="Sending…">Send</Button>
                </div>
                {status.msg && (
                    <p className={`sys-note ${status.type === 'error' ? 'is-danger' : 'is-ok'}`} role="status">{status.msg}</p>
                )}
            </form>
        </section>
    )
}
