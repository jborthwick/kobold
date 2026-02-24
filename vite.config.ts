import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Using function form so we can call loadEnv — Vite does NOT auto-load .env.local
// into process.env inside vite.config.ts, so process.env.ANTHROPIC_API_KEY would
// be empty.  loadEnv(mode, cwd, '') loads all vars (no VITE_ prefix filter).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    worker: {
      format: 'es',
    },
    build: {
      target: 'esnext',
    },
    assetsInclude: ['**/*.tmx'],
    server: {
      proxy: {
        // /api/llm-proxy  →  https://api.anthropic.com/v1/messages
        // API key injected server-side via loadEnv; never exposed to browser
        '/api/llm-proxy': {
          target:       'https://api.anthropic.com',
          changeOrigin: true,
          rewrite:      () => '/v1/messages',
          headers: {
            'x-api-key':         env.ANTHROPIC_API_KEY ?? '',
            'anthropic-version': '2023-06-01',
            // Vite forwards the browser Origin header; Anthropic requires this
            // flag when it detects a cross-origin / browser-initiated request.
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        },
      },
    },
  }
})
