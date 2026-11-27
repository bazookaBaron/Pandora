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
 * Open Razorpay Standard Checkout for an order the caller ALREADY created
 * (e.g. AutoApply packs: POST /api/autoapply/orders). Resolves with the raw
 * Razorpay handler response { razorpay_order_id, razorpay_payment_id,
 * razorpay_signature }; the caller verifies it server-side. Rejects with an
 * Error whose `.code` is 'dismissed' | 'failed'.
 */
export async function openRazorpayOrder({ keyId, orderId, amount, currency = 'INR', description, user }) {
    await loadCheckoutScript()
    return new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
            key: keyId,
            order_id: orderId,
            amount,
            currency,
            name: 'Vloombox',
            description: description || 'Vloombox',
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
            handler: (resp) => resolve(resp),
        })
        rzp.on('payment.failed', (r) => {
            const e = new Error(r?.error?.description || 'The payment failed. Please try another method.')
            e.code = 'failed'
            reject(e)
        })
        rzp.open()
    })
}

/**
 * Entry point used by the pricing page. Plans are subscription-only: there is
 * no one-time fallback. When subscriptions are off / unconfigured the server
 * answers 503 and the caller shows "coming soon".
 */
export function startCheckout({ plan, billingPeriod, user }) {
    return startRazorpaySubscription({ plan, billingPeriod, user })
}

/**
 * Open Razorpay's in-page Checkout for a RECURRING subscription.
 *  - creates the subscription server-side (returns subscription_id)
 *  - opens the modal
 *  - on success, verifies the callback signature server-side
 *
 * Resolves with { ok, plan, status } on a verified payment. Rejects with an
 * Error whose `.code` is 'dismissed' | 'failed' | 'verify' | 'unconfigured'
 * | 'network'.
 */
export async function startRazorpaySubscription({ plan, billingPeriod, user }) {
    await loadCheckoutScript()

    let created
    try {
        created = await apiFetch('/api/subscriptions/create', { json: { plan, billingPeriod } })
    } catch (err) {
        const e = new Error(err?.body?.error === 'plan_not_configured'
            ? 'This plan isn’t available yet.'
            : (err?.message || 'Could not start the subscription.'))
        const code = err?.body?.error || ''
        e.code = /unconfigured/.test(code) ? 'unconfigured'
            : code === 'already_subscribed' || code === 'subscription_processing' ? 'already'
            : 'network'
        throw e
    }

    return new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
            key: created.keyId,
            subscription_id: created.subscription_id,
            name: 'Vloombox',
            description: `Vloombox ${plan[0].toUpperCase() + plan.slice(1)} (${billingPeriod}, renews automatically)`,
            image: '/vloombox-logo.svg',
            prefill: { email: user?.email || '', name: user?.user_metadata?.full_name || '' },
            theme: { color: '#22d3ee' },
            modal: {
                ondismiss: () => {
                    const e = new Error('Checkout closed.')
                    e.code = 'dismissed'
                    reject(e)
                },
            },
            handler: async (resp) => {
                try {
                    const verified = await apiFetch('/api/subscriptions/verify', {
                        timeout: 60_000,
                        json: {
                            razorpay_payment_id: resp.razorpay_payment_id,
                            razorpay_subscription_id: resp.razorpay_subscription_id,
                            razorpay_signature: resp.razorpay_signature,
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
