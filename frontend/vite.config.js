import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { compression } from 'vite-plugin-compression2'

const API_PORT = process.env.PORT || 3000

export default defineConfig({
    plugins: [
        react(),
        // Pre-compressed .br / .gz siblings of every built asset (served by
        // express-static-gzip in server.js; no per-request CPU).
        compression({ algorithms: ['brotliCompress', 'gzip'], threshold: 1024, exclude: [/\.(png|jpe?g|webp|avif|woff2?|mp4|br|gz)$/i] }),
    ],
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
                    if (/[\\/]node_modules[\\/](@tanstack[\\/]react-query|@supabase[\\/]supabase-js)[\\/]/.test(id)) return 'vendor-data'
                },
            },
        },
        chunkSizeWarningLimit: 900,
    },
})
