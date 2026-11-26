// Shared arrow-key handling for Tabs and Segmented (roving tabindex, automatic activation).
// Returns the index to move to for a keydown, or -1 when the key is not handled.
// Disabled items (item.disabled) are skipped; movement wraps around.
export function nextIndex(key, current, items) {
    const n = items.length
    if (!n) return -1
    const enabled = (i) => !items[i]?.disabled
    const step = (from, dir) => {
        for (let k = 1; k <= n; k++) {
            const i = (((from + dir * k) % n) + n) % n
            if (enabled(i)) return i
        }
        return from
    }
    const first = () => { for (let i = 0; i < n; i++) if (enabled(i)) return i; return current }
    const last = () => { for (let i = n - 1; i >= 0; i--) if (enabled(i)) return i; return current }
    switch (key) {
        case 'ArrowRight': case 'ArrowDown': return step(current, 1)
        case 'ArrowLeft': case 'ArrowUp': return step(current, -1)
        case 'Home': return first()
        case 'End': return last()
        default: return -1
    }
}
