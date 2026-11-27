import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ListFilter, Search } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { ErrorState, errorText } from '../../components/shared/states'
import { HelpChip, PageHeader, Row, Sheet, StatusBanner } from '../../components/ui'
import { openRazorpayOrder } from '../../lib/razorpay'
import { track, TRACK } from '../../lib/track'
import { useAutoApplyMe, useCompanySuggest, useCouponQuote, useCreateOrder, useSupply, useVerifyOrder } from '../../lib/useAutoApply'
import { TIERS } from '../../../config/tiers.js'
import {
    AALayout, MustCompaniesInput, PACK_KINDS, PACK_SIZES, fmtDate, matchShown, num, packPrice, perApplication, rupees, setupLinkFor,
} from './ui'
import './buy.css'

function useDebounced(value, ms) {
    const [v, setV] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms)
        return () => clearTimeout(t)
    }, [value, ms])
    return v
}

const CARD_NAME = { service: 'Service companies', product: 'Product companies' }
const proMonthly = TIERS?.pro?.price_inr?.monthly

/** "Includes jobs from across India, last 90 days." from GET /supply's widened_parts (the broadening ladder). */
function widenedLine(d) {
    const parts = (d && d.widened_parts) || []
    if (!parts.length) return ''
    const what = parts.includes('titles') ? 'related roles' : 'jobs'
    const india = parts.includes('locations')
    const days = parts.includes('window') ? d.widened_window_days : null
    if (india) return `Includes ${what} from across India${days ? `, last ${days} days` : ''}.`
    return `Includes ${what}${days ? ` from the last ${days} days` : ''}.`
}

// One stacked pack card (a radio): name, price, "50+ matching jobs", price per application.
function PackCard({ kind, size, config, supply, selected, onPick, disabled }) {
    const p = packPrice(config, kind, size)
    const d = supply.data
    const count = supply.isLoading ? null : d ? matchShown(d.count, size) : null
    return (
        <button type="button" role="radio" aria-checked={selected} className={`buy-card${selected ? ' is-on' : ''}`} onClick={onPick} disabled={disabled || p == null}>
            <span className="buy-card-top">
                <span className="buy-card-name">{CARD_NAME[kind]}</span>
                <span className="buy-card-price">{p != null ? rupees(p) : '—'}</span>
            </span>
            <span className="buy-card-line">
                <span className={d && d.count < 50 ? 'buy-card-low' : 'buy-card-match'}>
                    {count == null ? (supply.isError ? 'Could not count jobs' : 'Counting jobs…') : `${count} matching jobs`}
                </span>
                {p != null && <span className="buy-card-per">{perApplication(p, size)} per application</span>}
            </span>
        </button>
    )
}

function MatchesSheet({ open, onClose, supply, size }) {
    const d = supply.data
    return (
        <Sheet open={open} onClose={onClose} title="Matching jobs" description={d ? `${matchShown(d.count, size)} jobs fit your setup right now.` : undefined}>
            {d && Array.isArray(d.sample) && d.sample.length > 0 ? (
                <ul className="sys-rows">
                    {d.sample.slice(0, 5).map((j, i) => (
                        <li key={`${j.company}-${j.title}-${i}`}><Row title={`${j.company} · ${j.title}`} meta={fmtDate(j.posted_at, false)} /></li>
                    ))}
                </ul>
            ) : <p className="aa-muted">No matching jobs yet.</p>}
            {widenedLine(d) && <p className="aa-muted" style={{ marginTop: 12 }}>{widenedLine(d)}</p>}
            <p className="aa-muted" style={{ marginTop: 8 }}>We keep applying until all {size} are submitted.</p>
        </Sheet>
    )
}

export default function BuyPage() {
    const me = useAutoApplyMe()
    const { user } = useAuth()
    const navigate = useNavigate()
    const [params] = useSearchParams()
    const createOrder = useCreateOrder()
    const verifyOrder = useVerifyOrder()
    const couponQuote = useCouponQuote()
    const [couponOpen, setCouponOpen] = useState(false)
    const [couponInput, setCouponInput] = useState('')
    const [coupon, setCoupon] = useState(null) // { code, kind } once checked
    const [couponErr, setCouponErr] = useState('')
    const [sheet, setSheet] = useState(null) // 'matches' | 'options'

    const config = me.data?.config || {}
    const maxWindow = config.window_days_max ?? 30
    const kindParam = params.get('kind')
    const [kind, setKindState] = useState(kindParam === 'product' ? 'product' : 'service')
    // the user's own pick (or a ?kind= link) wins; until then the kind with more matching jobs is pre-selected
    const kindPicked = useRef(kindParam === 'product' || kindParam === 'service')
    const setKind = (k) => { kindPicked.current = true; setKindState(k) }
    const [size, setSize] = useState(50)
    const [windowDays, setWindowDays] = useState(null)
    const [note, setNote] = useState(null) // {kind: 'error'|'cap'|'eligible'|'consent', text}
    const [stage, setStage] = useState('') // '' | 'order' | 'paying' | 'verifying'

    useEffect(() => {
        if (windowDays === null && me.data) setWindowDays(config.window_days_default ?? 30)
    }, [me.data, windowDays, config.window_days_default])
    const wd = windowDays ?? 30
    const debouncedWd = useDebounced(wd, 350)

    const u = me.data?.usage || {}
    const cap = u.monthly_cap ?? config.monthly_cap ?? 1000
    const remaining = u.remaining_purchasable ?? Math.max(0, cap - (u.month_purchased || 0))
    const listPrice = packPrice(config, kind, size)
    const price = listPrice == null || !coupon ? listPrice : coupon.kind === 'free_all' ? 0 : coupon.kind === 'per_job_rupee' ? Math.min(listPrice, size * 100) : listPrice
    const eligible = !!me.data?.eligible
    const onboarded = !!me.data?.onboarding_done
    const check = me.data?.profile_check
    const profileMissing = check && !check.ok ? check.missing || [] : []
    const [ackWait, setAckWait] = useState(false)
    const [must, setMust] = useState([])
    const [mustQuery, setMustQuery] = useState('')
    const suggest = useCompanySuggest(useDebounced(mustQuery, 250), kind)
    const sizeOk = size <= remaining
    // both kinds: the cards compare them and the busier one is pre-selected (server-cached 10 min per user)
    // only once /me set the window and the slider settled (0 disables the query)
    const supplyWd = me.data && windowDays !== null && debouncedWd === wd ? debouncedWd : 0
    const supplyService = useSupply('service', supplyWd, size)
    const supplyProduct = useSupply('product', supplyWd, size)
    const supplyFor = (k) => (k === 'product' ? supplyProduct : supplyService)

    useEffect(() => {
        if (kindPicked.current) return
        const sv = supplyService.data
        const pr = supplyProduct.data
        if (!sv || !pr) return
        kindPicked.current = true
        setKindState(pr.count > sv.count ? 'product' : 'service')
    }, [supplyService.data, supplyProduct.data])

    // funnel: one buy_view per visit, once /me says what is on offer
    const viewed = useRef(false)
    useEffect(() => {
        if (viewed.current || !me.data) return
        viewed.current = true
        track(TRACK.BUY_VIEW, { pack: kind, size })
    }, [me.data, kind, size])

    const busy = !!stage

    // keep the selected size purchasable
    useEffect(() => {
        if (!me.data) return
        if (size > remaining) {
            const fit = [...PACK_SIZES].reverse().find((s) => s <= remaining)
            if (fit) setSize(fit)
        }
    }, [remaining, me.data]) // eslint-disable-line react-hooks/exhaustive-deps

    async function applyCoupon() {
        setCouponErr('')
        const code = couponInput.trim().toUpperCase()
        if (!code) return
        try {
            const q = await couponQuote.mutateAsync({ coupon_code: code, pack_kind: kind, pack_size: size, window_days: wd })
            setCoupon({ code: q.coupon_code, kind: q.kind })
        } catch (err) {
            setCoupon(null)
            setCouponErr(err?.message && !/^coupon_/.test(err.message) ? err.message : errorText(err))
        }
    }

    async function buy() {
        setNote(null)
        setStage('order')
        const ev = { pack: kind, size, amount: Math.round((Number(price) || 0) / 100) }
        track(TRACK.PAY_START, ev)
        let order
        try {
            order = await createOrder.mutateAsync({ pack_kind: kind, pack_size: size, window_days: wd, must_companies: must, ...(coupon ? { coupon_code: coupon.code } : {}) })
        } catch (err) {
            setStage('')
            if (err?.status === 403 || err?.code === 'not_eligible') setNote({ kind: 'eligible', text: err.message })
            else if (err?.code === 'consent_required') setNote({ kind: 'consent', text: errorText(err) })
            else if (err?.status === 409 || err?.code === 'monthly_cap') setNote({ kind: 'cap', text: err.message })
            else setNote({ kind: 'error', text: errorText(err) })
            me.refetch()
            return
        }
        if (order.free) {
            track(TRACK.PAY_SUCCESS, { ...ev, amount: 0 })
            navigate(order.batch_id ? `/autoapply/batches/${order.batch_id}?new=1` : '/autoapply')
            return
        }
        setStage('paying')
        let resp
        try {
            resp = await openRazorpayOrder({
                keyId: order.key_id,
                orderId: order.order_id,
                amount: order.amount,
                currency: order.currency || 'INR',
                description: `AutoApply · ${PACK_KINDS[kind].short} · ${size} applications`,
                user,
            })
        } catch (err) {
            setStage('')
            if (err?.code !== 'dismissed') setNote({ kind: 'error', text: err?.message || 'The payment did not go through.' })
            return
        }
        setStage('verifying')
        try {
            const res = await verifyOrder.mutateAsync({
                razorpay_order_id: resp.razorpay_order_id,
                razorpay_payment_id: resp.razorpay_payment_id,
                razorpay_signature: resp.razorpay_signature,
            })
            track(TRACK.PAY_SUCCESS, { ...ev, amount: Math.round((Number(order.amount) || 0) / 100) })
            const id = res?.batch?.id || order.batch_id
            navigate(id ? `/autoapply/batches/${id}?new=1` : '/autoapply')
        } catch (err) {
            setStage('')
            setNote({ kind: 'error', text: `We could not confirm the payment (${errorText(err)}). If you were charged, your pack will appear shortly; contact support if it doesn't.` })
        }
    }

    // one status line: setup first, then an incomplete profile
    let banner = null
    if (me.data && !onboarded) {
        banner = <StatusBanner tone="warn" text="Finish setup before you buy" action={{ label: 'Finish setup', to: '/autoapply/account' }} />
    } else if (me.data && profileMissing.length > 0) {
        banner = <StatusBanner tone="warn" text={`${profileMissing.length} profile item${profileMissing.length === 1 ? '' : 's'} left. The pack waits until done.`} action={{ label: 'Fix', to: setupLinkFor(profileMissing) }} />
    }

    // free plan: the plan need is shown inline and the bar sends them to pricing (a free-pack code still works)
    const needsPlan = !!me.data && !eligible && !(coupon && coupon.kind === 'free_all')
    const payDisabled = busy || !onboarded || !sizeOk || price == null || (profileMissing.length > 0 && !ackWait)

    return (
        <AALayout>
            {(stage === 'order' || stage === 'verifying') && (
                <div aria-live="polite" className="buy-overlay">
                    <div className="buy-overlay-box">
                        <span className="spinner-lg" />
                        <span>{stage === 'order' ? 'Opening secure checkout…' : 'Confirming payment…'}</span>
                    </div>
                </div>
            )}
            <PageHeader section="autoapply" title="Pick a pack" subtitle="We apply to matching jobs for you." back={{ to: '/autoapply', label: 'Auto Apply' }}
                aside={<HelpChip term="pack" />} />

            {banner && <div className="aa-gap">{banner}</div>}

            <div className="buy-size" role="radiogroup" aria-label="Pack size">
                {PACK_SIZES.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={size === s} className="buy-size-opt" onClick={() => setSize(s)}
                        disabled={busy || s > remaining} title={s > remaining ? 'Over this month’s limit' : undefined}>
                        {s} jobs
                    </button>
                ))}
            </div>
            {PACK_SIZES.some((s) => s > remaining) && <p className="aa-faint buy-left">{num(remaining)} of {num(cap)} applications left this month</p>}

            <div className="buy-cards" role="radiogroup" aria-label="Companies">
                {['service', 'product'].map((k) => (
                    <PackCard key={k} kind={k} size={size} config={config} supply={supplyFor(k)} selected={kind === k} onPick={() => setKind(k)} disabled={busy} />
                ))}
            </div>

            {needsPlan && (
                <p className="buy-plan" role="note">
                    Needs a Pro or Max plan{proMonthly ? ` (from ${rupees(proMonthly)}/mo)` : ''}. <Link to="/pricing">See plans</Link>
                </p>
            )}

            <ul className="sys-rows buy-rows">
                <li><Row leading={<Search size={18} />} title="See matching jobs" onClick={() => setSheet('matches')} /></li>
                <li><Row leading={<ListFilter size={18} />} title="More options" sub={must.length ? `${must.length} must-apply companies` : `Jobs from the last ${wd} days`} onClick={() => setSheet('options')} /></li>
            </ul>

            <div className="buy-code">
                {couponOpen ? (
                    <div className="aa-row" style={{ gap: 8 }}>
                        <label className="aa-sr" htmlFor="buy-coupon">Coupon code</label>
                        <input id="buy-coupon" className="input-field" placeholder="Code" value={couponInput} maxLength={40} autoFocus
                            style={{ flex: '1 1 140px', minWidth: 0, textTransform: 'uppercase' }} disabled={busy}
                            onChange={(e) => { setCouponInput(e.target.value); setCoupon(null); setCouponErr('') }}
                            onKeyDown={(e) => { if (e.key === 'Enter') applyCoupon() }} />
                        <button type="button" className="aa-btn buy-code-btn" onClick={applyCoupon} disabled={busy || !couponInput.trim() || couponQuote.isPending}>
                            {couponQuote.isPending ? 'Checking…' : 'Apply'}
                        </button>
                    </div>
                ) : (
                    <button type="button" className="buy-code-link" onClick={() => setCouponOpen(true)}>Have a code?</button>
                )}
                {coupon && <span className="aa-chip" style={{ marginTop: 8 }}>{coupon.code} · {coupon.kind === 'free_all' ? 'free pack' : '₹1 per application'}</span>}
                {couponErr && <p className="buy-err" role="alert">{couponErr}</p>}
            </div>

            {onboarded && profileMissing.length > 0 && (
                <label className="aa-check buy-ack">
                    <input type="checkbox" checked={ackWait} onChange={(e) => setAckWait(e.target.checked)} disabled={busy} />
                    <span>I understand this pack waits until my profile is complete.</span>
                </label>
            )}
            {note?.kind === 'eligible' && (
                <StatusBanner tone="warn" className="aa-gap" text={note.text && note.text !== 'not_eligible' ? note.text : 'Auto Apply needs an active Pro or Max plan.'} action={{ label: 'See plans', to: '/pricing' }} />
            )}
            {note?.kind === 'cap' && (
                <StatusBanner tone="warn" className="aa-gap" text={`${note.text && note.text !== 'monthly_cap' ? note.text : `This pack goes over the ${num(cap)} per month limit.`} ${num(remaining)} left this month.`} />
            )}
            {note?.kind === 'consent' && (
                <StatusBanner tone="warn" className="aa-gap" text={note.text} action={{ label: 'Open setup', to: '/autoapply/account?step=review' }} />
            )}
            {note?.kind === 'error' && <ErrorState compact message={note.text} style={{ marginBottom: 12 }} />}

            <div className="buy-bar" aria-label="Total">
                <div className="buy-bar-total">
                    <strong>
                        {price != null ? rupees(price) : '—'}
                        {coupon && listPrice != null && price !== listPrice && <s className="buy-bar-was">{rupees(listPrice)}</s>}
                    </strong>
                    <span>{PACK_KINDS[kind].short} · {size} jobs · GST incl.</span>
                </div>
                {needsPlan ? (
                    <Link to="/pricing" className="sys-tone-btn buy-bar-btn" onClick={() => track(TRACK.CTA_CLICK, { id: 'buy_needs_plan', section: 'autoapply' })}>Get Pro</Link>
                ) : (
                    <button type="button" className="sys-tone-btn buy-bar-btn" onClick={buy} disabled={payDisabled} aria-busy={busy || undefined}>
                        {stage === 'paying' ? 'Payment open…' : busy ? 'Working…' : price === 0 ? 'Get it free' : `Pay ${price != null ? rupees(price) : ''}`}
                    </button>
                )}
            </div>

            <MatchesSheet open={sheet === 'matches'} onClose={() => setSheet(null)} supply={supplyFor(kind)} size={size} />
            <Sheet open={sheet === 'options'} onClose={() => setSheet(null)} title="More options"
                footer={<button type="button" className="sys-tone-btn" style={{ '--tone': 'var(--pop)' }} onClick={() => setSheet(null)}>Done</button>}>
                <div className="aa-stack" style={{ gap: 18 }}>
                    <div>
                        <label className="field-label" htmlFor="buy-wd">Jobs posted in the last <span style={{ color: 'var(--pop)' }}>{wd} day{wd === 1 ? '' : 's'}</span></label>
                        <input id="buy-wd" type="range" className="aa-range" min={1} max={maxWindow} value={wd} onChange={(e) => setWindowDays(Number(e.target.value))} disabled={busy} aria-valuetext={`${wd} days`} />
                    </div>
                    <div>
                        <div className="field-label" id="buy-must">Must-apply companies</div>
                        <MustCompaniesInput idPrefix="buy-must" value={must} onChange={setMust} query={mustQuery} onQuery={setMustQuery}
                            suggestions={suggest.data?.companies || []} disabled={busy} />
                    </div>
                </div>
            </Sheet>
        </AALayout>
    )
}
