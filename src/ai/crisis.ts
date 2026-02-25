/**
 * LLM crisis detection and decision system.
 *
 * Pattern from RESEARCH.md §7 — "AI Commander":
 *  - detectCrisis()       rule-based trigger check (runs every tick, cheap)
 *  - LLMDecisionSystem    singleton class; manages in-flight requests and
 *                         per-agent cooldowns; never blocks the game loop
 *
 * Proxy route: /api/llm-proxy → Vite dev server → api.anthropic.com/v1/messages
 * In production this will be a Cloudflare Worker at the same path.
 */

import type { Dwarf, Tile, LLMIntent, Goblin } from '../shared/types';
import type { CrisisSituation, LLMDecision } from './types';

// ── Thresholds ────────────────────────────────────────────────────────────────

const HUNGER_CRISIS_THRESHOLD   = 65;  // % hunger — fires when eating is due (eating now at > 70)
const MORALE_CRISIS_THRESHOLD   = 40;  // morale ≤ this (morale decays in tickAgent)
const CONTEST_RADIUS            = 2;   // tiles — contest triggers when rival is this close
const LOW_SUPPLIES_FOOD         = 2;   // units — fires when carrying almost nothing
const LOW_SUPPLIES_HUNGER       = 40;  // must also be hungry (not a crisis if full)
const GOBLIN_RAID_AWARENESS     = 8;   // tiles — goblin_raid fires within this distance
const COOLDOWN_TICKS            = 280; // ~40 s at ~7 ticks/s — targets ~3-5 calls/dwarf/hour
const MODEL                     = 'claude-haiku-4-5';

// ── Crisis detection (deterministic, runs every tick) ─────────────────────────

export function detectCrisis(
  dwarf:    Dwarf,
  dwarves:  Dwarf[],
  _grid:    Tile[][],
  goblins?: Goblin[],
): CrisisSituation | null {
  if (!dwarf.alive) return null;

  const alive      = dwarves.filter(d => d.alive);
  const colonyFood = alive.reduce((s, d) => s + d.inventory.food, 0);
  const ctx        = `Colony food: ${colonyFood.toFixed(0)} units across ${alive.length} dwarves. Health: ${dwarf.health}/${dwarf.maxHealth}.`;

  // ── Goblin raid — checked first (most urgent) ─────────────────────────────
  if (goblins && goblins.length > 0) {
    const nearest = goblins.reduce<{ goblin: Goblin; dist: number } | null>((best, g) => {
      const d = Math.abs(g.x - dwarf.x) + Math.abs(g.y - dwarf.y);
      return (!best || d < best.dist) ? { goblin: g, dist: d } : best;
    }, null);
    if (nearest && nearest.dist <= GOBLIN_RAID_AWARENESS) {
      return {
        type:          'goblin_raid',
        description:   `Goblins are raiding! An enemy is ${nearest.dist} tile${nearest.dist !== 1 ? 's' : ''} away — fight or flee!`,
        colonyContext: `${goblins.length} goblin${goblins.length !== 1 ? 's' : ''} in the area. ${ctx}`,
      };
    }
  }

  // Low supplies — fires when inventory nearly empty AND hunger is rising.
  // This catches the realistic crisis *before* starvation, while there's
  // still time to act (go harvest, steal from rival, etc.).
  if (dwarf.inventory.food <= LOW_SUPPLIES_FOOD && dwarf.hunger >= LOW_SUPPLIES_HUNGER) {
    return {
      type:        'low_supplies',
      description: `You are running out of food (only ${dwarf.inventory.food.toFixed(0)} units left) and getting hungry (hunger ${dwarf.hunger.toFixed(0)}/100).`,
      colonyContext: ctx,
    };
  }

  // Hunger crisis — fires when hungry, regardless of whether they still have some food
  if (dwarf.hunger >= HUNGER_CRISIS_THRESHOLD) {
    return {
      type:        'hunger',
      description: `You are very hungry (hunger ${dwarf.hunger.toFixed(0)}/100) and your food supply is running low (carrying ${dwarf.inventory.food.toFixed(0)} units).`,
      colonyContext: ctx,
    };
  }

  // Morale breaking point (morale decays in tickAgent when hungry)
  if (dwarf.morale <= MORALE_CRISIS_THRESHOLD) {
    return {
      type:        'morale',
      description: `Your morale has fallen to ${dwarf.morale.toFixed(0)}/100. You are struggling to keep going.`,
      colonyContext: ctx,
    };
  }

  // Resource contest — rival within CONTEST_RADIUS tiles targeting the same area
  // Scouts have wider situational awareness
  const contestRadius = dwarf.role === 'scout' ? 4 : CONTEST_RADIUS;
  const rival = alive.find(d =>
    d.id !== dwarf.id &&
    Math.abs(d.x - dwarf.x) <= contestRadius &&
    Math.abs(d.y - dwarf.y) <= contestRadius &&
    d.inventory.food < 3,   // only contest if rival is also food-hungry
  );
  if (rival) {
    return {
      type:        'resource_contest',
      description: `${rival.name} is nearby (${Math.abs(rival.x - dwarf.x) + Math.abs(rival.y - dwarf.y)} tiles away) competing for the same scarce food.`,
      colonyContext: `You carry ${dwarf.inventory.food.toFixed(0)} food; ${rival.name} carries ${rival.inventory.food.toFixed(0)}. ${ctx}`,
    };
  }

  // Resource sharing — fires when well-fed AND a nearby dwarf is struggling
  const SHARE_RADIUS = 2;
  if (dwarf.inventory.food >= 8) {
    const needyNeighbor = alive.find(d =>
      d.id !== dwarf.id &&
      Math.abs(d.x - dwarf.x) <= SHARE_RADIUS &&
      Math.abs(d.y - dwarf.y) <= SHARE_RADIUS &&
      d.hunger > 60 && d.inventory.food < 3,
    );
    if (needyNeighbor) {
      return {
        type:        'resource_sharing',
        description: `${needyNeighbor.name} is nearby and starving (hunger ${needyNeighbor.hunger.toFixed(0)}/100, only ${needyNeighbor.inventory.food.toFixed(0)} food). You are well-supplied with ${dwarf.inventory.food.toFixed(0)} units.`,
        colonyContext: ctx,
      };
    }
  }

  return null;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function roleLabel(dwarf: Dwarf): string {
  if (dwarf.role === 'forager') return 'Forager — you specialize in harvesting food efficiently.';
  if (dwarf.role === 'miner')   return 'Miner — you prioritize mining ore and stone over foraging.';
  return 'Scout — you have wide vision and detect threats early.';
}

function buildPrompt(dwarf: Dwarf, situation: CrisisSituation, dwarves: Dwarf[]): string {
  // PIANO step 2 — inject short-term memory if present (with VERIFY outcomes)
  const memBlock = dwarf.memory.length > 0
    ? `\nRECENT DECISIONS:\n${dwarf.memory.map(m => {
        const out = m.outcome ? ` → OUTCOME: ${m.outcome}` : '';
        return `  [tick ${m.tick}] ${m.crisis}: "${m.action}"${out}`;
      }).join('\n')}`
    : '';

  // Relationship context — mention top ally and top rival if they deviate from neutral (50)
  const others = dwarves.filter(d => d.id !== dwarf.id && d.alive);
  const ally   = others.length > 0
    ? others.reduce((a, b) =>
        (dwarf.relations[a.id] ?? 50) >= (dwarf.relations[b.id] ?? 50) ? a : b)
    : null;
  const rival  = others.length > 0
    ? others.reduce((a, b) =>
        (dwarf.relations[a.id] ?? 50) <= (dwarf.relations[b.id] ?? 50) ? a : b)
    : null;
  const relParts: string[] = [];
  if (ally  && (dwarf.relations[ally.id]  ?? 50) > 55) relParts.push(`Trusted ally: ${ally.name} (bond ${(dwarf.relations[ally.id]  ?? 50).toFixed(0)}/100)`);
  if (rival && (dwarf.relations[rival.id] ?? 50) < 45) relParts.push(`Rival: ${rival.name} (tension ${(100 - (dwarf.relations[rival.id] ?? 50)).toFixed(0)}/100)`);
  const relBlock = relParts.length > 0 ? `\nRelationships: ${relParts.join('. ')}` : '';

  return `You are ${dwarf.name}, a dwarf ${roleLabel(dwarf)}
Role affects your priorities and decisions.
Status — Health: ${dwarf.health}/${dwarf.maxHealth}, Hunger: ${dwarf.hunger.toFixed(0)}/100, Morale: ${dwarf.morale.toFixed(0)}/100
Food carried: ${dwarf.inventory.food.toFixed(0)} units. Current task: ${dwarf.task}.

CRISIS: ${situation.description}
Colony context: ${situation.colonyContext}${relBlock}${memBlock}

Respond ONLY as valid JSON (no markdown, no extra text):
{
  "action": "one short sentence — what you will do next",
  "intent": "eat | forage | rest | avoid | none",
  "reasoning": "internal monologue, 1-2 sentences",
  "emotional_state": "3-5 words describing how you feel",
  "expectedOutcome": "one short sentence — what you expect to happen"
}
intent meanings: eat=eat from inventory now, forage=seek food aggressively, rest=stay still, avoid=move away from rivals/goblins, none=normal behaviour`;
}

// ── LLM Decision System ───────────────────────────────────────────────────────

type DecisionCallback = (
  dwarf:     Dwarf,
  decision:  LLMDecision,
  situation: CrisisSituation,
) => void;

interface VerifySnapshot {
  dwarfId:          string;
  verifyAtTick:     number;        // currentTick + 40
  intent:           LLMIntent;
  hungerAtDecision: number;
  foodAtDecision:   number;
  memoryEntryIndex: number;        // index into dwarf.memory to backfill
}

export class LLMDecisionSystem {
  /** Set to false to suppress all LLM calls (e.g. dev toggle). */
  public enabled = false;

  // One Promise per agent — prevents duplicate in-flight calls
  private pendingRequests = new Map<string, Promise<LLMDecision | null>>();
  // Per-agent cooldown: don't fire again until this tick
  private cooldownUntil   = new Map<string, number>();
  // PIANO step 6 — pending outcome verifications
  private pendingVerifications = new Map<string, VerifySnapshot>();

  /**
   * Check for a crisis, fire an async LLM call if one is found and the agent
   * isn't on cooldown.  Never awaited — the game loop must not block.
   */
  requestDecision(
    dwarf:       Dwarf,
    dwarves:     Dwarf[],
    grid:        Tile[][],
    currentTick: number,
    goblins:     Goblin[],
    onDecision:  DecisionCallback,
  ): void {
    if (!this.enabled)                                         return;
    if (!dwarf.alive)                                          return;
    if (this.pendingRequests.has(dwarf.id))                    return;
    if ((this.cooldownUntil.get(dwarf.id) ?? 0) > currentTick) return;

    const situation = detectCrisis(dwarf, dwarves, grid, goblins);
    if (!situation) return;

    const promise = this.callLLM(dwarf, situation, dwarves);
    this.pendingRequests.set(dwarf.id, promise);

    // Detached — resolves on its own; game loop continues
    promise.then(decision => {
      this.pendingRequests.delete(dwarf.id);
      this.cooldownUntil.set(dwarf.id, currentTick + COOLDOWN_TICKS);
      if (decision) {
        onDecision(dwarf, decision, situation);
        // PIANO step 6 — schedule outcome verification after 40 ticks
        if (decision.intent && decision.intent !== 'none') {
          this.pendingVerifications.set(dwarf.id, {
            dwarfId:          dwarf.id,
            verifyAtTick:     currentTick + 40,
            intent:           decision.intent,
            hungerAtDecision: dwarf.hunger,
            foodAtDecision:   dwarf.inventory.food,
            memoryEntryIndex: dwarf.memory.length - 1,
          });
        }
      }
    });
  }

  /**
   * Called once per game tick from WorldScene. Checks pending verifications,
   * backfills outcomes into memory, and returns surprise messages for the log.
   */
  public checkVerifications(dwarves: Dwarf[], currentTick: number): string[] {
    const surprises: string[] = [];
    for (const [id, snap] of this.pendingVerifications) {
      if (currentTick < snap.verifyAtTick) continue;
      this.pendingVerifications.delete(id);
      const dwarf = dwarves.find(d => d.id === id && d.alive);
      if (!dwarf) continue;
      const result = this.evaluateOutcome(dwarf, snap);
      if (result) {
        const entry = dwarf.memory[snap.memoryEntryIndex];
        if (entry) entry.outcome = result;
        surprises.push(`${dwarf.name}: ${result}`);
      }
    }
    return surprises;
  }

  private evaluateOutcome(dwarf: Dwarf, snap: VerifySnapshot): string | null {
    const hungerDelta = dwarf.hunger - snap.hungerAtDecision;
    const foodDelta   = dwarf.inventory.food - snap.foodAtDecision;
    switch (snap.intent) {
      case 'eat':    return hungerDelta >= 0
        ? `eating failed — hunger rose ${hungerDelta.toFixed(0)}`
        : null;
      case 'forage': return foodDelta <= 0
        ? `foraging failed — no food collected`
        : null;
      case 'rest':   return dwarf.hunger > 80
        ? `resting while starving (hunger ${dwarf.hunger.toFixed(0)})`
        : null;
      default:       return null;
    }
  }

  private async callLLM(
    dwarf:     Dwarf,
    situation: CrisisSituation,
    dwarves:   Dwarf[],
  ): Promise<LLMDecision | null> {
    try {
      const res = await fetch('/api/llm-proxy', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        signal:  AbortSignal.timeout(5_000),
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: 256,
          messages: [{ role: 'user', content: buildPrompt(dwarf, situation, dwarves) }],
        }),
      });

      if (!res.ok) {
        console.warn(`[LLM] HTTP ${res.status} for ${dwarf.name}`);
        return null;
      }

      const data    = await res.json() as { content?: { text?: string }[] };
      const raw     = data?.content?.[0]?.text ?? '';
      // Some models wrap JSON in markdown fences — strip them before parsing
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const decision = JSON.parse(cleaned) as LLMDecision;

      if (!decision?.action || !decision?.reasoning) return null;
      // Provide defaults for optional fields
      decision.emotional_state ??= 'uncertain';
      decision.expectedOutcome  ??= 'unknown outcome';
      return decision;
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'AbortError' && name !== 'TimeoutError') {
        console.warn('[LLM] call failed:', err);
      }
      return null;
    }
  }
}

// Singleton — shared across the WorldScene
export const llmSystem = new LLMDecisionSystem();

// ── Succession LLM ────────────────────────────────────────────────────────────

/**
 * One-shot plain-text call — generates the successor's first thought on arrival.
 * Returns a short sentence (≤120 chars) or null on failure / timeout.
 * Never throws; always safe to fire-and-forget.
 */
export async function callSuccessionLLM(dead: Dwarf, successor: Dwarf): Promise<string | null> {
  const memSnippet = dead.memory.length > 0
    ? ` Their last known acts: ${dead.memory.slice(-2).map(m => `"${m.action}"`).join(', ')}.`
    : '';
  const prompt =
    `You are ${successor.name}, a new ${successor.role} dwarf arriving at a small colony. ` +
    `${dead.name} (${dead.role}) recently died here.${memSnippet} ` +
    `In one sentence (max 15 words), what is your first thought on arriving? ` +
    `Reply with just the sentence, no quotes.`;
  try {
    const res = await fetch('/api/llm-proxy', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      signal:  AbortSignal.timeout(5_000),
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 60,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: { text?: string }[] };
    return data?.content?.[0]?.text?.trim().slice(0, 120) ?? null;
  } catch {
    return null;
  }
}
