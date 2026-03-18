/**
 * Edge proxy for Kobold storyteller LLM calls (GitHub Pages has no /api/*).
 * POST .../groq → Groq chat/completions
 * POST .../anthropic → Anthropic messages
 */

export interface Env {
  GROQ_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Comma-separated origins; empty = reflect request Origin or * */
  ALLOWED_ORIGINS?: string;
}

const MAX_BODY_BYTES = 48_000;
const MAX_TOKENS = 256;

function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(allowOrigin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
}

function pickCorsOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  if (allowed.length === 0) {
    return origin || '*';
  }
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0]!;
}

function clampBody(obj: Record<string, unknown>): void {
  const mt = obj.max_tokens;
  if (typeof mt === 'number' && mt > MAX_TOKENS) obj.max_tokens = MAX_TOKENS;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsOrigin = pickCorsOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const segment = path.split('/').pop() ?? '';

    const len = Number(request.headers.get('content-length') ?? 0);
    if (len > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'Body too large' }), {
        status: 413,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }

    let text: string;
    try {
      text = await request.text();
    } catch {
      return new Response(JSON.stringify({ error: 'Read failed' }), {
        status: 400,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }
    if (text.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'Body too large' }), {
        status: 413,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }
    clampBody(body);
    const forwardBody = JSON.stringify(body);

    if (segment === 'groq') {
      const key = env.GROQ_API_KEY;
      if (!key) {
        return new Response(JSON.stringify({ error: 'Groq not configured' }), {
          status: 503,
          headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
        });
      }
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: forwardBody,
      });
      const out = await res.text();
      return new Response(out, {
        status: res.status,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }

    if (segment === 'anthropic') {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) {
        return new Response(JSON.stringify({ error: 'Anthropic not configured' }), {
          status: 503,
          headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
        });
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: forwardBody,
      });
      const out = await res.text();
      return new Response(out, {
        status: res.status,
        headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Use POST .../groq or .../anthropic' }), {
      status: 404,
      headers: { ...corsHeaders(corsOrigin), 'content-type': 'application/json' },
    });
  },
};
