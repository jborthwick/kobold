/**
 * Scored action selection (replaces a fixed-priority behaviour tree). Every tick each
 * eligible action scores 0–1; the highest wins. Scoring lets personality (traits) tip
 * close calls without hardcoded branches; traits shift sigmoid midpoints, not thresholds.
 *
 * Flow: (1) updateNeeds() — hunger, morale, fatigue, social. (2) Starvation damage
 * (unconditional). (3) Score all eligible actions. (4) Execute highest-scoring action.
 */

import { type Goblin, type Tile, type Adventurer, type FoodStockpile, type MealStockpile, type OreStockpile, type WoodStockpile, type PlankStockpile, type BarStockpile, type ColonyGoal, type WeatherType, type Room, isWallType } from '../shared/types';
import { getWarmth } from './diffusion';
import { } from '../shared/constants';
import { isWalkable } from './world';
import { traitMod, pathNextStep } from './agents';
import { TileType } from '../shared/types';
import { ALL_ACTIONS, type ActionContext, type Action } from './actions';
import { CARDINAL_DIRECTIONS } from './actions/helpers';
import { applyTraitBias } from './traitActionBias';
import { GOAL_CONFIG } from './goalConfig';
import { tickWoundHealing } from './wounds';
import { THOUGHT_DEFS, MEMORY_DEFS, addMemory } from './mood';

// Response curves: sigmoid (low→0, high→1), inverseSigmoid (low→1, high→0), ramp (linear).
// Traits shift the midpoint argument so e.g. lazy goblins hit rest urgency sooner.

/** S-curve: 0 at low values, 1 at high values. Steepness controls transition sharpness. */
export function sigmoid(value: number, midpoint: number, steepness = 0.15): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}

/**
 * Central scarcity and resource balance: computed once per tick, passed to all actions.
 *
 * 1) Tier pressures (consumables > raw materials > upgrades): inverseSigmoid on stockpile
 *    totals with tier-specific midpoints, then scaled by tier weight so food/meals urgency
 *    dominates bars/planks. Actions use one pressure; no per-action scarcity curves.
 *
 * 2) Balance (foodPriority / materialPriority): when materials >> consumables, boost food
 *    actions and nerf material actions (0.6+0.4*materialPriority in smith/saw/mine/chop).
 */
export function computeResourceBalanceModifier(
  foodStockpiles: FoodStockpile[] | undefined,
  oreStockpiles: OreStockpile[] | undefined,
  woodStockpiles: WoodStockpile[] | undefined,
  mealStockpiles: MealStockpile[] | undefined,
  barStockpiles: BarStockpile[] | undefined,
  plankStockpiles: PlankStockpile[] | undefined,
): {
  foodPriority: number;
  materialPriority: number;
  consumablesPressure: number;
  materialsPressure: number;
  upgradesPressure: number;
} {
  const totalFood = foodStockpiles?.reduce((s, p) => s + p.food, 0) ?? 0;
  const totalMeals = mealStockpiles?.reduce((s, p) => s + p.meals, 0) ?? 0;
  const totalOre = oreStockpiles?.reduce((s, p) => s + p.ore, 0) ?? 0;
  const totalWood = woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0;
  const totalBars = barStockpiles?.reduce((s, p) => s + p.bars, 0) ?? 0;
  const totalPlanks = plankStockpiles?.reduce((s, p) => s + p.planks, 0) ?? 0;

  const consumablesTotal = totalFood + totalMeals;
  const materialsTotal = totalOre + totalWood;
  const upgradesTotal = totalBars + totalPlanks;
  const materialsForBalance = totalOre + totalWood + totalBars + totalPlanks;

  // Balance: boost food actions when materials outweigh consumables; nerf material actions
  const imbalance = sigmoid(materialsForBalance - consumablesTotal, 40);
  const foodPriority = imbalance;
  const materialPriority = 1 - imbalance;

  // Tier pressures: scarcity (0–1 when low stock) × tier weight so consumables > materials > upgrades
  const consumablesPressure = Math.min(1, inverseSigmoid(consumablesTotal, 25) * 1.0);
  const materialsPressure = Math.min(1, inverseSigmoid(materialsTotal, 40) * 0.65);
  const upgradesPressure = Math.min(1, inverseSigmoid(upgradesTotal, 50) * 0.35);

  return {
    foodPriority,
    materialPriority,
    consumablesPressure,
    materialsPressure,
    upgradesPressure,
  };
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
  rooms?: Room[],
  grid?: Tile[][],
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
      goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.2 * coldPenalty);
      if (shouldLog(goblin, 'freezing', currentTick, 150)) {
        addMemory(goblin, 'freezing', currentTick);
        onLog?.('🥶 freezing in the open', 'warn');
      }
    }
  }

  // ── Morale ───────────────────────────────────────────────────────────────────
  // Clean up expired thoughts
  goblin.thoughts = goblin.thoughts.filter(t => t.expiryTick > currentTick);

  // Clean up expired or drop-staged memories
  for (let i = goblin.memories.length - 1; i >= 0; i--) {
    const mem = goblin.memories[i];
    const def = MEMORY_DEFS[mem.defId];
    if (def && currentTick - mem.lastRefreshTick > def.decayDuration) {
      if (mem.stage > 0) {
        mem.stage--;
        mem.lastRefreshTick = currentTick;
      } else {
        goblin.memories.splice(i, 1);
      }
    }
  }

  // Calculate target morale
  let targetMorale = 50;

  for (const t of goblin.thoughts) {
    targetMorale += THOUGHT_DEFS[t.defId]?.delta ?? 0;
  }
  for (const m of goblin.memories) {
    const def = MEMORY_DEFS[m.defId];
    if (def) targetMorale += (def.deltas[m.stage] ?? 0);
  }

  // Continuous Situational modifiers
  if (goblin.hunger > 60) targetMorale -= Math.round(15 * sigmoid(goblin.hunger, 70));
  if (goblin.hunger < 30) targetMorale += Math.round(10 * inverseSigmoid(goblin.hunger, 20));
  if (goblin.social > 60) targetMorale -= Math.round(15 * sigmoid(goblin.social, 75));
  if (goblin.fatigue > 80) targetMorale -= Math.round(15 * sigmoid(goblin.fatigue, 90));
  if (goblin.onFire) targetMorale -= 40;
  
  if (weatherType === 'cold' && warmthField) {
    const warmth = getWarmth(warmthField, goblin.x, goblin.y);
    if (warmth < 30) targetMorale -= Math.round(20 * inverseSigmoid(warmth, 15));
  }

  // Shelter: being inside well-walled rooms feels safer; being exposed in bad weather feels worse.
  // shelterScore ~ [0,1]: 0 = fully exposed, 1 = inside room with fully walled perimeter.
  let shelterScore = 0.5;
  if (rooms && rooms.length > 0 && grid) {
    const currentRoom = rooms.find(
      r => goblin.x >= r.x && goblin.x < r.x + r.w && goblin.y >= r.y && goblin.y < r.y + r.h,
    );
    if (currentRoom) {
      // Perimeter wall fraction for this room
      let perimeter = 0;
      let walled = 0;
      const { x, y, w, h } = currentRoom;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const isEdge = yy === y || yy === y + h - 1 || xx === x || xx === x + w - 1;
          if (!isEdge) continue;
          if (!grid[yy] || !grid[yy][xx]) continue;
          perimeter++;
          if (isWallType(grid[yy][xx].type)) walled++;
        }
      }
      const wallFraction = perimeter > 0 ? walled / perimeter : 0;
      // Inside a room: baseline shelter is decent even before walls; walls push it higher.
      shelterScore = 0.4 + 0.6 * wallFraction;
    } else {
      // Outside any room: treat as exposed.
      shelterScore = 0.1;
    }
  }

  // Shelter influences morale softly. Good shelter can add up to ~8 morale, poor shelter can
  // subtract up to ~8, with stronger effect under cold weather.
  const coldFactor = weatherType === 'cold' ? 1.0 : 0.5;
  if (shelterScore < 0.3) {
    const penalty = Math.round(8 * (0.3 - shelterScore) / 0.3 * coldFactor);
    targetMorale -= penalty;
  } else if (shelterScore > 0.7) {
    const bonus = Math.round(8 * (shelterScore - 0.7) / 0.3);
    targetMorale += bonus;
  }

  targetMorale = Math.max(0, Math.min(100, targetMorale));

  // Lerp towards target: gap closes at 0.5% per tick
  const gap = targetMorale - goblin.morale;
  goblin.morale += gap * 0.005;

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
  // Passive recovery 0.08/tick so fatigue accumulates during activity and drains slowly when resting.
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.08);
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
  // Exhaustion drains morale via targetMorale continuous modifier
  if (goblin.fatigue > 80 && shouldLog(goblin, 'exhausted', currentTick, 150)) {
    addMemory(goblin, 'exhausted_work', currentTick);
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
  // High loneliness drains morale via targetMorale continuous modifier
  if (goblin.social > 40) {
    if (goblin.social > 60 && shouldLog(goblin, 'lonely', currentTick, 200)) {
      addMemory(goblin, 'socially_isolated', currentTick);
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
  buildWoodWall: 'wood wall',
  buildStoneWall: 'stone wall',
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
  mealStockpiles?: MealStockpile[],
  plankStockpiles?: PlankStockpile[],
  barStockpiles?: BarStockpile[],
): void {
  if (!goblin.alive) return;

  // Safety: if a world event (wall built, tile changed) trapped the goblin on an
  // unwalkable tile, nudge them to an adjacent walkable tile before doing anything else.
  if (!isWalkable(grid, goblin.x, goblin.y)) {
    for (const d of CARDINAL_DIRECTIONS) {
      if (isWalkable(grid, goblin.x + d.x, goblin.y + d.y)) {
        goblin.x += d.x; goblin.y += d.y; break;
      }
    }
  }

  // ── Step 1: Update needs ──────────────────────────────────────────────────────
  // Hunger, morale, fatigue, and social all advance here before any decision is made.
  // These feed into action scores — a goblin with hunger=80 will score "eat" near 1.0.
  updateNeeds(goblin, goblins, currentTick, weatherMetabolismMod ?? 1, warmthField, weatherType, rooms, grid, onLog);

  // Exhaustion stumble: above fatigue=70 there's a chance to skip the whole action this tick.
  // The goblin just stands there recovering. Chance scales from ~20% at 70 to ~80% at 100.
  // This is separate from the rest *action* — it's involuntary collapse, not a choice.
  const stumbleChance = ramp(goblin.fatigue, 70, 100) * 0.6 + 0.2;
  if (goblin.fatigue > 70 && Math.random() < stumbleChance) {
    goblin.task = 'exhausted…';
    goblin.fatigue = Math.max(0, goblin.fatigue - 0.8); // forced rest
    return;
  }

  // ── Step 2: Starvation damage ─────────────────────────────────────────────────
  // Not an action — runs unconditionally if the goblin has no food and hunger ≥ 90.
  // Damage is sigmoid-smoothed so it accelerates as hunger approaches 100, not a hard cliff.
  // A goblin with food in their inventory avoids this entirely — eat() fires before they hit 90.
  if (goblin.inventory.food === 0 && goblin.inventory.meals === 0 && goblin.hunger >= 90) {
    const starveDmg = sigmoid(goblin.hunger, 95, 0.2) * 0.003 * goblin.maxHealth;
    goblin.health -= starveDmg;
    // targetMorale modifier takes care of morale penalty for starvation directly
    goblin.task = 'starving!';
    if (shouldLog(goblin, 'starving', currentTick, 150)) {
      addMemory(goblin, 'starving', currentTick);
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

  // ── Step 4: Build action context ─────────────────────────────────────────────
  // ActionContext is just a read-only bag of world references passed to every action's
  // eligible() and score() functions. Actions don't reach outside this object.
  // Compute resource balance once per tick and cache it to avoid redundant array reduces.
  const resourceBalance = computeResourceBalanceModifier(
    foodStockpiles, oreStockpiles, woodStockpiles, mealStockpiles, barStockpiles, plankStockpiles,
  );
  const hasStorage = rooms?.some(r => r.type === 'storage') ?? false;
  const hasLumberHut = rooms?.some(r => r.type === 'lumber_hut') ?? false;
  const hasBlacksmith = rooms?.some(r => r.type === 'blacksmith') ?? false;
  const hasKitchen = rooms?.some(r => r.type === 'kitchen') ?? false;
  const ctx: ActionContext = {
    goblin, grid, currentTick, goblins, onLog,
    foodStockpiles, adventurers, oreStockpiles, woodStockpiles, colonyGoal,
    warmthField, dangerField, weatherType, rooms, mealStockpiles,
    plankStockpiles, barStockpiles,
    resourceBalance,
    roomBonuses: {
      hasStorage,
      hasLumberHut,
      hasBlacksmith,
      hasKitchen,
    },
  };

  // ── Step 5: Score all eligible actions ───────────────────────────────────────
  // Each action has two functions:
  //   eligible(ctx) → boolean  — hard gate (role check, resource check, etc.)
  //   score(ctx)    → 0.0–1.0  — soft preference built from response curves
  const MOMENTUM_BONUS = 0.25;  // single tune point for action stickiness
  const goalBonuses = colonyGoal ? GOAL_CONFIG[colonyGoal.type].actionBonuses : {};
  let bestAction: Action | null = null;
  let bestScore = -1;
  let secondName = '';
  let secondScore = -1;

  for (const action of ALL_ACTIONS) {
    if (!action.eligible(ctx)) continue;
    let score = action.score(ctx);
    score = applyTraitBias(goblin, action, score);
    // Goal-directed bonus: active colony goal nudges relevant actions higher
    score *= goalBonuses[action.name] ?? 1.0;
    // Centralized momentum: sticky bonus for the action that won last tick
    // (but exclude wander — it's a fallback, not a strategy to stick with)
    if (action.name === goblin.lastActionName && action.name !== 'wander') {
      score = Math.min(1.0, score + MOMENTUM_BONUS);
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
    // Record winner for momentum bonus next tick
    goblin.lastActionName = bestAction.name;
  } else {
    goblin.lastActionName = '';
  }

  // ── Step 7: Handle Interrupted Cooking ────────────────────────────────────────
  // If a goblin was cooking but their newly assigned task is NOT cooking, they lose all progress
  // — but only after cooking has been inactive for >40 ticks (grace window for brief interruptions).
  const cookingIdle = currentTick - (goblin.cookingLastActiveTick ?? 0);
  if (goblin.cookingProgress !== undefined && !goblin.task.includes('cooking') && cookingIdle > 40) {
    goblin.cookingProgress = undefined;
    if (shouldLog(goblin, 'cooking_interrupted', currentTick, 100)) {
      onLog?.(`🔥 ${goblin.name} abandoned their cooking! The food is ruined!`, 'warn');
    }
  }
  const sawingIdle = currentTick - (goblin.sawingLastActiveTick ?? 0);
  if (goblin.sawingProgress !== undefined && !goblin.task.includes('sawing') && sawingIdle > 40) {
    goblin.sawingProgress = undefined;
  }
  const smithingIdle = currentTick - (goblin.smithingLastActiveTick ?? 0);
  if (goblin.smithingProgress !== undefined && !goblin.task.includes('smithing') && smithingIdle > 40) {
    goblin.smithingProgress = undefined;
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
