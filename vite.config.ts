import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
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
      // /api/llm  →  https://api.anthropic.com/v1/messages
      // API key injected server-side; never exposed to browser bundle
      '/api/llm-proxy': {
        target:       'https://api.anthropic.com',
        changeOrigin: true,
        rewrite:      () => '/v1/messages',
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
        },
      },
    },
  },
})
