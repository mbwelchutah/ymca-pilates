import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const BACKEND = 'http://localhost:5001'

const backendPaths = [
  '/api',
  '/status',
  '/add-job',
  '/update-job',
  '/delete-job',
  '/toggle-active',
  '/pause-scheduler',
  '/resume-scheduler',
  '/set-dry-run',
  '/force-run-job',
  '/run-job',
  '/run-scheduler-once',
  '/run-selected-scheduler',
  '/refresh-schedule',
  '/screenshots',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5000,
    host: '0.0.0.0',
    allowedHosts: true,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    proxy: Object.fromEntries(
      backendPaths.map(p => [p, { target: BACKEND, changeOrigin: true }])
    ),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
