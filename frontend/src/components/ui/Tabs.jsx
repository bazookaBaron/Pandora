import { useRef } from 'react'
import { nextIndex } from './rovingKeys'

/**
 * Accessible tabs: role=tablist / tab / tabpanel, roving tabindex, Left/Right/Home/End select + focus.
 * Controlled: you own `value`. Pair with <TabPanel> using the same `idPrefix`.
 *
 *   const [tab, setTab] = useState('open')
 *   <Tabs idPrefix="ref" label="Referrals" value={tab} onChange={setTab} data-tour="referrals-tabs"
 *         items={[{ value: 'open', label: 'Open', count: 12, icon: Inbox }, { value: 'post', label: 'Post' }]} />
 *   <TabPanel idPrefix="ref" value="open" active={tab === 'open'}>…</TabPanel>
 *
 * items[]: { value, label, count?, icon?, disabled? }
 * variant: 'pill' (default, segmented look) | 'line' (underlined page tabs)
 * block: tabs share the full width       wrap: tabs wrap onto lines instead of scrolling on phones
 * Extra props (data-tour, className, style) go on the tablist element.
 */
export function Tabs({ items = [], value, onChange, label, idPrefix = 'tabs', variant = 'pill', block = false, wrap = false, className = '', ...rest }) {
    const refs = useRef([])
    const current = Math.max(0, items.findIndex((t) => t.value === value))
    function onKeyDown(e) {
        const i = nextIndex(e.key, current, items)
        if (i < 0) return
        e.preventDefault()
        onChange?.(items[i].value)
        refs.current[i]?.focus()
    }
    const cls = ['sys-tabs', variant === 'line' && 'is-line', block && 'is-block', wrap && 'is-wrap', className].filter(Boolean).join(' ')
    return (
        <div role="tablist" aria-label={label} className={cls} onKeyDown={onKeyDown} {...rest}>
            {items.map((t, i) => {
                const selected = i === current
                const Icon = t.icon
                return (
                    <button
                        key={t.value}
                        ref={(el) => { refs.current[i] = el }}
                        type="button"
                        role="tab"
                        id={`${idPrefix}-tab-${t.value}`}
                        aria-controls={`${idPrefix}-panel-${t.value}`}
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={t.disabled}
                        className="sys-tab"
                        onClick={() => onChange?.(t.value)}
                    >
                        {Icon && <Icon size={14} aria-hidden="true" />}
                        {t.label}
                        {t.count != null && <span className="sys-tab-count">{t.count}</span>}
                    </button>
                )
            })}
        </div>
    )
}

/**
 * Panel for <Tabs>. Inactive panels unmount unless `keepMounted` (then they are `hidden`).
 *
 *   <TabPanel idPrefix="ref" value="post" active={tab === 'post'}><PostTab /></TabPanel>
 */
export function TabPanel({ idPrefix = 'tabs', value, active, keepMounted = false, children, className = '', ...rest }) {
    if (!active && !keepMounted) return null
    return (
        <div
            role="tabpanel"
            id={`${idPrefix}-panel-${value}`}
            aria-labelledby={`${idPrefix}-tab-${value}`}
            tabIndex={0}
            hidden={!active}
            className={`sys-tabpanel ${className}`.trim()}
            {...rest}
        >
            {children}
        </div>
    )
}

export default Tabs
