import { useEffect, useRef } from 'react'
import { nextIndex } from './rovingKeys'
import { getSection } from '../../lib/sections'

/**
 * Small pill tabs: a 32px pill strip that scrolls sideways (at most ~4 pills
 * visible on a phone, the rest scroll). Same ARIA contract and props as <Tabs>
 * (role=tablist / tab, roving tabindex, arrow keys) and pairs with <TabPanel>
 * using the same idPrefix. Each pill has a 44px tall hit area.
 *
 *   <SmallTabs idPrefix="pack" label="Pack jobs" section="autoapply" value={tab} onChange={setTab}
 *              data-tour="pack-tabs"
 *              items={[{ value: 'applied', label: 'Applied', count: 18 }, { value: 'answers', label: 'Answers needed', count: 3 }, { value: 'skipped', label: 'Skipped' }]} />
 *   <TabPanel idPrefix="pack" value="applied" active={tab === 'applied'}>…</TabPanel>
 *
 * items[]: { value, label, count?, icon?, disabled? }
 * section: tone of the selected pill (default jobs); block: pills share the full width
 * Extra props (data-tour, className, style, aria-*) go on the tablist element.
 */
export default function SmallTabs({ items = [], value, onChange, label, idPrefix = 'stabs', section, block = false, className = '', style, ...rest }) {
    const refs = useRef([])
    const current = Math.max(0, items.findIndex((t) => t.value === value))
    const s = section ? getSection(section) : null

    // keep the selected pill in view when it changes
    useEffect(() => {
        // horizontal only: never scroll the page itself
        const el = refs.current[current]
        const box = el?.parentElement
        if (!el || !box) return
        const left = el.offsetLeft // .sys-stabs is position:relative, so this is relative to the strip
        if (left < box.scrollLeft) box.scrollLeft = Math.max(0, left - 8)
        else if (left + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + el.offsetWidth - box.clientWidth + 8
    }, [current])

    function onKeyDown(e) {
        const i = nextIndex(e.key, current, items)
        if (i < 0) return
        e.preventDefault()
        onChange?.(items[i].value)
        refs.current[i]?.focus()
    }
    const cls = ['sys-stabs', block && 'is-block', className].filter(Boolean).join(' ')
    const toned = s ? { '--tone': s.tone, '--tone-dim': s.toneDim, ...style } : style
    return (
        <div role="tablist" aria-label={label} className={cls} onKeyDown={onKeyDown} style={toned} {...rest}>
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
                        className="sys-stab"
                        onClick={() => onChange?.(t.value)}
                    >
                        {Icon && <Icon size={14} aria-hidden="true" />}
                        <span className="sys-stab-label">{t.label}</span>
                        {t.count != null && <span className="sys-stab-count">{t.count}</span>}
                    </button>
                )
            })}
        </div>
    )
}
