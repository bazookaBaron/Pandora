import { apiFetch } from './apiClient'

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'
let scriptPromise = null

function loadCheckoutScript() {
    if (window.Razorpay) return Promise.resolve()
    if (scriptPromise) return scriptPromise
    scriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = SCRIPT_SRC
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => { scriptPromise = null; reject(new Error('Could not load the payment SDK.')) }
        document.body.appendChild(s)
    })
    return scriptPromise
}

/**
 * Open Razorpay Standard Checkout for a plan/period.
 *  - creates an order server-side (amount + key come from the server)
 *  - opens the modal
 *  - on success, verifies the signature server-side and resolves
 *
 * Resolves with { ok, plan, current_period_end } on a verified payment.
 * Rejects with an Error whose `.code` is 'dismissed' | 'failed' | 'verify' |
 * 'unconfigured' | 'network' for the caller to message appropriately.
 */
export async function startRazorpayCheckout({ plan, billingPeriod, user }) {
    await loadCheckoutScript()

    let order
    try {
        order = await apiFetch('/api/payments/razorpay/order', { json: { plan, billingPeriod } })
    } catch (err) {
        const e = new Error(err?.body?.error || err?.message || 'Could not start checkout.')
        e.code = err?.body?.error === 'checkout_unconfigured' ? 'unconfigured' : 'network'
        throw e
    }

    return new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
            key: order.keyId,
            order_id: order.order_id,
            amount: order.amount,
            currency: order.currency,
            name: 'Vloombox',
            description: `${plan[0].toUpperCase() + plan.slice(1)} plan · ${billingPeriod}`,
            image: '/vloombox-logo.svg',
            prefill: { email: user?.email || '', name: user?.user_metadata?.full_name || '' },
            theme: { color: '#22d3ee' },
            modal: {
                ondismiss: () => {
                    const e = new Error('Payment cancelled.')
                    e.code = 'dismissed'
                    reject(e)
                },
            },
            handler: async (resp) => {
                try {
                    const verified = await apiFetch('/api/payments/razorpay/verify', {
                        json: {
                            razorpay_order_id: resp.razorpay_order_id,
                            razorpay_payment_id: resp.razorpay_payment_id,
                            razorpay_signature: resp.razorpay_signature,
                            plan,
                            billingPeriod,
                        },
                    })
                    resolve(verified)
                } catch (err) {
                    const e = new Error(err?.body?.error === 'signature_mismatch'
                        ? 'We could not verify that payment. If you were charged, contact support.'
                        : 'Payment verification failed. If you were charged, contact support.')
                    e.code = 'verify'
                    reject(e)
                }
            },
        })
        rzp.on('payment.failed', (r) => {
            const e = new Error(r?.error?.description || 'The payment failed. Please try another method.')
            e.code = 'failed'
            reject(e)
        })
        rzp.open()
    })
}
