/**
 * Storyteller AI — narrator that writes chapter summaries on goal completion.
 *
 * Fires once per colony goal cycle. Falls back to deterministic text if LLM is
 * disabled or fails.
 */

import type { Goblin, Adventurer, ColonyGoal, LogEntry } from '../shared/types';
import { bus } from '../shared/events';
import { getActiveFaction } from '../shared/factions';

// ── LLM Config ────────────────────────────────────────────────────────────────

let enabled = false;
let provider: 'anthropic' | 'groq' = 'anthropic';
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCallCount = 0;
let lastCallTick = 0;
const COOLDOWN_TICKS = 300;

const PROVIDERS = {
  anthropic: {
    url: '/api/llm-proxy',
    model: 'claude-haiku-4-5',
    extractText: (data: { content?: Array<{ text?: string }> }) => data.content?.[0]?.text,
    extractUsage: (data: { usage?: { input_tokens?: number; output_tokens?: number } }) => ({
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    }),
  },
  groq: {
    url: '/api/groq-proxy',
    model: 'llama-3.3-70b-versatile',
    extractText: (data: { choices?: Array<{ message?: { content?: string } }> }) => 
      data.choices?.[0]?.message?.content,
    extractUsage: (data: { usage?: { prompt_tokens?: number; completion_tokens?: number } }) => ({
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    }),
  },
};

export function setStorytellerEnabled(val: boolean) { enabled = val; }
export function setStorytellerProvider(p: 'anthropic' | 'groq') { provider = p; }
export function getStorytellerEnabled() { return enabled; }

// ── Event filtering ──────────────────────────────────────────────────────────

const SIG_NAMES = new Set(['WEATHER', 'world', 'COLONY', 'RAID']);

export function filterSignificantEvents(
  logHistory: LogEntry[],
  lastChapterTick: number,
): string[] {
  const recent = logHistory.filter(e => e.tick > lastChapterTick);
  const significant: LogEntry[] = [];
  let warnCount = 0;

  for (const e of recent) {
    if (e.level === 'error') { significant.push(e); continue; }
    if (SIG_NAMES.has(e.goblinName)) { significant.push(e); continue; }
    if (e.message.includes(getActiveFaction().killVerb)) { significant.push(e); continue; }
    if (e.level === 'warn' && e.goblinId !== 'verify' && warnCount < 3) {
      significant.push(e);
      warnCount++;
    }
  }

  return significant.slice(0, 15).map(e => `[tick ${e.tick}] ${e.goblinName}: ${e.message}`);
}

// ── Storyteller LLM call ─────────────────────────────────────────────────────

export async function callStorytellerLLM(
  completedGoal: ColonyGoal,
  goblins: Goblin[],
  adventurers: Adventurer[],
  significantEvents: string[],
  currentTick?: number,
): Promise<string | null> {
  if (!enabled) return null;
  
  // Cooldown check if tick provided
  if (currentTick !== undefined && currentTick - lastCallTick < COOLDOWN_TICKS) return null;

  const cfg = PROVIDERS[provider];
  const alive = goblins.filter(d => d.alive);
  const dead = goblins.filter(d => !d.alive);

  const avgHunger = alive.length > 0
    ? alive.reduce((s, d) => s + d.hunger, 0) / alive.length : 100;
  const avgMorale = alive.length > 0
    ? alive.reduce((s, d) => s + d.morale, 0) / alive.length : 0;
  const tension = Math.min(100,
    avgHunger + (100 - avgMorale) * 0.5 + adventurers.length * 15 + dead.length * 20,
  );

  const tone = tension > 70 ? 'grim, tense, survival-focused'
    : tension < 30 ? 'hopeful, triumphant, warm'
      : 'neutral, matter-of-fact';

  const roster = alive.map(d => `${d.name} (${d.role}, ${d.trait})`).join(', ');
  const eventBlock = significantEvents.length > 0
    ? `\nKey events this chapter:\n${significantEvents.join('\n')}`
    : '\nA quiet chapter with no major events.';

  const faction = getActiveFaction();
  const chapterNum = completedGoal.generation + 1;
  const prompt =
    `You are the narrator of a ${faction.unitNoun} colony survival story — ${faction.narratorTone}. Write a brief chapter summary (2-4 sentences, max 60 words) for Chapter ${chapterNum}.\n\n` +
    `The colony just completed: ${completedGoal.description}\n` +
    `Colony: ${alive.length} ${faction.unitNounPlural} alive, ${dead.length} fallen. Roster: ${roster}\n` +
    `Tone: ${tone} (tension ${tension.toFixed(0)}/100)\n` +
    `${eventBlock}\n\n` +
    `Write in past tense, third person. Be specific — name ${faction.unitNounPlural}, reference actual events. No dialogue.`;

  try {
    lastCallTick = currentTick ?? lastCallTick;
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
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
  const deathCount = events.filter(e => e.includes('killed') || e.includes('dead') || e.includes('died')).length;
  const raidCount = events.filter(e => e.includes('storm') || e.includes('RAID')).length;
  const names = alive.slice(0, 3).map(d => d.name).join(', ');

  const faction = getActiveFaction();
  let text = `The colony completed "${goal.description}" after ${goal.generation + 1} cycle${goal.generation > 0 ? 's' : ''}.`;
  if (deathCount > 0) text += ` ${deathCount} ${faction.unitNoun}${deathCount > 1 ? 's' : ''} fell along the way.`;
  if (raidCount > 0) text += ` The colony endured ${raidCount} ${faction.enemyNounPlural.slice(0, 1).toUpperCase() + faction.enemyNounPlural.slice(1)} raid${raidCount > 1 ? 's' : ''}.`;
  if (names) text += ` ${names} and the others press on.`;
  return text;
}
