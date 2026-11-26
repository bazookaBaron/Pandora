import { useState } from 'react'
import { BadgeCheck, ShieldCheck, X } from 'lucide-react'
import { Button } from '../../components/ui'
import { errorText } from '../../components/shared/states'
import { useVerifyConfirm, useVerifyStart } from '../../lib/useReferrals'

const HINT_KEY = 'referrals:verifyHintDismissed'
function readDismissed() {
    try { return localStorage.getItem(HINT_KEY) === '1' } catch { return false }
}

const VERIFY_ERRORS = {
    domain_mismatch: "That email's domain doesn't look like this company's. Use your work address.",
    invalid_email: 'Enter a valid work email.',
    set_company_first: 'Add your company in your profile first.',
    email_in_use: 'That work email is already linked to another account.',
    email_unconfigured: 'Email sending is unavailable right now. Try again later.',
    wait_before_resending: 'Please wait a minute before requesting another code.',
    too_many_codes: 'Too many codes requested. Try again in an hour.',
    wrong_code: "That code isn't right.",
    code_expired: 'That code expired. Request a new one.',
    no_pending_code: 'Request a code first.',
    too_many_attempts: 'Too many attempts. Request a new code.',
    company_changed: 'Your company changed since the code was sent. Request a new code.',
}
function verifyErrText(err) {
    return (err && VERIFY_ERRORS[err.code]) || errorText(err)
}

// Optional and dismissible: nothing in the referral flow is blocked by it.
export default function VerifyHint({ company }) {
    const [dismissed, setDismissed] = useState(readDismissed)
    const [step, setStep] = useState('hint') // hint | email | code | done
    const [email, setEmail] = useState('')
    const [code, setCode] = useState('')
    const [err, setErr] = useState('')
    const start = useVerifyStart()
    const confirm = useVerifyConfirm()

    if (dismissed) return null
    const dismiss = () => {
        try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode */ }
        setDismissed(true)
    }

    const sendCode = async (e) => {
        e.preventDefault()
        setErr('')
        try {
            await start.mutateAsync(email.trim())
            setStep('code')
        } catch (ex) { setErr(verifyErrText(ex)) }
    }
    const confirmCode = async (e) => {
        e.preventDefault()
        setErr('')
        try {
            await confirm.mutateAsync(code.trim())
            setStep('done')
        } catch (ex) { setErr(verifyErrText(ex)) }
    }

    if (step === 'done') {
        return (
            <div className="sys-note is-ok has-icon ref-verify" role="status">
                <BadgeCheck size={15} aria-hidden="true" />
                <span>Verified{company ? ` at ${company}` : ''} — your badge and higher daily limit are active.</span>
            </div>
        )
    }

    return (
        <div className="sys-note is-info ref-verify">
            <div className="ref-verify-row">
                <ShieldCheck size={15} aria-hidden="true" style={{ flex: 'none', marginTop: 2, color: 'var(--pop)' }} />
                <span>
                    Verify your work email for a <strong>Verified</strong> badge and higher limits. Optional.
                </span>
                {step === 'hint' && (
                    <Button variant="primary" onClick={() => setStep('email')}>Verify</Button>
                )}
                <Button variant="ghost" iconOnly icon={X} aria-label="Dismiss" onClick={dismiss} />
            </div>
            {step === 'email' && (
                <form onSubmit={sendCode}>
                    <input
                        className="input-field" type="email" required placeholder="you@yourcompany.com" aria-label="Work email"
                        value={email} onChange={(e) => setEmail(e.target.value)}
                    />
                    <Button type="submit" busy={start.isPending} busyLabel="Sending…">Send code</Button>
                </form>
            )}
            {step === 'code' && (
                <form onSubmit={confirmCode}>
                    <input
                        className="input-field" inputMode="numeric" maxLength={6} required placeholder="6-digit code" aria-label="Verification code"
                        value={code} onChange={(e) => setCode(e.target.value)}
                    />
                    <Button type="submit" busy={confirm.isPending} busyLabel="Checking…">Confirm</Button>
                </form>
            )}
            {err && <span className="ref-err" role="alert">{err}</span>}
        </div>
    )
}
