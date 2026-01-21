import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: 'all',
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        headers: {
          'ngrok-skip-browser-warning': 'true',
        },
      },
    },
    headers: {
      'ngrok-skip-browser-warning': 'true',
    },
  },
  resolve: {
    alias: {
      process: "process/browser",
      buffer: "buffer",
      stream: "stream-browserify",
    },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
})
