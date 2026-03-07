/**
 * Storyteller AI — narrator that writes chapter summaries on goal completion.
 *
 * Fires once per colony goal cycle. Uses the same LLM provider/rate-limit
 * infrastructure as crisis.ts. Falls back to deterministic text if LLM is
 * disabled, rate-limited, or fails.
 */

import type { Goblin, Adventurer, ColonyGoal, LogEntry } from '../shared/types';
import { bus } from '../shared/events';
import { llmSystem, PROVIDERS } from './crisis';
import { getActiveFaction } from '../shared/factions';

// ── Event filtering ──────────────────────────────────────────────────────────

/** Significant goblinName/level patterns worth including in a chapter prompt. */
const SIG_NAMES = new Set(['WEATHER', 'world', 'COLONY', 'RAID']);

/**
 * Filter log history to the ~15 most narratively important entries since the
 * last chapter tick. Returns condensed strings for the LLM prompt.
 */
export function filterSignificantEvents(
  logHistory: LogEntry[],
  lastChapterTick: number,
): string[] {
  const recent = logHistory.filter(e => e.tick > lastChapterTick);
  const significant: LogEntry[] = [];
  let llmDecisionCount = 0;

  for (const e of recent) {
    // Deaths, raids, combat (error-level entries)
    if (e.level === 'error') { significant.push(e); continue; }
    // Weather shifts, world events, colony milestones
    if (SIG_NAMES.has(e.goblinName)) { significant.push(e); continue; }
    // Adventurer kills (killVerb varies by faction)
    if (e.message.includes(getActiveFaction().killVerb)) { significant.push(e); continue; }
    // LLM crisis decisions (cap at 3 to avoid prompt bloat)
    if (e.level === 'warn' && e.goblinId !== 'verify' && llmDecisionCount < 3) {
      significant.push(e);
      llmDecisionCount++;
    }
  }

  // Cap at 15 entries, prioritizing earliest (chronological narrative flow)
  return significant.slice(0, 15).map(
    e => `[tick ${e.tick}] ${e.goblinName}: ${e.message}`,
  );
}

// ── Storyteller LLM call ─────────────────────────────────────────────────────

/**
 * Generate a chapter summary via LLM. Fire-and-forget — never blocks the
 * game loop. Returns narrator prose (2-4 sentences) or null on failure.
 */
export async function callStorytellerLLM(
  completedGoal: ColonyGoal,
  goblins: Goblin[],
  adventurers: Adventurer[],
  significantEvents: string[],
): Promise<string | null> {
  if (!llmSystem.enabled) return null;
  if (!llmSystem.canCallNowPublic()) return null;

  const cfg = PROVIDERS[llmSystem.provider];
  const alive = goblins.filter(d => d.alive);
  const dead = goblins.filter(d => !d.alive);

  // Tension (same formula as events.ts colonyTension — not exported)
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
    llmSystem.recordCallPublic();
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8_000), // slightly longer than crisis calls
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (res.status === 429) return null;
    if (!res.ok) return null;

    const data = await res.json();
    const usage = cfg.extractUsage(data);
    llmSystem.sessionInputTokens += usage.input;
    llmSystem.sessionOutputTokens += usage.output;
    llmSystem.sessionCallCount++;
    bus.emit('tokenUsage', {
      inputTotal: llmSystem.sessionInputTokens,
      outputTotal: llmSystem.sessionOutputTokens,
      callCount: llmSystem.sessionCallCount,
      lastInput: usage.input,
      lastOutput: usage.output,
    });

    const raw = cfg.extractText(data)?.trim() ?? '';
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/, '').trim();
    return cleaned.slice(0, 500) || null;
  } catch (err) {
    const name = (err as Error).name;
    if (name !== 'AbortError' && name !== 'TimeoutError') {
      console.warn('[storyteller] call failed:', err);
    }
    return null;
  }
}

// ── Deterministic fallback ───────────────────────────────────────────────────

/**
 * Build a chapter summary without LLM — used when LLM is disabled, rate-limited,
 * or fails. Always returns a non-empty string.
 */
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
