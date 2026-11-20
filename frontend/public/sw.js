/* Vloombox service worker: web push for the AutoApply inbox only.
   No fetch handler and no caching on purpose, so it cannot serve stale app files. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
    let data = {}
    try { data = event.data ? event.data.json() : {} } catch { data = {} }
    const title = data.title || 'Vloombox inbox'
    event.waitUntil(
        self.registration.showNotification(title, {
            body: data.body || 'You have a new message.',
            tag: data.tag || 'vloombox-inbox',
            icon: '/favicon.svg',
            data: { url: data.url || '/autoapply/inbox' },
        }),
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const url = new URL((event.notification.data && event.notification.data.url) || '/autoapply/inbox', self.location.origin).href
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const c of list) {
                if (c.url === url && 'focus' in c) return c.focus()
            }
            for (const c of list) {
                // navigate() rejects for a tab this worker does not control (includeUncontrolled): open a window then.
                if ('navigate' in c && 'focus' in c) {
                    return c.navigate(url).then((w) => (w ? w.focus() : self.clients.openWindow(url))).catch(() => self.clients.openWindow(url))
                }
            }
            return self.clients.openWindow(url)
        }),
    )
})
