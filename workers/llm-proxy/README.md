# Kobold LLM edge proxy

Forces API keys to stay server-side when the game is hosted on **GitHub Pages** (static hosting has no Vite `/api/*` proxy).

## Deploy (Cloudflare dashboard)

1. Workers & Pages → Create → Worker → paste the contents of `src/index.ts` (module worker export default `{ fetch }`).
2. Settings → Variables → **Secrets**: add `GROQ_API_KEY` (and optionally `ANTHROPIC_API_KEY`).
3. Settings → Variables → **Plaintext**: `ALLOWED_ORIGINS` = `https://YOURUSER.github.io` (comma-separated if multiple sites).
4. Save and deploy. Your endpoints are:
   - `https://<worker-subdomain>.workers.dev/groq`
   - `https://<worker-subdomain>.workers.dev/anthropic`

## Deploy (Wrangler CLI)

```bash
cd workers/llm-proxy
npx wrangler deploy
npx wrangler secret put GROQ_API_KEY
# optional:
npx wrangler secret put ANTHROPIC_API_KEY
```

Set `ALLOWED_ORIGINS` in the Cloudflare dashboard or in `wrangler.toml` under `[vars]` (no secrets there).

## Wire the game

Set repository **Actions secrets** (or **Variables**) used at build time:

- `VITE_GROQ_PROXY_URL` — full URL, e.g. `https://kobold-llm.youraccount.workers.dev/groq`
- `VITE_ANTHROPIC_PROXY_URL` — optional, e.g. `https://kobold-llm.youraccount.workers.dev/anthropic`

Then rebuild the Pages site. Local `npm run dev` still uses Vite’s proxy when these are unset.
