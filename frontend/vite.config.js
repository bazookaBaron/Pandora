import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_PORT = process.env.PORT || 3000

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/api': {
                target: `http://localhost:${API_PORT}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes('node_modules')) return
                    if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
                    if (/[\\/]node_modules[\\/]react-router(-dom)?[\\/]/.test(id)) return 'vendor-react'
                    if (/[\\/]node_modules[\\/](@tanstack[\\/]react-query|@supabase[\\/]supabase-js|posthog-js)[\\/]/.test(id)) return 'vendor-data'
                },
            },
        },
        chunkSizeWarningLimit: 900,
    },
})
