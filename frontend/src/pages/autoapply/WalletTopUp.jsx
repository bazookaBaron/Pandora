import { useState } from 'react'
import { Sheet } from '../../components/ui'
import { errorText } from '../../components/shared/states'
import { useAuth } from '../../contexts/AuthContext'
import { openRazorpayOrder } from '../../lib/razorpay'
import { track, TRACK } from '../../lib/track'
import { useTopupOrder, useVerifyTopup } from '../../lib/useAutoApply'
import { rupees } from './ui'
import './wallet.css'

const FALLBACK = { min_topup_paise: 30000, max_topup_paise: 5000000, topup_presets_paise: [50000, 100000, 200000] }

/**
 * "Add money" sheet: presets + custom amount (min ₹300), one-time Razorpay checkout, then POST /wallet/topup/verify.
 * Money only enters the wallet after the server has checked the order is paid (and the webhook is the safety net).
 * `shortfallPaise` pre-selects the smallest preset that covers it.
 */
export default function WalletTopUp({ open, onClose, wallet, shortfallPaise = 0, onDone }) {
    const { user } = useAuth()
    const cfg = { ...FALLBACK, ...(wallet ? { min_topup_paise: wallet.min_topup_paise, max_topup_paise: wallet.max_topup_paise, topup_presets_paise: wallet.presets_paise } : {}) }
    const presets = cfg.topup_presets_paise || FALLBACK.topup_presets_paise
    const suggested = presets.find((p) => p >= shortfallPaise) ?? presets[0]
    const [picked, setPicked] = useState(null) // preset paise | 'custom'
    const [custom, setCustom] = useState('')
    const [stage, setStage] = useState('') // '' | 'order' | 'paying' | 'verifying'
    const [err, setErr] = useState('')
    const createOrder = useTopupOrder()
    const verify = useVerifyTopup()

    const sel = picked ?? suggested
    const customPaise = Math.round((Number(custom) || 0) * 100)
    const amount = sel === 'custom' ? customPaise : sel
    const tooLow = amount < cfg.min_topup_paise
    const tooHigh = amount > cfg.max_topup_paise
    const busy = !!stage

    async function pay() {
        setErr('')
        if (tooLow || tooHigh) return
        setStage('order')
        track(TRACK.PAY_START, { pack: 'wallet', amount: Math.round(amount / 100) })
        let order
        try {
            order = await createOrder.mutateAsync(amount)
        } catch (e) {
            setStage('')
            setErr(errorText(e))
            return
        }
        setStage('paying')
        let resp
        try {
            resp = await openRazorpayOrder({ keyId: order.key_id, orderId: order.order_id, amount: order.amount, currency: order.currency || 'INR', description: 'Auto Apply wallet top-up', user })
        } catch (e) {
            setStage('')
            if (e?.code !== 'dismissed') setErr(e?.message || 'The payment did not go through.')
            return
        }
        setStage('verifying')
        try {
            await verify.mutateAsync({ razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature })
            track(TRACK.PAY_SUCCESS, { pack: 'wallet', amount: Math.round(amount / 100) })
            setStage('')
            setPicked(null)
            setCustom('')
            onDone?.()
            onClose()
        } catch (e) {
            setStage('')
            setErr(`We could not confirm the payment yet (${errorText(e)}). If you were charged, the money appears in your wallet shortly.`)
        }
    }

    return (
        <Sheet open={open} onClose={busy ? () => {} : onClose} title="Add money"
            description={`Minimum ${rupees(cfg.min_topup_paise)}. Money is only used after we submit an application.`}
            footer={(
                <button type="button" className="sys-tone-btn wl-pay" style={{ '--tone': 'var(--pop)' }} onClick={pay}
                    disabled={busy || tooLow || tooHigh} aria-busy={busy || undefined}>
                    {stage === 'paying' ? 'Payment open…' : busy ? 'Working…' : `Pay ${amount > 0 ? rupees(amount) : ''}`.trim()}
                </button>
            )}>
            <div className="wl-presets" role="radiogroup" aria-label="Amount">
                {presets.map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={sel === p} className={`wl-preset${sel === p ? ' is-on' : ''}`}
                        onClick={() => setPicked(p)} disabled={busy}>{rupees(p)}</button>
                ))}
                <button type="button" role="radio" aria-checked={sel === 'custom'} className={`wl-preset${sel === 'custom' ? ' is-on' : ''}`}
                    onClick={() => setPicked('custom')} disabled={busy}>Other</button>
            </div>
            {sel === 'custom' && (
                <div className="wl-custom">
                    <label className="field-label" htmlFor="wl-custom-amt">Amount in rupees</label>
                    <input id="wl-custom-amt" className="input-field" inputMode="numeric" autoFocus placeholder={`${cfg.min_topup_paise / 100} or more`}
                        value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} disabled={busy} />
                </div>
            )}
            {sel === 'custom' && customPaise > 0 && tooLow && <p className="buy-err" role="alert">The minimum is {rupees(cfg.min_topup_paise)}.</p>}
            {tooHigh && <p className="buy-err" role="alert">The maximum is {rupees(cfg.max_topup_paise)} per top-up.</p>}
            {err && <p className="buy-err" role="alert">{err}</p>}
        </Sheet>
    )
}
