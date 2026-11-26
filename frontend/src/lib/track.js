// ── First-party funnel events (WS-M0) ───────────────────────────────
// track(event, props) queues an event and sends batches to POST /api/events
// (server.js -> public.ui_events, sql/48_ui_events.sql). No third party.
//
//   import { track, TRACK } from '../lib/track'
//   track(TRACK.CTA_CLICK, { id: 'see_packs', section: 'autoapply' })
//
// Rules:
//  • Only the event names in TRACK are sent; anything else is dropped (warns in dev).
//  • props: flat object of short strings / numbers / booleans. Keys that look
//    personal (email, name, phone, resume, token…) are dropped, strings are cut
//    to 120 chars and the whole props object to ~1KB. Never pass personal data.
//  • Who: a random anonymous id (localStorage `vb_anon_v1`) and, when signed in,
//    the user id the SERVER reads from the verified bearer token. The client never
//    sends a user id itself.
//  • Delivery: batched (2s or 10 events), flushed on tab hide. Signed in ->
//    fetch(keepalive) with the bearer token; signed out -> navigator.sendBeacon.
//  • Fails silently. Bots / automation are never tracked.
import { supabase } from './supabase'
import { sectionFor } from './sections'

export const TRACK = {
    TAB_VIEW: 'tab_view',             // { tab: section id, from: 'bottom_nav' | 'top_nav' }
    CTA_CLICK: 'cta_click',           // { id: short cta id }
    SETUP_STEP: 'setup_step',         // { step: number, of: number, label? }
    BUY_VIEW: 'buy_view',             // { pack?: 'service' | 'product', size?: 50 | 100 }
    PAY_START: 'pay_start',           // { pack?, size?, amount? (rupees) }
    PAY_SUCCESS: 'pay_success',       // { pack?, size?, amount? }
    BRIDGE_CLICK: 'bridge_click',     // { id: NextStep id, to: section id }
    FIRST_VISIT_PICK: 'first_visit_pick', // { choice: section id }
}
export const TRACK_EVENTS = Object.values(TRACK)
const ALLOWED = new Set(TRACK_EVENTS)

const ENDPOINT = '/api/events'
const ANON_KEY = 'vb_anon_v1'
const FLUSH_MS = 2000
const MAX_BATCH = 10
const MAX_QUEUE = 50
const MAX_STR = 120
const MAX_PROPS_BYTES = 1000
const DENY_KEY = /(pass|pwd|token|secret|key|auth|email|mail|phone|name|address|resume|cv|answer|text|body|content|code|card|upi|account)/i
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|quora|pinterest|vkshare|whatsapp|telegram|discord|skype/i

const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined'

/** True for crawlers, link unfurlers and automation (no tracking, no first-visit picker). */
export function isBot() {
    if (!isBrowser) return true
    try {
        if (navigator.webdriver) return true
        return BOT_UA.test(navigator.userAgent || '')
    } catch {
        return true
    }
}

let anonId = null
function getAnonId() {
    if (anonId) return anonId
    try {
        anonId = window.localStorage.getItem(ANON_KEY)
    } catch { /* storage blocked */ }
    if (!anonId || !/^[a-z0-9]{8,40}$/.test(anonId)) {
        anonId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24)
        try { window.localStorage.setItem(ANON_KEY, anonId) } catch { /* in-memory only */ }
    }
    return anonId
}

// Keep the current access token in memory so a flush on tab hide stays synchronous.
let token = null
let authWired = false
function wireAuth() {
    if (authWired || !isBrowser) return
    authWired = true
    try {
        supabase.auth.getSession().then(({ data }) => { token = data?.session?.access_token || null }).catch(() => {})
        supabase.auth.onAuthStateChange((_evt, session) => { token = session?.access_token || null })
    } catch { /* supabase not configured: anonymous only */ }
}

function cleanProps(props) {
    const out = {}
    if (!props || typeof props !== 'object') return out
    for (const [k, v] of Object.entries(props)) {
        if (typeof k !== 'string' || k.length > 40 || DENY_KEY.test(k)) continue
        if (typeof v === 'string') out[k] = v.slice(0, MAX_STR)
        else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
        else if (typeof v === 'boolean') out[k] = v
    }
    // hard cap the serialized size: drop keys from the end until it fits
    let keys = Object.keys(out)
    while (keys.length && JSON.stringify(out).length > MAX_PROPS_BYTES) {
        delete out[keys.pop()]
    }
    return out
}

let queue = []
let timer = null

function send(batch) {
    if (!batch.length) return
    const body = JSON.stringify({ anon_id: getAnonId(), events: batch })
    try {
        if (token && typeof fetch === 'function') {
            fetch(ENDPOINT, {
                method: 'POST',
                keepalive: true,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body,
            }).catch(() => {})
            return
        }
        if (navigator.sendBeacon) {
            const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
            if (ok) return
        }
        fetch(ENDPOINT, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {})
    } catch { /* never throw from analytics */ }
}

/** Send everything queued now (also runs on tab hide). */
export function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    while (queue.length) send(queue.splice(0, MAX_BATCH))
}

let listening = false
function listen() {
    if (listening || !isBrowser) return
    listening = true
    const onHide = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
}

/**
 * Queue one funnel event. `props.section` overrides the section derived from the URL.
 * Returns true when queued (false for unknown events, bots or SSR).
 */
export function track(event, props = {}) {
    if (!ALLOWED.has(event)) {
        if (import.meta.env.DEV) console.warn(`[track] unknown event "${event}" dropped; use TRACK.*`)
        return false
    }
    if (isBot()) return false
    wireAuth()
    listen()
    const path = (window.location.pathname || '/').slice(0, 200)
    const clean = cleanProps(props)
    const section = typeof clean.section === 'string' ? clean.section : sectionFor(path).id
    delete clean.section
    queue.push({ event, path, section, props: clean })
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
    if (queue.length >= MAX_BATCH) flush()
    else if (!timer) timer = setTimeout(flush, FLUSH_MS)
    return true
}

export default track
