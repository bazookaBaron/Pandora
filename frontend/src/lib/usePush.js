import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPushKey, pushSubscribe, pushUnsubscribe } from './useAutoApply'
import { toast } from './toast'

// Web push for the AutoApply inbox. Status: 'unsupported' | 'unavailable' (server has no VAPID keys)
// | 'denied' | 'off' | 'on' | 'working'. Every browser API call is guarded; this never throws into the UI.

const supported = () =>
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function keyToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4)
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function registration() {
    const existing = await navigator.serviceWorker.getRegistration('/')
    return existing || navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

export function usePush() {
    const [status, setStatusRaw] = useState(supported() ? 'working' : 'unsupported')
    const [error, setErrorRaw] = useState(null)
    // enable()/disable() await permission prompts and network calls; the
    // component may unmount meanwhile (navigating away), so never setState then.
    const mounted = useRef(true)
    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])
    const setStatus = useCallback((v) => { if (mounted.current) setStatusRaw(v) }, [])
    const setError = useCallback((v) => { if (mounted.current) setErrorRaw(v) }, [])

    useEffect(() => {
        if (!supported()) return undefined
        let alive = true
        ;(async () => {
            try {
                const { enabled } = await fetchPushKey()
                if (!alive) return
                if (!enabled) return setStatus('unavailable')
                if (Notification.permission === 'denied') return setStatus('denied')
                const reg = await navigator.serviceWorker.getRegistration('/')
                const sub = reg ? await reg.pushManager.getSubscription() : null
                if (alive) setStatus(sub && Notification.permission === 'granted' ? 'on' : 'off')
            } catch {
                if (alive) setStatus('off')
            }
        })()
        return () => { alive = false }
    }, [])

    const enable = useCallback(async () => {
        setError(null)
        setStatus('working')
        try {
            const { enabled, key } = await fetchPushKey()
            if (!enabled || !key) { setStatus('unavailable'); return }
            const perm = await Notification.requestPermission()
            if (perm !== 'granted') { setStatus(perm === 'denied' ? 'denied' : 'off'); return }
            const reg = await registration()
            await navigator.serviceWorker.ready
            const sub = (await reg.pushManager.getSubscription())
                || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToUint8(key) }))
            await pushSubscribe(sub.toJSON())
            setStatus('on')
            toast.success('Notifications are on for this device.')
        } catch (e) {
            setError(e)
            setStatus('off')
        }
    }, [setStatus, setError])

    const disable = useCallback(async () => {
        setError(null)
        setStatus('working')
        try {
            const reg = await navigator.serviceWorker.getRegistration('/')
            const sub = reg ? await reg.pushManager.getSubscription() : null
            if (sub) {
                await pushUnsubscribe(sub.endpoint)
                await sub.unsubscribe()
            }
            setStatus('off')
            toast.success('Notifications turned off.')
        } catch (e) {
            setError(e)
            setStatus('on')
        }
    }, [setStatus, setError])

    return { status, error, enable, disable }
}
