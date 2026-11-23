import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { openRazorpayOrder } from '../../lib/razorpay'
import { useAutoApplyMe, useCompanySuggest, useCouponQuote, useCreateOrder, useSupply, useVerifyOrder } from '../../lib/useAutoApply'
import { AALayout, MustCompaniesInput, PACK_KINDS, PACK_SIZES, PageHeader, ProfileMissing, ReadinessCard, fmtDate, num, packPrice, rupees } from './ui'

function useDebounced(value, ms) {
    const [v, setV] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms)
        return () => clearTimeout(t)
    }, [value, ms])
    return v
}

function SupplyPanel({ kind, windowDays, size }) {
    const supply = useSupply(kind, windowDays)
    const d = supply.data
    return (
        <section className="aa-card" aria-labelledby="buy-supply" aria-busy={supply.isFetching}>
            <h2 id="buy-supply" className="aa-h2">Matching jobs right now</h2>
            {supply.isLoading ? (
                <LoadingState compact label="Counting matching jobs…" />
            ) : supply.isError ? (
                <ErrorState compact err={supply.error} onRetry={() => supply.refetch()} />
            ) : d ? (
                <div className="aa-stack">
                    <div className="aa-row" style={{ alignItems: 'baseline' }}>
                        <span className="aa-stat-value">{num(d.count)}</span>
                        <span className="aa-muted">{PACK_KINDS[kind].short.toLowerCase()}-company jobs posted in the last {windowDays} day{windowDays === 1 ? '' : 's'} match your preferences</span>
                    </div>
                    {d.count < size && (
                        <div className="aa-note is-warn">
                            Fewer matching jobs than the pack size today. We keep looking as new jobs are posted until your credits
                            expire; unused credits are refunded pro rata.
                        </div>
                    )}
                    {d.by_ats && Object.keys(d.by_ats).length > 0 && (
                        <div className="aa-chips" aria-label="By application system">
                            {Object.entries(d.by_ats).sort((a, b) => b[1] - a[1]).map(([ats, n]) => (
                                <span key={ats} className="aa-chip">{ats} <span className="aa-faint">{num(n)}</span></span>
                            ))}
                        </div>
                    )}
                    {Array.isArray(d.sample) && d.sample.length > 0 ? (
                        <div className="aa-table-wrap">
                            <table className="aa-table">
                                <caption className="aa-sr">Sample of matching jobs</caption>
                                <thead><tr><th>Company</th><th>Title</th><th>Location</th><th>Posted</th></tr></thead>
                                <tbody>
                                    {d.sample.map((j, i) => (
                                        <tr key={`${j.company}-${j.title}-${i}`}>
                                            <td className="aa-strong" data-label="Company">{j.company}</td>
                                            <td data-label="Title">{j.title}</td>
                                            <td data-label="Location">{j.location || '—'}</td>
                                            <td data-label="Posted">{fmtDate(j.posted_at, false)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p className="aa-faint" style={{ margin: 0 }}>No sample available.</p>
                    )}
                </div>
            ) : null}
        </section>
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
    const [couponInput, setCouponInput] = useState('')
    const [coupon, setCoupon] = useState(null) // { code, kind } once checked
    const [couponErr, setCouponErr] = useState('')

    const config = me.data?.config || {}
    const maxWindow = config.window_days_max ?? 30
    const [kind, setKind] = useState(params.get('kind') === 'product' ? 'product' : 'service')
    const [size, setSize] = useState(50)
    const [windowDays, setWindowDays] = useState(null)
    const [note, setNote] = useState(null) // {kind: 'error'|'cap'|'eligible'|'info', text}
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
    const onboarded = !!me.data?.onboarding_done
    const check = me.data?.profile_check
    const profileMissing = check && !check.ok ? check.missing || [] : []
    const [ackWait, setAckWait] = useState(false)
    const [must, setMust] = useState([])
    const [mustQuery, setMustQuery] = useState('')
    const suggest = useCompanySuggest(useDebounced(mustQuery, 250), kind)
    const sizeOk = size <= remaining
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
            const id = res?.batch?.id || order.batch_id
            navigate(id ? `/autoapply/batches/${id}?new=1` : '/autoapply')
        } catch (err) {
            setStage('')
            setNote({ kind: 'error', text: `We could not confirm the payment (${errorText(err)}). If you were charged, your batch will appear shortly; contact support if it doesn't.` })
        }
    }

    return (
        <AALayout gate>
            {(stage === 'order' || stage === 'verifying') && (
                <div aria-live="polite" style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'grid', placeItems: 'center', background: 'var(--overlay)', backdropFilter: 'blur(2px)' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--bright)' }}>
                        <span className="spinner-lg" />
                        <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>{stage === 'order' ? 'Opening secure checkout…' : 'Confirming payment…'}</span>
                    </div>
                </div>
            )}
            <PageHeader eyebrow="Buy" title="Buy an AutoApply pack" lead="Credits are used only when an application is submitted." />

            {me.data && !onboarded && (
                <div className="aa-note is-warn aa-spread" style={{ marginBottom: 16 }}>
                    <span>Finish setup before buying, so we can apply with your resume and answers.</span>
                    <Link to="/autoapply/account" className="aa-btn is-primary">Go to setup</Link>
                </div>
            )}
            {me.data && me.data.readiness ? (
                <ReadinessCard readiness={me.data.readiness} style={{ marginBottom: 16 }} />
            ) : me.data && onboarded && profileMissing.length > 0 && (
                <ProfileMissing
                    style={{ marginBottom: 16 }}
                    missing={profileMissing}
                    lead="Your profile is not complete. You can still buy, but the batch waits (no credit used, the credit validity still runs) until you finish it. Missing:"
                    cta="Finish your profile first"
                />
            )}

            <div className="aa-stack">
                <section className="aa-card" aria-labelledby="buy-kind">
                    <h2 id="buy-kind" className="aa-h2">1 · Companies</h2>
                    <div className="aa-grid-2" role="radiogroup" aria-label="Pack kind">
                        {Object.entries(PACK_KINDS).map(([k, meta]) => (
                            <button key={k} type="button" role="radio" aria-checked={kind === k} className="aa-choice" onClick={() => setKind(k)} disabled={busy}>
                                <span className="aa-choice-title">{meta.name}</span>
                                <span className="aa-muted">{meta.blurb}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="aa-card" aria-labelledby="buy-size">
                    <h2 id="buy-size" className="aa-h2">2 · Pack size</h2>
                    <div className="aa-grid" role="radiogroup" aria-label="Pack size">
                        {PACK_SIZES.map((s) => {
                            const p = packPrice(config, kind, s)
                            const over = s > remaining
                            return (
                                <button key={s} type="button" role="radio" aria-checked={size === s} className="aa-choice" onClick={() => setSize(s)} disabled={busy || over || p == null}>
                                    <span className="aa-choice-title">{s} applications</span>
                                    <span className="aa-choice-price">{p != null ? rupees(p) : 'Unavailable'}</span>
                                    <span className="aa-faint">{p != null ? `${rupees(p / s)} per application` : 'Price not set yet'}{over ? ' · over this month’s limit' : ''}</span>
                                </button>
                            )
                        })}
                    </div>
                    <div style={{ marginTop: 14 }}>
                        <div className="aa-spread aa-faint" style={{ marginBottom: 5 }}>
                            <span>This month: {num(u.month_purchased)} of {num(cap)} applications purchased</span>
                            <span>{num(remaining)} left</span>
                        </div>
                        <div className="aa-progress" role="progressbar" aria-label="Monthly purchase limit used" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={u.month_purchased || 0}>
                            <span style={{ width: `${cap ? Math.min(100, ((u.month_purchased || 0) / cap) * 100) : 0}%` }} />
                        </div>
                    </div>
                </section>

                <section className="aa-card" aria-labelledby="buy-window">
                    <h2 id="buy-window" className="aa-h2">3 · How fresh</h2>
                    <label className="field-label" htmlFor="buy-wd">Jobs posted in the last <span style={{ color: 'var(--pop)' }}>{wd} day{wd === 1 ? '' : 's'}</span></label>
                    <input id="buy-wd" type="range" className="aa-range" min={1} max={maxWindow} value={wd} onChange={(e) => setWindowDays(Number(e.target.value))} disabled={busy} aria-valuetext={`${wd} days`} />
                    <div className="field-hint">Fresher postings get more replies; a longer window finds more jobs.</div>
                </section>

                <section className="aa-card" aria-labelledby="buy-must">
                    <h2 id="buy-must" className="aa-h2">4 · Must-apply companies <span className="aa-faint" style={{ fontWeight: 600 }}>(optional)</span></h2>
                    <MustCompaniesInput
                        idPrefix="buy-must"
                        value={must}
                        onChange={setMust}
                        query={mustQuery}
                        onQuery={setMustQuery}
                        suggestions={suggest.data?.companies || []}
                        disabled={busy}
                    />
                </section>

                {me.data && <SupplyPanel kind={kind} windowDays={debouncedWd} size={size} />}

                <section className="aa-card is-pop" aria-labelledby="buy-total">
                    <h2 id="buy-total" className="aa-h2">Total</h2>
                    <div className="aa-row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                        <label className="aa-sr" htmlFor="buy-coupon">Coupon code</label>
                        <input id="buy-coupon" className="input-field" placeholder="Coupon code" value={couponInput} maxLength={40}
                            style={{ maxWidth: 200, textTransform: 'uppercase' }} disabled={busy}
                            onChange={(e) => { setCouponInput(e.target.value); setCoupon(null); setCouponErr('') }}
                            onKeyDown={(e) => { if (e.key === 'Enter') applyCoupon() }} />
                        <button type="button" className="aa-btn" onClick={applyCoupon} disabled={busy || !couponInput.trim() || couponQuote.isPending}>
                            {couponQuote.isPending ? 'Checking…' : 'Apply'}
                        </button>
                        {coupon && <span className="aa-chip">{coupon.code} · {coupon.kind === 'free_all' ? 'free pack' : '₹1 per application'}</span>}
                        {couponErr && <span className="aa-faint" role="alert" style={{ color: 'var(--danger, #f87171)' }}>{couponErr}</span>}
                    </div>
                    <div className="aa-spread">
                        <div>
                            <div className="aa-stat-value">
                                {price != null ? rupees(price) : '—'}
                                {coupon && listPrice != null && price !== listPrice && <span className="aa-faint" style={{ textDecoration: 'line-through', fontSize: '0.8rem', marginLeft: 8 }}>{rupees(listPrice)}</span>}
                            </div>
                            <div className="aa-faint">{PACK_KINDS[kind].name} · {size} applications · last {wd} days · GST included</div>
                        </div>
                        <button type="button" className="aa-btn is-primary" style={{ padding: '11px 18px' }} onClick={buy}
                            disabled={busy || !onboarded || !sizeOk || price == null || (profileMissing.length > 0 && !ackWait)}>
                            {stage === 'paying' ? 'Payment open…' : busy ? 'Working…' : price === 0 ? 'Get it free' : `Pay ${price != null ? rupees(price) : ''}`}
                        </button>
                    </div>
                    {onboarded && profileMissing.length > 0 && (
                        <label className="aa-row" style={{ marginTop: 10, gap: 8, fontSize: '0.76rem' }}>
                            <input type="checkbox" checked={ackWait} onChange={(e) => setAckWait(e.target.checked)} disabled={busy} />
                            <span>I understand this batch waits until my profile is complete.</span>
                        </label>
                    )}
                    <p className="aa-faint" style={{ margin: '10px 0 0' }}>
                        Credits are valid for {config.credit_validity_days ?? 90} days. Unused credits are refunded pro rata at expiry or when you cancel.
                    </p>
                    {note?.kind === 'eligible' && (
                        <div className="aa-note is-warn aa-spread" style={{ marginTop: 12 }} role="alert">
                            <span>{note.text && note.text !== 'not_eligible' ? note.text : 'AutoApply needs an active Pro or Max plan.'}</span>
                            <Link to="/pricing" className="aa-btn is-primary">Upgrade</Link>
                        </div>
                    )}
                    {note?.kind === 'cap' && (
                        <div className="aa-note is-warn" style={{ marginTop: 12 }} role="alert">
                            {note.text && note.text !== 'monthly_cap' ? note.text : `This pack would go over the ${num(cap)} applications per month limit.`} {num(remaining)} left this month; pick a smaller pack or wait for next month.
                        </div>
                    )}
                    {note?.kind === 'consent' && (
                        <div className="aa-note is-warn" style={{ marginTop: 12 }} role="alert">
                            {note.text} <Link to="/autoapply/account?step=consent" style={{ color: 'var(--pop)' }}>Go to the Confirm step</Link>
                        </div>
                    )}
                    {note?.kind === 'error' && <ErrorState compact message={note.text} style={{ marginTop: 12 }} />}
                </section>
            </div>
        </AALayout>
    )
}
