import { useEffect, useId, useRef } from 'react'
import { ChevronLeft } from 'lucide-react'
import { getSection } from '../../lib/sections'

/**
 * One question group per screen (plan §4.3 B / F). Controlled: you own `step`.
 * Shows "Step 2 of 5" + a progress bar, the group title, your fields, and a
 * sticky Back / Continue footer that sits above the bottom tab bar and the
 * phone's safe area. Focus moves to the title on every step change.
 *
 *   const [step, setStep] = useState(1)
 *   <Stepper section="autoapply" step={step} total={5} title="Where do you want to work?"
 *            onBack={step > 1 ? () => setStep(step - 1) : undefined}
 *            onNext={() => (step < 5 ? setStep(step + 1) : submit())} canNext={!!city}
 *            nextLabel={step === 5 ? 'Save' : 'Continue'}>
 *     <CityField … />
 *   </Stepper>
 *
 * step: 1-based · total: number of steps · title: the group heading (h2)
 * hint: optional one line under the title
 * onNext / onBack: handlers (no Back button when onBack is missing)
 * canNext: false disables Continue (default true) · busy: shows a spinner on Continue
 * nextLabel / backLabel: button text (default Continue / Back)
 * error: optional message shown above the footer (role=alert)
 * as: 'form' (default; Enter submits = onNext) | 'div'
 */
export default function Stepper({
    step = 1, total = 1, title, hint, children, onNext, onBack, canNext = true, busy = false,
    nextLabel = 'Continue', backLabel = 'Back', error, section = 'autoapply', as = 'form', className = '', ...rest
}) {
    const s = getSection(section)
    const headRef = useRef(null)
    const titleId = useId()
    const first = useRef(true)
    useEffect(() => {
        if (first.current) { first.current = false; return }
        try { headRef.current?.focus({ preventScroll: false }) } catch { /* detached */ }
    }, [step])

    const n = Math.max(1, Number(total) || 1)
    const k = Math.min(n, Math.max(1, Number(step) || 1))
    const pct = Math.round((k / n) * 100)
    const Tag = as === 'div' ? 'div' : 'form'
    const formProps = Tag === 'form'
        ? { onSubmit: (e) => { e.preventDefault(); if (canNext && !busy) onNext?.() }, noValidate: true }
        : {}

    return (
        <Tag className={`sys-stepper ${className}`.trim()} style={{ '--tone': s.tone, '--tone-dim': s.toneDim }} aria-labelledby={titleId} {...formProps} {...rest}>
            <div className="sys-stepper-top">
                <p className="sys-stepper-count">Step {k} of {n}</p>
                <div className="sys-stepper-bar" role="progressbar" aria-label={`Step ${k} of ${n}`} aria-valuemin={1} aria-valuemax={n} aria-valuenow={k}>
                    <span style={{ width: `${pct}%` }} />
                </div>
            </div>
            <h2 id={titleId} ref={headRef} tabIndex={-1} className="sys-stepper-title">{title}</h2>
            {hint && <p className="sys-stepper-hint">{hint}</p>}
            <div className="sys-stepper-body">{children}</div>
            {error && <p className="sys-stepper-err" role="alert">{error}</p>}
            <div className="sys-stepper-foot">
                {onBack && (
                    <button type="button" className="sys-stepper-back" onClick={onBack} disabled={busy}>
                        <ChevronLeft size={18} aria-hidden="true" />
                        <span>{backLabel}</span>
                    </button>
                )}
                <button
                    type={Tag === 'form' ? 'submit' : 'button'}
                    className="sys-tone-btn sys-stepper-next"
                    onClick={Tag === 'form' ? undefined : () => { if (canNext && !busy) onNext?.() }}
                    disabled={!canNext || busy}
                    aria-busy={busy || undefined}
                >
                    {busy && <span className="sys-spin" aria-hidden="true" />}
                    <span>{nextLabel}</span>
                </button>
            </div>
        </Tag>
    )
}
