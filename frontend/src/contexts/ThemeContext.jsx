import { createContext, useContext, useEffect, useState } from 'react'

// Light/dark theme. The grayscale palette lives in index.css under
// :root (dark, default) and :root[data-theme="light"]. This just flips the
// attribute on <html> and persists the choice. A tiny inline script in
// index.html applies the saved value before React mounts (no flash).

const ThemeContext = createContext({ theme: 'dark', toggleTheme: () => {} })

function readInitial() {
    try {
        const saved = localStorage.getItem('theme')
        if (saved === 'light' || saved === 'dark') return saved
    } catch { /* private mode / disabled storage */ }
    return 'dark'
}

export function ThemeProvider({ children }) {
    const [theme, setTheme] = useState(readInitial)

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme)
        try { localStorage.setItem('theme', theme) } catch { /* ignore */ }
    }, [theme])

    const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    return useContext(ThemeContext)
}
