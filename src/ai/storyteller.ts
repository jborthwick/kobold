/**
 * Storyteller AI — narrator that writes chapter summaries on goal completion.
 *
 * Fires once per colony goal cycle. Falls back to deterministic text if LLM is
 * disabled or fails.
 */

import type { Goblin, Adventurer, ColonyGoal, LogEntry } from '../shared/types';
import { bus } from '../shared/events';
import { getGoblinConfig } from '../shared/goblinConfig';
import {
  STORYTELLER_SYSTEM_PROMPT,
  buildStorytellerUserPrompt,
  selectChapterEvents,
} from './storytellerPrompt';

const STORYTELLER_TEMPERATURE = 0.88;

// ── Personas ──────────────────────────────────────────────────────────────────
// Modifier text lives in storytellerPrompt (STORYTELLER_PERSONA_MODIFIERS).

export interface StorytellerPersona {
  id: string;
  name: string;
}

export const STORYTELLER_PERSONAS: StorytellerPersona[] = [
  { id: 'balanced', name: 'Balanced' },
  { id: 'chaotic', name: 'Chaotic' },
];

let currentPersonaId: string = 'balanced';

export function setStorytellerPersona(id: string) {
  if (STORYTELLER_PERSONAS.some(p => p.id === id)) currentPersonaId = id;
}
export function getStorytellerPersona(): StorytellerPersona {
  return STORYTELLER_PERSONAS.find(p => p.id === currentPersonaId) ?? STORYTELLER_PERSONAS[0];
}

// ── LLM Config ────────────────────────────────────────────────────────────────

let enabled = true;
let provider: 'anthropic' | 'groq' = 'groq';
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCallCount = 0;
let lastCallTick = 0;
const COOLDOWN_TICKS = 300;

/** Production (e.g. GitHub Pages): set VITE_* at build time to your edge worker URLs. */
function groqProxyUrl(): string {
  const v = import.meta.env.VITE_GROQ_PROXY_URL;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '/api/groq-proxy';
}

function anthropicProxyUrl(): string {
  const v = import.meta.env.VITE_ANTHROPIC_PROXY_URL;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '/api/llm-proxy';
}

const PROVIDERS = {
  anthropic: {
    get url() {
      return anthropicProxyUrl();
    },
    model: 'claude-haiku-4-5',
    extractText: (data: { content?: Array<{ text?: string }> }) => data.content?.[0]?.text,
    extractUsage: (data: { usage?: { input_tokens?: number; output_tokens?: number } }) => ({
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    }),
  },
  groq: {
    get url() {
      return groqProxyUrl();
    },
    model: 'llama-3.1-8b-instant',
    extractText: (data: { choices?: Array<{ message?: { content?: string } }> }) =>
      data.choices?.[0]?.message?.content,
    extractUsage: (data: { usage?: { prompt_tokens?: number; completion_tokens?: number } }) => ({
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    }),
  },
};

export function setStorytellerEnabled(val: boolean) {
  enabled = val;
}
export function setStorytellerProvider(p: 'anthropic' | 'groq') {
  provider = p;
}
export function getStorytellerEnabled() {
  return enabled;
}

/** @deprecated Use selectChapterEvents — alias for backwards compatibility */
export function filterSignificantEvents(
  logHistory: LogEntry[],
  lastChapterTick: number,
): string[] {
  return selectChapterEvents(logHistory, lastChapterTick);
}

export {
  STORYTELLER_SYSTEM_PROMPT,
  selectChapterEvents,
  buildStorytellerUserPrompt,
} from './storytellerPrompt';

// ── Storyteller LLM call ─────────────────────────────────────────────────────

export async function callStorytellerLLM(
  completedGoal: ColonyGoal,
  goblins: Goblin[],
  adventurers: Adventurer[],
  eventLines: string[],
  currentTick?: number,
): Promise<string | null> {
  if (!enabled) return null;

  if (currentTick !== undefined && currentTick - lastCallTick < COOLDOWN_TICKS) return null;

  const cfg = PROVIDERS[provider];
  const userContent = buildStorytellerUserPrompt({
    completedGoal,
    goblins,
    adventurers,
    eventLines,
    personaId: getStorytellerPersona().id,
  });

  const body =
    provider === 'anthropic'
      ? {
          model: cfg.model,
          max_tokens: 256,
          temperature: STORYTELLER_TEMPERATURE,
          system: STORYTELLER_SYSTEM_PROMPT,
          messages: [{ role: 'user' as const, content: userContent }],
        }
      : {
          model: cfg.model,
          max_tokens: 256,
          temperature: STORYTELLER_TEMPERATURE,
          messages: [
            { role: 'system' as const, content: STORYTELLER_SYSTEM_PROMPT },
            { role: 'user' as const, content: userContent },
          ],
        };

  try {
    lastCallTick = currentTick ?? lastCallTick;
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify(body),
    });
    if (res.status === 429) return null;
    if (!res.ok) return null;

    const data = await res.json();
    const usage = cfg.extractUsage(data as Parameters<typeof cfg.extractUsage>[0]);
    sessionInputTokens += usage.input;
    sessionOutputTokens += usage.output;
    sessionCallCount++;
    bus.emit('tokenUsage', {
      inputTotal: sessionInputTokens,
      outputTotal: sessionOutputTokens,
      callCount: sessionCallCount,
      lastInput: usage.input,
      lastOutput: usage.output,
    });

    const raw = cfg.extractText(data as Parameters<typeof cfg.extractText>[0])?.trim() ?? '';
    const cleaned = raw.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/, '').trim();
    return cleaned.slice(0, 800) || null;
  } catch (err) {
    const name = (err as Error).name;
    if (name !== 'AbortError' && name !== 'TimeoutError') {
      console.warn('[storyteller] call failed:', err);
    }
    return null;
  }
}

// ── Deterministic fallback ───────────────────────────────────────────────────

export function buildFallbackChapter(
  goal: ColonyGoal,
  alive: Goblin[],
  events: string[],
): string {
  const deathCount = events.filter(
    e =>
      e.toLowerCase().includes('killed') ||
      e.toLowerCase().includes('dead') ||
      e.toLowerCase().includes('died'),
  ).length;
  const raidCount = events.filter(e => e.includes('storm') || e.includes('RAID')).length;
  const names = alive.slice(0, 3).map(d => d.name).join(', ');

  const cfg = getGoblinConfig();
  let text = `The colony completed "${goal.description}" after ${goal.generation + 1} cycle${goal.generation > 0 ? 's' : ''}.`;
  if (deathCount > 0)
    text += ` ${deathCount} ${cfg.unitNoun}${deathCount > 1 ? 's' : ''} fell along the way.`;
  if (raidCount > 0)
    text += ` The colony endured ${raidCount} ${cfg.enemyNounPlural.slice(0, 1).toUpperCase() + cfg.enemyNounPlural.slice(1)} raid${raidCount > 1 ? 's' : ''}.`;
  if (names) text += ` ${names} and the others press on.`;
  return text;
}
