import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'configure-server',
      configureServer(server) {
        // Completely bypass host check
        server.httpServer?.on('upgrade', (req) => {
          // Allow all WebSocket upgrades
          req.headers.host = 'localhost:5173';
        });
        
        server.middlewares.use((req, res, next) => {
          // Override host header to bypass check
          const originalHost = req.headers.host;
          req.headers.host = 'localhost:5173';
          
          // Continue with modified request
          next();
        });
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    cors: true,
    hmr: {
      protocol: 'wss',
      host: undefined,
      port: 443,
      clientPort: 443,
    },
    preview: {
      allowedHosts: 'true',
    },
    allowedHosts: 'true',
    watch: {
      usePolling: false,
    },
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    cors: true,
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
