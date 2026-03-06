/**
 * Utility AI — replaces the fixed-priority behavior tree with scored action selection.
 *
 * Every tick each eligible action scores 0–1. The highest-scoring action wins.
 * Traits shift sigmoid midpoints (not thresholds), creating organic personality-driven
 * divergence. LLM intents add +0.5 to matching action scores (capped at 1.0) instead
 * of hard-overriding the BT.
 *
 * Flow:
 *   1. updateNeeds()           — hunger, morale, fatigue, social
 *   2. starvation damage       — unconditional, not an action
 *   3. expire stale LLM intent
 *   4. score all eligible actions (+ LLM boost)
 *   5. execute highest-scoring action
 */

import { type Goblin, type Tile, type Adventurer, type FoodStockpile, type OreStockpile, type WoodStockpile, type ColonyGoal, type WeatherType, type Room } from '../shared/types';
import { getWarmth } from './diffusion';
import { } from '../shared/constants';
import { isWalkable } from './world';
import { traitMod, pathNextStep } from './agents';
import { TileType } from '../shared/types';
import { ALL_ACTIONS, type ActionContext, type Action } from './actions';
import { tickWoundHealing } from './wounds';

// ── Response curves ────────────────────────────────────────────────────────────
//
// These three functions are the scoring vocabulary for the entire utility AI.
// Every action score is built from combinations of these curves applied to need values.
//
// sigmoid:        low→0, high→1  (urgency rises as need worsens)
// inverseSigmoid: low→1, high→0  (urgency falls as need worsens, e.g. "forage less when full")
// ramp:           dead-simple linear 0→1 between two breakpoints
//
// Traits shift the *midpoint* argument, not the output — a lazy goblin hits the
// rest midpoint sooner, producing organically higher rest scores without special-casing.

/** S-curve: 0 at low values, 1 at high values. Steepness controls transition sharpness. */
export function sigmoid(value: number, midpoint: number, steepness = 0.15): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}

/** 1 − sigmoid: 1 at low values, 0 at high values. */
export function inverseSigmoid(value: number, midpoint: number, steepness = 0.15): number {
  return 1 - sigmoid(value, midpoint, steepness);
}

/** Linear ramp: 0 below min, 1 above max, linear in between. */
export function ramp(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

// ── Needs update (runs every tick before action selection) ──────────────────────

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

/** Cooldown-gated log: returns true (and records the tick) at most once per `cooldown` ticks. */
function shouldLog(goblin: Goblin, key: string, tick: number, cooldown: number): boolean {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}

// updateNeeds runs every tick *before* action selection.
// It mutates need meters directly — these are not actions, just physics.
// The needs feed into action scores: high hunger → high eat/forage score, etc.
// Note that morale has no direct "restore morale" action — it recovers passively
// when hunger is low and loneliness is met. It's a lagging indicator of wellbeing.
function updateNeeds(
  goblin: Goblin,
  goblins: Goblin[] | undefined,
  currentTick: number,
  weatherMetabolismMod: number,
  warmthField: Float32Array | undefined,
  weatherType: WeatherType | undefined,
  onLog?: LogFn,
): void {
  // ── Hunger ──────────────────────────────────────────────────────────────────
  // Grows every tick. weatherMetabolismMod is >1 in cold/drought, making
  // food more scarce relative to consumption without changing the map.
  goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * weatherMetabolismMod);

  // ── Cold exposure penalty ────────────────────────────────────────────────────
  // During cold weather, goblins away from a hearth accumulate fatigue, morale loss,
  // and extra hunger. coldPenalty is 0 when warm (warmth > 50), rises to 1 when freezing.
  // This is what makes seekWarmth score highly in cold weather: the penalty is ongoing.
  if (weatherType === 'cold' && warmthField) {
    const warmth = getWarmth(warmthField, goblin.x, goblin.y);
    const coldPenalty = inverseSigmoid(warmth, 30, 0.12);
    if (coldPenalty > 0.05) {
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.3 * coldPenalty);
      goblin.morale = Math.max(0, goblin.morale - 0.25 * coldPenalty);
      goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.2 * coldPenalty);
      if (shouldLog(goblin, 'freezing', currentTick, 150)) {
        onLog?.('🥶 freezing in the open', 'warn');
      }
    }
  }

  // ── Morale ───────────────────────────────────────────────────────────────────
  // Morale decays when hungry (above 60), recovers when well-fed (below 30).
  // These two terms run every tick and partially cancel — at hunger=45 neither fires strongly.
  goblin.morale = Math.max(0, Math.min(100,
    goblin.morale
    - sigmoid(goblin.hunger, 60) * 0.5       // hunger above 60 → morale falls
    + inverseSigmoid(goblin.hunger, 30) * 0.25, // hunger below 30 → morale recovers
  ));
  // Stress loop: low morale → burns calories faster → harder to stay fed → morale falls further.
  // stressMod is near 0 above morale=50, rises sharply below 35.
  const stressMod = inverseSigmoid(goblin.morale, 35) * 0.4;
  if (stressMod > 0.05) {
    goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * stressMod);
    if (shouldLog(goblin, 'morale_low', currentTick, 200)) {
      onLog?.('😤 morale is dangerously low', 'warn');
    }
  }

  // ── Fatigue ──────────────────────────────────────────────────────────────────
  // Passive recovery of 0.5/tick. Actions that cost fatigue apply their drain inside
  // execute(), not here. The 0.5 baseline is intentionally larger than the cold (0.25)
  // and wound (0.05–0.30) penalties so recovery is always possible, just slower.
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.5);
  const WOUND_FATIGUE_DRAIN: Partial<Record<string, number>> = {
    bruised: 0.30,
    leg: 0.15,
    arm: 0.10,
    eye: 0.05,
  };
  const woundDrain = goblin.wound ? (WOUND_FATIGUE_DRAIN[goblin.wound.type] ?? 0) : 0;
  if (woundDrain > 0) {
    goblin.fatigue = Math.min(100, goblin.fatigue + woundDrain);
  }
  // Exhaustion above 80 also drains morale — two bad things reinforce each other.
  goblin.morale = Math.max(0, goblin.morale - sigmoid(goblin.fatigue, 80) * 0.25);
  if (goblin.fatigue > 80 && shouldLog(goblin, 'exhausted', currentTick, 150)) {
    onLog?.('😩 exhausted', 'warn');
  }

  // Wound healing — check and clear expired wounds
  tickWoundHealing(goblin, currentTick, onLog);

  // ── Social ───────────────────────────────────────────────────────────────────
  // Social is a loneliness meter: 0 = content, 100 = isolated.
  // It ticks *down* when a friendly goblin is nearby, and *up* when alone.
  // Isolation accumulates slowly (capped at 0.5/tick), so a briefly solo goblin is fine;
  // one stuck alone for hundreds of ticks starts suffering morale loss.
  if (goblins) {
    const FRIEND_RADIUS = traitMod(goblin, 'generosityRange', 2) + 1; // helpful/cheerful trait widens this
    const FRIEND_REL = 40; // minimum relation score to count as "friendly"
    const hasFriend = goblins.some(
      other => other.id !== goblin.id && other.alive &&
        Math.abs(other.x - goblin.x) <= FRIEND_RADIUS &&
        Math.abs(other.y - goblin.y) <= FRIEND_RADIUS &&
        (goblin.relations[other.id] ?? 50) >= FRIEND_REL,
    );
    if (hasFriend) {
      const socialBonus = traitMod(goblin, 'socialDecayBonus', 0);
      goblin.social = Math.max(0, goblin.social - (0.3 + socialBonus));
      goblin.lastSocialTick = currentTick;
    } else {
      // Isolation grows faster the longer they've been alone (capped at 0.5/tick)
      const isolationTicks = currentTick - goblin.lastSocialTick;
      goblin.social = Math.min(100, goblin.social + Math.min(0.5, isolationTicks / 400));
    }
  }
  // High loneliness drains morale — this is what makes the socialize action score highly
  if (goblin.social > 40) {
    goblin.morale = Math.max(0, goblin.morale - sigmoid(goblin.social, 60) * 0.2);
    if (goblin.social > 60 && shouldLog(goblin, 'lonely', currentTick, 200)) {
      onLog?.('😔 feeling lonely', 'warn');
    }
  }
}

// ── Narrative action names for log display ─────────────────────────────────────

const ACTION_DISPLAY_NAMES: Record<string, string> = {
  eat: 'eating',
  rest: 'resting',
  forage: 'foraging',
  mine: 'mining',
  chop: 'logging',
  fight: 'fighting',
  share: 'sharing food',
  depositFood: 'stockpiling food',
  withdrawFood: 'raiding the stockpile',
  depositOre: 'hauling ore',
  depositWood: 'hauling wood',
  buildWall: 'building',
  buildHearth: 'building a hearth',
  seekWarmth: 'seeking warmth',
  seekSafety: 'fleeing to safety',
  socialize: 'socializing',
  avoidRival: 'avoiding a rival',
  wander: 'exploring',
  commandMove: 'following orders',
};

// ── Selector loop ──────────────────────────────────────────────────────────────

export function tickAgentUtility(
  goblin: Goblin,
  grid: Tile[][],
  currentTick: number,
  goblins?: Goblin[],
  onLog?: LogFn,
  foodStockpiles?: FoodStockpile[],
  adventurers?: Adventurer[],
  oreStockpiles?: OreStockpile[],
  colonyGoal?: ColonyGoal,
  woodStockpiles?: WoodStockpile[],
  weatherMetabolismMod?: number,
  warmthField?: Float32Array,
  dangerField?: Float32Array,
  weatherType?: WeatherType,
  rooms?: Room[],
): void {
  if (!goblin.alive) return;

  // Safety: if a world event (wall built, tile changed) trapped the goblin on an
  // unwalkable tile, nudge them to an adjacent walkable tile before doing anything else.
  if (!isWalkable(grid, goblin.x, goblin.y)) {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (const d of dirs) {
      if (isWalkable(grid, goblin.x + d.x, goblin.y + d.y)) {
        goblin.x += d.x; goblin.y += d.y; break;
      }
    }
  }

  // ── Step 1: Update needs ──────────────────────────────────────────────────────
  // Hunger, morale, fatigue, and social all advance here before any decision is made.
  // These feed into action scores — a goblin with hunger=80 will score "eat" near 1.0.
  updateNeeds(goblin, goblins, currentTick, weatherMetabolismMod ?? 1, warmthField, weatherType, onLog);

  // Exhaustion stumble: above fatigue=70 there's a chance to skip the whole action this tick.
  // The goblin just stands there recovering. Chance scales from ~20% at 70 to ~80% at 100.
  // This is separate from the rest *action* — it's involuntary collapse, not a choice.
  const stumbleChance = ramp(goblin.fatigue, 70, 100) * 0.6 + 0.2;
  if (goblin.fatigue > 70 && Math.random() < stumbleChance) {
    goblin.task = 'exhausted…';
    goblin.fatigue = Math.max(0, goblin.fatigue - 1.5); // forced rest, same recovery as the rest action
    return;
  }

  // ── Step 2: Starvation damage ─────────────────────────────────────────────────
  // Not an action — runs unconditionally if the goblin has no food and hunger ≥ 90.
  // Damage is sigmoid-smoothed so it accelerates as hunger approaches 100, not a hard cliff.
  // A goblin with food in their inventory avoids this entirely — eat() fires before they hit 90.
  if (goblin.inventory.food === 0 && goblin.hunger >= 90) {
    const starveDmg = sigmoid(goblin.hunger, 95, 0.2) * 0.003 * goblin.maxHealth;
    goblin.health -= starveDmg;
    goblin.morale = Math.max(0, goblin.morale - starveDmg);
    goblin.task = 'starving!';
    if (shouldLog(goblin, 'starving', currentTick, 150)) {
      onLog?.(`is starving! (health ${goblin.health.toFixed(0)})`, 'warn');
    }
    if (goblin.health <= 0) {
      goblin.alive = false;
      goblin.task = 'dead';
      goblin.causeOfDeath = 'starvation';
      onLog?.('has died of starvation!', 'error');
      return;
    }
  }

  // ── Step 2b: Burning goblin override ─────────────────────────────────────────
  // A goblin on fire overrides ALL action scoring — they sprint to the nearest
  // water or rain pool. carryingWater is cleared so they don't waste time dousing.
  if (goblin.onFire) {
    goblin.carryingWater = false;
    const WATER_SEARCH = 30;
    let waterTarget: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    const x0 = Math.max(0, goblin.x - WATER_SEARCH), x1 = Math.min(grid[0].length - 1, goblin.x + WATER_SEARCH);
    const y0 = Math.max(0, goblin.y - WATER_SEARCH), y1 = Math.min(grid.length - 1, goblin.y + WATER_SEARCH);
    for (let wy = y0; wy <= y1; wy++) {
      for (let wx = x0; wx <= x1; wx++) {
        const tt = grid[wy][wx].type;
        if (tt !== TileType.Water && tt !== TileType.Pool) continue;
        const d = Math.abs(wx - goblin.x) + Math.abs(wy - goblin.y);
        if (d < bestDist) { bestDist = d; waterTarget = { x: wx, y: wy }; }
      }
    }
    if (waterTarget) {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, waterTarget, grid);
      goblin.x = next.x;
      goblin.y = next.y;
      goblin.task = `🔥 ON FIRE! → water (${bestDist} tiles)`;
    } else {
      goblin.task = '🔥 ON FIRE! (no water nearby!)';
    }
    return;
  }

  // ── Step 3: Expire stale LLM intent ──────────────────────────────────────────
  // LLM decisions write goblin.llmIntent (e.g. "forage") and a tick expiry.
  // If the intent is past its expiry it's cleared here so it stops boosting scores.
  if (goblin.llmIntent && currentTick > goblin.llmIntentExpiry) {
    goblin.llmIntent = null;
  }

  // ── Step 4: Build action context ─────────────────────────────────────────────
  // ActionContext is just a read-only bag of world references passed to every action's
  // eligible() and score() functions. Actions don't reach outside this object.
  const ctx: ActionContext = {
    goblin, grid, currentTick, goblins, onLog,
    foodStockpiles, adventurers, oreStockpiles, woodStockpiles, colonyGoal,
    warmthField, dangerField, weatherType, rooms,
  };

  // ── Step 5: Score all eligible actions ───────────────────────────────────────
  // Each action has two functions:
  //   eligible(ctx) → boolean  — hard gate (role check, resource check, etc.)
  //   score(ctx)    → 0.0–1.0  — soft preference built from response curves
  //
  // We loop ALL_ACTIONS once, skipping ineligible ones, and track the top two scores.
  // LLM intents nudge the matching action by +0.5 (capped at 1.0) — they tip the balance
  // without overriding a genuinely urgent competing need.
  let bestAction: Action | null = null;
  let bestScore = -1;
  let secondName = '';
  let secondScore = -1;

  for (const action of ALL_ACTIONS) {
    if (!action.eligible(ctx)) continue;
    let score = action.score(ctx);
    // LLM intent boost: the LLM said "do X" — give X a meaningful nudge but don't hard-override
    if (goblin.llmIntent && action.intentMatch === goblin.llmIntent) {
      score = Math.min(1.0, score + 0.5);
    }
    if (score > bestScore) {
      secondScore = bestScore;
      secondName = bestAction?.name ?? '';
      bestScore = score;
      bestAction = action;
    } else if (score > secondScore) {
      secondScore = score;
      secondName = action.name;
    }
  }

  // Close-call log: fires when top two scores are within 0.03 AND both are genuinely urgent
  // (above 0.45). A goblin choosing between "idle" and "wander" isn't agonizing — one
  // choosing between "eat" and "flee" is.
  if (bestAction && secondScore >= 0 && bestScore - secondScore <= 0.03 && bestScore > 0.45) {
    if (shouldLog(goblin, 'close_call', currentTick, 400)) {
      const nameA = ACTION_DISPLAY_NAMES[bestAction.name] ?? bestAction.name;
      const nameB = ACTION_DISPLAY_NAMES[secondName] ?? secondName;
      onLog?.(`⚖ agonizing over ${nameA} vs ${nameB}`, 'info');
    }
  }

  // ── Step 6: Execute ───────────────────────────────────────────────────────────
  // Set an idle description first — execute() will overwrite goblin.task if it does real work.
  // If execute() returns early (e.g. pathfinding finds nothing), the idle string shows in the HUD.
  goblin.task = idleDescription(goblin);
  if (bestAction) {
    bestAction.execute(ctx);
  }
}

/** Describe why a goblin is between actions — shown when execute returns early or nothing wins. */
function idleDescription(goblin: Goblin): string {
  if (goblin.fatigue > 60) return 'exhausted, catching breath';
  if (goblin.fatigue > 20) return 'catching breath';
  if ((goblin.warmth ?? 100) < 20) return 'looking for warmth';
  if (goblin.morale < 25) return 'brooding';
  if (goblin.hunger > 70) return 'desperately hungry';
  if (goblin.hunger > 50) return 'hungry, looking for food';
  if (goblin.social > 65) return 'feeling lonely';
  if ((goblin.warmth ?? 100) < 35) return 'a bit chilly';
  return 'idle';
}
