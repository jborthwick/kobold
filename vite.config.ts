import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Dev-only Vite plugin: handles POST /api/write-tile-config.
 * Regenerates src/game/tileConfig.ts from the posted JSON and optionally
 * appends new TileType enum values to src/shared/types.ts.
 * Never present in production builds (configureServer is dev-only).
 */
function tileConfigWriterPlugin(): Plugin {
  return {
    name: 'tile-config-writer',
    configureServer(server) {
      server.middlewares.use('/api/write-tile-config', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const {
              tileConfig,   // Record<string, number[]>  — terrain type → frames
              spriteConfig, // Record<string, number>    — sprite key → frame
              newTypes,     // string[]                  — new TileType enum values to add
            } = JSON.parse(body) as {
              tileConfig:   Record<string, number[]>;
              spriteConfig: Record<string, number>;
              newTypes:     string[];
            };

            const root = path.resolve(__dirname, 'src');

            // ── 1. Regenerate tileConfig.ts ──────────────────────────────
            const tileLines = Object.entries(tileConfig)
              .map(([k, v]) => `  [TileType.${k}]: [${v.join(', ')}],`)
              .join('\n');
            const spriteLines = Object.entries(spriteConfig)
              .map(([k, v]) => `  ${k}: ${v},`)
              .join('\n');

            const tileConfigSrc = [
              '// AUTO-MANAGED by tile picker (T key in-game → Save).',
              '// Manual edits are safe but will be overwritten on next Save.',
              "import { TileType } from '../shared/types';",
              '',
              '/**',
              ' * Frame arrays per tile type.',
              ' * - Single entry  → that frame is always used.',
              ' * - Multiple entries → one is chosen per-tile by position noise (variation).',
              ' *',
              ' * Frame index = row * 49 + col  (0-based, 49 cols × 22 rows, 16×16 px, no spacing).',
              ' */',
              'export const TILE_CONFIG: Partial<Record<TileType, number[]>> = {',
              tileLines,
              '};',
              '',
              '/** Single-frame sprite assignments for non-terrain game objects. */',
              'export const SPRITE_CONFIG: Record<string, number> = {',
              spriteLines,
              '};',
              '',
            ].join('\n');

            fs.writeFileSync(path.join(root, 'game', 'tileConfig.ts'), tileConfigSrc, 'utf8');

            // ── 2. Append new TileType enum values (if any) ──────────────
            if (newTypes && newTypes.length > 0) {
              const typesPath = path.join(root, 'shared', 'types.ts');
              let typesSrc = fs.readFileSync(typesPath, 'utf8');

              for (const name of newTypes) {
                // Only add if not already present
                if (!typesSrc.includes(`${name} =`)) {
                  typesSrc = typesSrc.replace(
                    /^(export enum TileType \{[^}]*)(})/ms,
                    (_match, body, closing) =>
                      `${body}  ${name} = '${name.toLowerCase()}',\n${closing}`,
                  );
                }
              }
              fs.writeFileSync(typesPath, typesSrc, 'utf8');
            }

            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            console.error('[tile-config-writer]', err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });
    },
  };
}

// https://vite.dev/config/
// Using function form so we can call loadEnv — Vite does NOT auto-load .env.local
// into process.env inside vite.config.ts, so process.env.ANTHROPIC_API_KEY would
// be empty.  loadEnv(mode, cwd, '') loads all vars (no VITE_ prefix filter).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    // GitHub Pages serves at /kobold/ — base path needed for correct asset URLs.
    // In dev mode this is ignored (Vite defaults to '/').
    base: mode === 'production' ? '/kobold/' : '/',
    plugins: [react(), tileConfigWriterPlugin()],
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
        // Anthropic (Claude) — /api/llm-proxy → api.anthropic.com/v1/messages
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
        // Groq (Llama) — /api/groq-proxy → api.groq.com/openai/v1/chat/completions
        '/api/groq-proxy': {
          target:       'https://api.groq.com',
          changeOrigin: true,
          rewrite:      () => '/openai/v1/chat/completions',
          headers: {
            'Authorization': `Bearer ${env.GROQ_API_KEY ?? ''}`,
          },
        },
      },
    },
  }
})
