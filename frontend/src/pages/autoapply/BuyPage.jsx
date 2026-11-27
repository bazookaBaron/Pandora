import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ListFilter, Search } from 'lucide-react'
import { ErrorState, errorText } from '../../components/shared/states'
import { HelpChip, PageHeader, Row, Sheet, StatusBanner } from '../../components/ui'
import { track, TRACK } from '../../lib/track'
import { useAutoApplyMe, useCompanySuggest, useStartBatch, useSupply, useWallet } from '../../lib/useAutoApply'
import { TIERS } from '../../../config/tiers.js'
import { AALayout, BATCH_SIZES, MustCompaniesInput, PRICE_LINE, fmtDate, matchShown, rupees, setupLinkFor } from './ui'
import WalletTopUp from './WalletTopUp'
import './buy.css'
import './wallet.css'

function useDebounced(value, ms) {
    const [v, setV] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms)
        return () => clearTimeout(t)
    }, [value, ms])
    return v
}

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

function MatchesSheet({ open, onClose, supply, size }) {
    const d = supply
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
            <p className="aa-muted" style={{ marginTop: 8 }}>We keep applying to matching jobs until the batch is done or no new matches turn up.</p>
        </Sheet>
    )
}

/** Start a batch from the wallet: size 25 / 50 / 100, matching your profile. No up-front charge. */
export default function BuyPage() {
    const me = useAutoApplyMe()
    const wallet = useWallet()
    const navigate = useNavigate()
    const [params] = useSearchParams()
    const start = useStartBatch()
    const [topup, setTopup] = useState(false)
    const [sheet, setSheet] = useState(null) // 'matches' | 'options'

    const config = me.data?.config || {}
    const maxWindow = config.window_days_max ?? 30
    const sizes = config.wallet?.batch_sizes || BATCH_SIZES
    // "Start again with remaining" pre-fills size, window and must-apply companies (?size=&days=&must=)
    const qSize = Number(params.get('size'))
    const qDays = Number(params.get('days'))
    const [size, setSize] = useState(BATCH_SIZES.includes(qSize) ? qSize : 50)
    const [windowDays, setWindowDays] = useState(Number.isInteger(qDays) && qDays >= 1 && qDays <= 30 ? qDays : null)
    const [must, setMust] = useState(() => (params.get('must') || '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 10))
    const [mustQuery, setMustQuery] = useState('')
    const [note, setNote] = useState(null)

    useEffect(() => {
        if (windowDays === null && me.data) setWindowDays(config.window_days_default ?? 30)
    }, [me.data, windowDays, config.window_days_default])
    const wd = windowDays ?? 30
    const debouncedWd = useDebounced(wd, 350)
    const suggest = useCompanySuggest(useDebounced(mustQuery, 250))

    const supplyWd = me.data && windowDays !== null && debouncedWd === wd ? debouncedWd : 0
    const supplyService = useSupply('service', supplyWd, size)
    const supplyProduct = useSupply('product', supplyWd, size)
    const supplyLoading = supplyService.isLoading || supplyProduct.isLoading
    const supplyData = supplyService.data || supplyProduct.data
        ? {
            count: (supplyService.data?.count || 0) + (supplyProduct.data?.count || 0),
            sample: [...(supplyProduct.data?.sample || []), ...(supplyService.data?.sample || [])].slice(0, 5),
            widened_parts: supplyProduct.data?.widened_parts || supplyService.data?.widened_parts,
            widened_window_days: supplyService.data?.widened_window_days,
        }
        : null

    const viewed = useRef(false)
    useEffect(() => {
        if (viewed.current || !me.data) return
        viewed.current = true
        track(TRACK.BUY_VIEW, { pack: 'wallet', size })
    }, [me.data, size])

    const eligible = !!me.data?.eligible
    const onboarded = !!me.data?.onboarding_done
    const check = me.data?.profile_check
    const profileMissing = check && !check.ok ? check.missing || [] : []
    const minStart = wallet.data?.min_start_paise ?? config.wallet?.rate_paise?.product ?? 1800
    const balance = wallet.data?.balance_paise
    const shortfall = balance == null ? 0 : Math.max(0, minStart - balance)
    const needsFunds = balance != null && shortfall > 0
    const needsPlan = !!me.data && !eligible
    const busy = start.isPending

    async function begin() {
        setNote(null)
        track(TRACK.PAY_START, { pack: 'wallet', size })
        try {
            const out = await start.mutateAsync({ size, window_days: wd, must_companies: must })
            track(TRACK.PAY_SUCCESS, { pack: 'wallet', size, amount: 0 })
            navigate(out?.batch?.id ? `/autoapply/batches/${out.batch.id}?new=1` : '/autoapply')
        } catch (err) {
            if (err?.code === 'insufficient_balance') { wallet.refetch(); setTopup(true) }
            else if (err?.status === 403 || err?.code === 'not_eligible') setNote({ kind: 'eligible', text: err.message })
            else if (err?.code === 'consent_required') setNote({ kind: 'consent', text: errorText(err) })
            else if (err?.status === 409 || err?.code === 'monthly_cap') setNote({ kind: 'cap', text: err.message })
            else setNote({ kind: 'error', text: errorText(err) })
        }
    }

    let banner = null
    if (me.data && !onboarded) {
        banner = <StatusBanner tone="warn" text="Finish setup before you start" action={{ label: 'Finish setup', to: '/autoapply/account' }} />
    } else if (me.data && profileMissing.length > 0) {
        banner = <StatusBanner tone="warn" text={`${profileMissing.length} profile item${profileMissing.length === 1 ? '' : 's'} left. The batch waits until done.`} action={{ label: 'Fix', to: setupLinkFor(profileMissing) }} />
    }

    return (
        <AALayout>
            <PageHeader section="autoapply" title="Start a batch" subtitle="We apply to jobs that match your profile." back={{ to: '/autoapply', label: 'Auto Apply' }}
                aside={<HelpChip term="pack" />} />

            {banner && <div className="aa-gap">{banner}</div>}

            <div className="buy-size" role="radiogroup" aria-label="Batch size">
                {sizes.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={size === s} className="buy-size-opt" onClick={() => setSize(s)} disabled={busy}>
                        {s} jobs
                    </button>
                ))}
            </div>

            <p className="wl-note" style={{ margin: '4px 0 12px' }}>
                {PRICE_LINE(config)}.{' '}
                <span className={supplyData && supplyData.count < size ? 'buy-card-low' : 'buy-card-match'}>
                    {supplyLoading && !supplyData ? 'Counting matching jobs…' : supplyData ? `${matchShown(supplyData.count, size)} matching jobs` : ''}
                </span>
            </p>

            {needsPlan && (
                <p className="buy-plan" role="note">
                    Needs a Pro or Max plan{proMonthly ? ` (from ${rupees(proMonthly)}/mo)` : ''}. <Link to="/pricing">See plans</Link>
                </p>
            )}

            <ul className="sys-rows buy-rows">
                <li><Row leading={<Search size={18} />} title="See matching jobs" onClick={() => setSheet('matches')} /></li>
                <li><Row leading={<ListFilter size={18} />} title="More options" sub={must.length ? `${must.length} must-apply companies` : `Jobs from the last ${wd} days`} onClick={() => setSheet('options')} /></li>
            </ul>

            {note?.kind === 'eligible' && (
                <StatusBanner tone="warn" className="aa-gap" text={note.text && note.text !== 'not_eligible' ? note.text : 'Auto Apply needs an active Pro or Max plan.'} action={{ label: 'See plans', to: '/pricing' }} />
            )}
            {note?.kind === 'cap' && <StatusBanner tone="warn" className="aa-gap" text={note.text} />}
            {note?.kind === 'consent' && (
                <StatusBanner tone="warn" className="aa-gap" text={note.text} action={{ label: 'Open setup', to: '/autoapply/account?step=review' }} />
            )}
            {note?.kind === 'error' && <ErrorState compact message={note.text} style={{ marginBottom: 12 }} />}

            <div className="buy-bar" aria-label="Start">
                <div className="buy-bar-total">
                    <strong>{balance == null ? '—' : rupees(balance)}</strong>
                    <span>{needsFunds ? 'Wallet empty. Add money to start.' : 'in your wallet · used only for applications we submit'}</span>
                </div>
                {needsPlan ? (
                    <Link to="/pricing" className="sys-tone-btn buy-bar-btn" onClick={() => track(TRACK.CTA_CLICK, { id: 'buy_needs_plan', section: 'autoapply' })}>Get Pro</Link>
                ) : needsFunds ? (
                    <button type="button" className="sys-tone-btn buy-bar-btn" onClick={() => setTopup(true)}>Add money</button>
                ) : (
                    <button type="button" className="sys-tone-btn buy-bar-btn" onClick={begin} disabled={busy || !onboarded || balance == null} aria-busy={busy || undefined}>
                        {busy ? 'Starting…' : `Start ${size} jobs`}
                    </button>
                )}
            </div>
            {!needsPlan && !needsFunds && (
                <p className="wl-note" style={{ marginTop: 8 }}>
                    <button type="button" className="buy-code-link" onClick={() => setTopup(true)}>Add money</button>
                </p>
            )}

            <MatchesSheet open={sheet === 'matches'} onClose={() => setSheet(null)} supply={supplyData} size={size} />
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
            <WalletTopUp open={topup} onClose={() => setTopup(false)} wallet={wallet.data} shortfallPaise={shortfall} />
        </AALayout>
    )
}
