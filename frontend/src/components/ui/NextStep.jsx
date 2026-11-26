import { isValidElement, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, X } from 'lucide-react'
import { getSection } from '../../lib/sections'
import { track, TRACK } from '../../lib/track'
import { sectionIcon } from './sectionIcons'

const DISMISS_KEY = 'vb_ns_v1:'      // localStorage: dismissed for good
const SESSION_KEY = 'vb_ns_seen_v1:' // sessionStorage: already shown this session

function read(store, key) {
    try { return window[store].getItem(key) } catch { return null }
}
function write(store, key) {
    try { window[store].setItem(key, '1') } catch { /* storage blocked: shows again next time */ }
}

/**
 * Bridge card from one section to another (plan §6 "Bridges"): section tone,
 * one line, one CTA, a dismiss button. Dismissal is remembered per `id`
 * (localStorage). `oncePerSession` also hides it after its first showing in a
 * browser session. A click on the CTA sends a `bridge_click` event.
 *
 *   <NextStep id="jobs-to-autoapply" section="autoapply"
 *             text="Applying to 50 jobs takes hours. Let Auto Apply do it."
 *             cta={{ label: 'See packs', to: '/autoapply' }} oncePerSession />
 *
 * id: stable string (storage key + analytics id) · section: TARGET section (tone + icon)
 * text: one line · cta: { label, to? | href? | onClick? } or a node
 * oncePerSession: boolean · onDismiss: optional callback · icon: lucide component override
 */
export default function NextStep({ id, section = 'jobs', text, cta, oncePerSession = false, onDismiss, icon, className = '' }) {
    const [hidden, setHidden] = useState(() => {
        if (!id) return false
        if (read('localStorage', DISMISS_KEY + id)) return true
        return oncePerSession && !!read('sessionStorage', SESSION_KEY + id)
    })
    useEffect(() => {
        if (!hidden && id && oncePerSession) write('sessionStorage', SESSION_KEY + id)
    }, [hidden, id, oncePerSession])

    if (hidden) return null
    const s = getSection(section)
    const Icon = icon || sectionIcon(s)
    const dismiss = () => {
        if (id) write('localStorage', DISMISS_KEY + id)
        setHidden(true)
        onDismiss?.()
    }
    const onCta = (fn) => (e) => {
        track(TRACK.BRIDGE_CLICK, { id: id || 'unknown', to: s.id })
        fn?.(e)
    }

    let action = cta
    if (cta && !isValidElement(cta) && typeof cta === 'object') {
        const { label, to, href, onClick } = cta
        const inner = <><span>{label}</span><ArrowRight size={16} aria-hidden="true" /></>
        if (to) action = <Link to={to} className="sys-tone-btn is-sm" onClick={onCta(onClick)}>{inner}</Link>
        else if (href) action = <a href={href} className="sys-tone-btn is-sm" onClick={onCta(onClick)}>{inner}</a>
        else action = <button type="button" className="sys-tone-btn is-sm" onClick={onCta(onClick)}>{inner}</button>
    }

    return (
        <aside className={`sys-next ${className}`.trim()} style={{ '--tone': s.tone, '--tone-dim': s.toneDim }} aria-label={s.name}>
            <span className="sys-next-icon" aria-hidden="true"><Icon size={18} /></span>
            <p className="sys-next-text">{text}</p>
            {action && <span className="sys-next-cta">{action}</span>}
            <button type="button" className="sys-next-x" onClick={dismiss} aria-label="Dismiss">
                <X size={16} aria-hidden="true" />
            </button>
        </aside>
    )
}
