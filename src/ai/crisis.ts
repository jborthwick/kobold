/**
 * LLM crisis detection and decision system.
 *
 * Pattern from RESEARCH.md §7 — "AI Commander":
 *  - detectCrisis()       rule-based trigger check (runs every tick, cheap)
 *  - LLMDecisionSystem    singleton class; manages in-flight requests and
 *                         per-agent cooldowns; never blocks the game loop
 *
 * Providers: Anthropic (Claude) and Groq (Llama) — switchable at runtime.
 * Proxy routes: /api/llm-proxy → Anthropic, /api/groq-proxy → Groq
 */

import type { Dwarf, Tile, LLMIntent, Goblin, ColonyGoal } from '../shared/types';
import type { CrisisSituation, LLMDecision } from './types';
import { bus } from '../shared/events';

// ── LLM provider abstraction ─────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'groq';

export interface ProviderConfig {
  url:          string;
  model:        string;
  maxTokens:    number;
  /** Client-side rate limits — 0 = unlimited (e.g. Anthropic). */
  rateLimit:    { maxRPM: number; maxRPD: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractText:  (data: any) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractUsage: (data: any) => { input: number; output: number };
}

export const PROVIDERS: Record<LLMProvider, ProviderConfig> = {
  anthropic: {
    url:          '/api/llm-proxy',
    model:        'claude-haiku-4-5',
    maxTokens:    256,
    rateLimit:    { maxRPM: 0, maxRPD: 0 },  // Anthropic limits are generous; no client gating
    extractText:  (d) => d?.content?.[0]?.text ?? '',
    extractUsage: (d) => ({ input: d?.usage?.input_tokens ?? 0, output: d?.usage?.output_tokens ?? 0 }),
  },
  groq: {
    url:          '/api/groq-proxy',
    model:        'meta-llama/llama-4-scout-17b-16e-instruct',
    maxTokens:    256,
    rateLimit:    { maxRPM: 25, maxRPD: 900 },  // free tier: 30 RPM / 1K RPD — leave headroom
    extractText:  (d) => d?.choices?.[0]?.message?.content ?? '',
    extractUsage: (d) => ({ input: d?.usage?.prompt_tokens ?? 0, output: d?.usage?.completion_tokens ?? 0 }),
  },
};

// ── Thresholds ────────────────────────────────────────────────────────────────

const HUNGER_CRISIS_THRESHOLD   = 65;  // % hunger — fires when eating is due (eating now at > 70)
const MORALE_CRISIS_THRESHOLD   = 40;  // morale ≤ this (morale decays in tickAgent)
const CONTEST_RADIUS            = 2;   // tiles — contest triggers when rival is this close
const LOW_SUPPLIES_FOOD         = 2;   // units — fires when carrying almost nothing
const LOW_SUPPLIES_HUNGER       = 40;  // must also be hungry (not a crisis if full)
const GOBLIN_RAID_AWARENESS     = 8;   // tiles — goblin_raid fires within this distance
const EXHAUSTION_THRESHOLD      = 80;  // fatigue ≥ this triggers exhaustion crisis
const LONELINESS_THRESHOLD      = 70;  // social ≥ this triggers loneliness crisis
const COOLDOWN_TICKS            = 280; // ~40 s at ~7 ticks/s — targets ~3-5 calls/dwarf/hour

// ── Crisis priority ──────────────────────────────────────────────────────────
//
// Not every crisis needs an LLM call. Low-priority crises (hunger, exhaustion,
// loneliness) have obvious BT-handled responses — the LLM would just say "eat",
// "rest", or "socialize" every time, burning rate-limit budget for zero emergent
// value. Only high-priority crises with genuine decision space are sent to the LLM.
//
// Medium-priority crises (morale) are interesting for flavor but the mechanical
// response is still deterministic — we send them at a lower rate by requiring a
// longer cooldown.

type CrisisPriority = 'high' | 'medium' | 'low';

const CRISIS_PRIORITY: Record<string, CrisisPriority> = {
  goblin_raid:      'high',    // fight-or-flee dilemma, personality-dependent
  low_supplies:     'high',    // genuine decision point — forage, share, depot?
  resource_contest: 'high',    // social dilemma — trait/relation driven
  resource_sharing: 'high',    // greedy vs helpful — key personality tension
  morale:           'medium',  // flavor value, but BT handles the mechanics
  hunger:           'low',     // always "eat" — no decision space
  exhaustion:       'low',     // always "rest" — no decision space
  loneliness:       'low',     // always "socialize" — no decision space
};

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
  // Only fighters and brave dwarves get LLM raid calls — everyone else always
  // flees via BT, so the LLM call is wasted budget. This cuts 3-4 calls per
  // raid event. Also skip if the dwarf is too far away (can't engage anyway).
  if (goblins && goblins.length > 0 && (dwarf.role === 'fighter' || dwarf.trait === 'brave')) {
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

  // Exhaustion — fires when fatigue is critically high
  if (dwarf.fatigue >= EXHAUSTION_THRESHOLD) {
    return {
      type:        'exhaustion',
      description: `You are exhausted (fatigue ${dwarf.fatigue.toFixed(0)}/100). Your body aches and you can barely keep moving.`,
      colonyContext: ctx,
    };
  }

  // Loneliness — fires when social need is critically high
  if (dwarf.social >= LONELINESS_THRESHOLD) {
    return {
      type:        'loneliness',
      description: `You feel lonely and isolated (social need ${dwarf.social.toFixed(0)}/100). You haven't been near a friend in a long time.`,
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
  if (dwarf.role === 'fighter') return 'Fighter — you protect the colony by hunting and killing goblins.';
  return 'Scout — you have wide vision and detect threats early.';
}

function buildPrompt(dwarf: Dwarf, situation: CrisisSituation, dwarves: Dwarf[], colonyGoal?: ColonyGoal): string {
  // PIANO step 2 — inject short-term memory if present (cap at 5 entries; with VERIFY outcomes)
  const memBlock = dwarf.memory.length > 0
    ? `\nRECENT DECISIONS:\n${dwarf.memory.slice(-5).map(m => {
        const out = m.outcome ? ` → OUTCOME: ${m.outcome}` : '';
        return `  [tick ${m.tick}] ${m.crisis}: "${m.action}"${out}`;
      }).join('\n')}`
    : '';

  // Relationship context — include all dwarves whose relation has meaningfully diverged from neutral
  const others = dwarves.filter(d => d.id !== dwarf.id && d.alive);
  const relParts: string[] = [];
  others
    .filter(d => (dwarf.relations[d.id] ?? 50) > 60)
    .sort((a, b) => (dwarf.relations[b.id] ?? 50) - (dwarf.relations[a.id] ?? 50))
    .forEach(d => relParts.push(`Ally: ${d.name} (bond ${(dwarf.relations[d.id] ?? 50).toFixed(0)}/100)`));
  others
    .filter(d => (dwarf.relations[d.id] ?? 50) < 40)
    .sort((a, b) => (dwarf.relations[a.id] ?? 50) - (dwarf.relations[b.id] ?? 50))
    .forEach(d => relParts.push(`Rival: ${d.name} (tension ${(100 - (dwarf.relations[d.id] ?? 50)).toFixed(0)}/100)`));
  const relBlock = relParts.length > 0 ? `\nRelationships: ${relParts.join('. ')}` : '';

  const goalLine = colonyGoal
    ? `\nColony goal: ${colonyGoal.description} (${colonyGoal.progress.toFixed(0)}/${colonyGoal.target})`
    : '';

  const homeDist = Math.round(Math.hypot(dwarf.x - dwarf.homeTile.x, dwarf.y - dwarf.homeTile.y));
  const homeStr  = `Fort home at (${dwarf.homeTile.x},${dwarf.homeTile.y}), ${homeDist} tile${homeDist !== 1 ? 's' : ''} away.`;

  const WOUND_EFFECTS: Record<string, string> = {
    bruised: 'tiring faster',
    leg:     'limping, moving slowly',
    arm:     'weak arm, reduced harvesting and combat',
    eye:     'impaired vision, can\'t see far',
  };
  const skillLine = (dwarf.skillLevel ?? 0) > 0
    ? `\nSkill: Level ${dwarf.skillLevel} ${dwarf.role} (${dwarf.skillXp} XP).`
    : '';
  const woundLine = dwarf.wound
    ? `\nWOUNDED: ${dwarf.wound.type} — ${WOUND_EFFECTS[dwarf.wound.type] ?? dwarf.wound.type}.`
    : '';

  return `You are ${dwarf.name}, a dwarf ${roleLabel(dwarf)}
Personality: ${dwarf.trait}. "${dwarf.bio}". Personal goal: ${dwarf.goal}.
Status — Health: ${dwarf.health}/${dwarf.maxHealth}, Hunger: ${dwarf.hunger.toFixed(0)}/100, Morale: ${dwarf.morale.toFixed(0)}/100, Fatigue: ${dwarf.fatigue.toFixed(0)}/100, Social need: ${dwarf.social.toFixed(0)}/100
Food carried: ${dwarf.inventory.food.toFixed(0)} units. Current task: ${dwarf.task}. ${homeStr}${skillLine}${woundLine}

CRISIS: ${situation.description}
Colony context: ${situation.colonyContext}${goalLine}${relBlock}${memBlock}

Respond ONLY as valid JSON (no markdown, no extra text):
{
  "action": "one short sentence — what you will do next",
  "intent": "eat | forage | rest | avoid | socialize | none",
  "reasoning": "internal monologue, 1-2 sentences",
  "emotional_state": "3-5 words describing how you feel",
  "expectedOutcome": "one short sentence — what you expect to happen"
}
intent meanings: eat=eat from inventory now, forage=seek food aggressively, rest=stay still and recover fatigue, avoid=move away from rivals/goblins, socialize=seek out a friendly dwarf for company, none=normal behaviour`;
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
  /** Active LLM provider — switchable at runtime via HUD toggle. */
  public provider: LLMProvider = 'groq';

  // One Promise per agent — prevents duplicate in-flight calls
  private pendingRequests = new Map<string, Promise<LLMDecision | null>>();
  // Per-agent cooldown: don't fire again until this tick
  private cooldownUntil       = new Map<string, number>();
  // Medium-priority crises use a longer cooldown (2×) to save budget
  private mediumCooldownUntil = new Map<string, number>();
  // Colony-wide raid cooldown — only one dwarf responds via LLM per raid wave
  private raidCooldownUntil = 0;
  // PIANO step 6 — pending outcome verifications
  private pendingVerifications = new Map<string, VerifySnapshot>();

  // Session-level token counters
  public sessionInputTokens  = 0;
  public sessionOutputTokens = 0;
  public sessionCallCount    = 0;

  // ── Wall-clock rate limiter (protects Groq free-tier limits) ──────────────
  /** Timestamps (Date.now()) of recent calls — pruned to last 60 s. */
  private recentCallTimestamps: number[] = [];
  /** Running daily call counter — resets after 24 h. */
  private dailyCallCount = 0;
  /** Wall-clock time when dailyCallCount was last reset. */
  private dailyResetAt   = Date.now() + 86_400_000; // +24 h

  /**
   * Returns true if the current provider's rate limits allow another call.
   * For providers with no client-side limits (maxRPM=0) this always returns true.
   */
  private canCallNow(): boolean {
    const { maxRPM, maxRPD } = PROVIDERS[this.provider].rateLimit;
    if (maxRPM === 0 && maxRPD === 0) return true; // no limits configured

    const now = Date.now();

    // Reset daily counter every 24 h
    if (now >= this.dailyResetAt) {
      this.dailyCallCount = 0;
      this.dailyResetAt   = now + 86_400_000;
    }

    // RPD check
    if (maxRPD > 0 && this.dailyCallCount >= maxRPD) {
      console.warn(`[LLM/${this.provider}] daily limit reached (${maxRPD} RPD) — skipping`);
      return false;
    }

    // RPM check — prune timestamps older than 60 s
    if (maxRPM > 0) {
      const cutoff = now - 60_000;
      this.recentCallTimestamps = this.recentCallTimestamps.filter(t => t > cutoff);
      if (this.recentCallTimestamps.length >= maxRPM) {
        console.warn(`[LLM/${this.provider}] minute limit reached (${maxRPM} RPM) — skipping`);
        return false;
      }
    }

    return true;
  }

  /** Record that a call was just made — updates rate-limit counters. */
  private recordCall(): void {
    this.recentCallTimestamps.push(Date.now());
    this.dailyCallCount++;
  }

  /** Public wrappers — used by callSuccessionLLM (standalone function). */
  public canCallNowPublic(): boolean  { return this.canCallNow(); }
  public recordCallPublic(): void     { this.recordCall(); }

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
    colonyGoal?: ColonyGoal,
  ): void {
    if (!this.enabled)                                         return;
    if (!dwarf.alive)                                          return;
    if (this.pendingRequests.has(dwarf.id))                    return;
    if ((this.cooldownUntil.get(dwarf.id) ?? 0) > currentTick) return;

    const situation = detectCrisis(dwarf, dwarves, grid, goblins);
    if (!situation) return;

    // ── Priority filter ──────────────────────────────────────────────────────
    // Low-priority crises (hunger, exhaustion, loneliness) have obvious BT
    // responses — skip the LLM call entirely. Medium-priority (morale) uses
    // a 2× longer cooldown so it fires less often, saving rate-limit budget.
    const priority = CRISIS_PRIORITY[situation.type] ?? 'low';
    if (priority === 'low') return;
    if (priority === 'medium') {
      if ((this.mediumCooldownUntil.get(dwarf.id) ?? 0) > currentTick) return;
    }
    // Colony-wide raid cooldown — one LLM call per raid wave, not one per dwarf
    if (situation.type === 'goblin_raid') {
      if (this.raidCooldownUntil > currentTick) return;
      this.raidCooldownUntil = currentTick + COOLDOWN_TICKS;
    }

    // Rate-limit gate — skip if provider's RPM/RPD budget is exhausted
    if (!this.canCallNow()) return;

    const promise = this.callLLM(dwarf, situation, dwarves, colonyGoal);
    this.pendingRequests.set(dwarf.id, promise);

    // Detached — resolves on its own; game loop continues
    promise.then(decision => {
      this.pendingRequests.delete(dwarf.id);
      this.cooldownUntil.set(dwarf.id, currentTick + COOLDOWN_TICKS);
      // Medium-priority crises get 2× cooldown so they fire half as often
      this.mediumCooldownUntil.set(dwarf.id, currentTick + COOLDOWN_TICKS * 2);
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
      case 'socialize': return dwarf.social > 70
        ? `socializing failed — still lonely (social ${dwarf.social.toFixed(0)})`
        : null;
      default:       return null;
    }
  }

  private async callLLM(
    dwarf:      Dwarf,
    situation:  CrisisSituation,
    dwarves:    Dwarf[],
    colonyGoal?: ColonyGoal,
  ): Promise<LLMDecision | null> {
    const cfg = PROVIDERS[this.provider];
    try {
      this.recordCall();
      const res = await fetch(cfg.url, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        signal:  AbortSignal.timeout(5_000),
        body: JSON.stringify({
          model:      cfg.model,
          max_tokens: cfg.maxTokens,
          messages: [{ role: 'user', content: buildPrompt(dwarf, situation, dwarves, colonyGoal) }],
        }),
      });

      if (res.status === 429) {
        console.warn(`[LLM/${this.provider}] rate-limited (429) for ${dwarf.name} — backing off`);
        return null;
      }
      if (!res.ok) {
        console.warn(`[LLM/${this.provider}] HTTP ${res.status} for ${dwarf.name}`);
        return null;
      }

      const data    = await res.json();
      const raw     = cfg.extractText(data);
      // Some models wrap JSON in markdown fences — strip them before parsing
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const decision = JSON.parse(cleaned) as LLMDecision;

      if (!decision?.action || !decision?.reasoning) return null;
      // Provide defaults for optional fields
      decision.emotional_state ??= 'uncertain';
      decision.expectedOutcome  ??= 'unknown outcome';

      // Track token usage and broadcast to UI
      const usage  = cfg.extractUsage(data);
      this.sessionInputTokens  += usage.input;
      this.sessionOutputTokens += usage.output;
      this.sessionCallCount++;
      bus.emit('tokenUsage', {
        inputTotal:  this.sessionInputTokens,
        outputTotal: this.sessionOutputTokens,
        callCount:   this.sessionCallCount,
        lastInput:   usage.input,
        lastOutput:  usage.output,
      });

      return decision;
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'AbortError' && name !== 'TimeoutError') {
        console.warn(`[LLM/${this.provider}] call failed:`, err);
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
  if (!llmSystem.canCallNowPublic()) return null; // rate-limit gate
  const cfg = PROVIDERS[llmSystem.provider];
  const memSnippet = dead.memory.length > 0
    ? ` Their last known acts: ${dead.memory.slice(-2).map(m => `"${m.action}"`).join(', ')}.`
    : '';
  const prompt =
    `You are ${successor.name}, a new ${successor.role} dwarf arriving at a small colony. ` +
    `${dead.name} (${dead.role}) recently died here.${memSnippet} ` +
    `In one sentence (max 15 words), what is your first thought on arriving? ` +
    `Reply with just the sentence, no quotes.`;
  try {
    llmSystem.recordCallPublic();
    const res = await fetch(cfg.url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      signal:  AbortSignal.timeout(5_000),
      body: JSON.stringify({
        model:      cfg.model,
        max_tokens: 60,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (res.status === 429) return null; // rate-limited by server
    if (!res.ok) return null;
    const data  = await res.json();
    const usage = cfg.extractUsage(data);
    llmSystem.sessionInputTokens  += usage.input;
    llmSystem.sessionOutputTokens += usage.output;
    llmSystem.sessionCallCount++;
    bus.emit('tokenUsage', {
      inputTotal:  llmSystem.sessionInputTokens,
      outputTotal: llmSystem.sessionOutputTokens,
      callCount:   llmSystem.sessionCallCount,
      lastInput:   usage.input,
      lastOutput:  usage.output,
    });
    return cfg.extractText(data)?.trim().slice(0, 120) ?? null;
  } catch {
    return null;
  }
}
