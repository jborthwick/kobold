/**
 * Scored action selection (replaces a fixed-priority behaviour tree). Every tick each
 * eligible action scores 0–1; the highest wins. Scoring lets personality (traits) tip
 * close calls without hardcoded branches; traits shift sigmoid midpoints, not thresholds.
 *
 * Flow: (1) updateNeeds() — hunger, morale, fatigue, social. (2) Starvation damage
 * (unconditional). (3) Score all eligible actions. (4) Execute highest-scoring action.
 */

import { type Goblin, type Tile, type Adventurer, type Chicken, type FoodStockpile, type MealStockpile, type OreStockpile, type WoodStockpile, type PlankStockpile, type BarStockpile, type ColonyGoal, type WeatherType, type Room, isWallType } from '../shared/types';
import { isWalkable } from './world';
import { traitMod, pathNextStep, pruneInvalidKnownFoodSites } from './agents';
import { TileType } from '../shared/types';
import { ALL_ACTIONS, type ActionContext, type Action } from './actions';
import { CARDINAL_DIRECTIONS, countNearbyRestingAlliesOnBurrowBeds, isOnBurrowBed } from './actions/helpers';
import { applyTraitBias } from './traitActionBias';
import { GOAL_CONFIG } from './goalConfig';
import { tickWoundHealing } from './wounds';
import { THOUGHT_DEFS, MEMORY_DEFS, addMemory } from './mood';
import { actionNameToWorkCategory, getSkillForCategory, LAST_JOB_PERSIST_TICKS, type WorkCategoryId, type WorkerTargets } from './workerTargets';
import { xpToLevel } from './skills';
import { getRefuelableHearthCount } from './actions/hearth';
import {
  CONSUMABLES_BUFFER_PER_GOBLIN,
  DEFAULT_GOBLINS_FOR_PRESSURE,
  ORE_BUFFER_PER_GOBLIN,
  UPGRADES_MIDPOINT,
  WOOD_BUFFER_PER_GOBLIN,
} from './resourceTuning';
import { getDanger } from './diffusion';
import { isOutdoorRoomType } from '../shared/roomConfig';

// Response curves: sigmoid (low→0, high→1), inverseSigmoid (low→1, high→0), ramp (linear).
// Traits shift the midpoint argument so e.g. lazy goblins hit rest urgency sooner.

/** S-curve: 0 at low values, 1 at high values. Steepness controls transition sharpness. */
export function sigmoid(value: number, midpoint: number, steepness = 0.15): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}

/**
 * Central scarcity and resource balance: computed once per tick, passed to all actions.
 *
 * 1) Consumables, ore, wood: per-goblin scaling. Pressure is high when (stock/goblin) is below
 *    the tier's buffer-per-goblin constant. Fallback when livingGoblinCount is 0 uses
 *    DEFAULT_GOBLINS_FOR_PRESSURE. Upgrades use a single absolute midpoint (UPGRADES_MIDPOINT).
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
  livingGoblinCount?: number,
): {
  foodPriority: number;
  materialPriority: number;
  consumablesPressure: number;
  orePressure: number;
  woodPressure: number;
  upgradesPressure: number;
} {
  const totals = computeResourceTotals(
    foodStockpiles,
    mealStockpiles,
    oreStockpiles,
    woodStockpiles,
    barStockpiles,
    plankStockpiles,
  );

  const consumablesTotal = totals.totalFood + totals.totalMeals;
  const upgradesTotal = totals.totalBars + totals.totalPlanks;
  const materialsForBalance = totals.totalOre + totals.totalWood + totals.totalBars + totals.totalPlanks;

  // Balance: boost food actions when materials outweigh consumables; nerf material actions
  const imbalance = sigmoid(materialsForBalance - consumablesTotal, 40);
  const foodPriority = imbalance;
  const materialPriority = 1 - imbalance;

  const goblinsForPressure = resolveGoblinsForPressure(livingGoblinCount);

  // Consumables pressure: per-goblin
  const effectiveConsumables = consumablesTotal / goblinsForPressure;
  const consumablesPressure = Math.min(1, inverseSigmoid(effectiveConsumables, CONSUMABLES_BUFFER_PER_GOBLIN) * 1.0);

  // Ore and wood pressure: per-goblin (same scaling as consumables)
  const effectiveOrePerGoblin = totals.totalOre / goblinsForPressure;
  const effectiveWoodPerGoblin = totals.totalWood / goblinsForPressure;
  const orePressure = Math.min(1, inverseSigmoid(effectiveOrePerGoblin, ORE_BUFFER_PER_GOBLIN) * 0.65);
  const woodPressure = Math.min(1, inverseSigmoid(effectiveWoodPerGoblin, WOOD_BUFFER_PER_GOBLIN) * 0.65);

  // Upgrades: absolute midpoint
  const upgradesPressure = Math.min(1, inverseSigmoid(upgradesTotal, UPGRADES_MIDPOINT) * 0.35);

  return {
    foodPriority,
    materialPriority,
    consumablesPressure,
    orePressure,
    woodPressure,
    upgradesPressure,
  };
}

type ResourceTotals = {
  totalFood: number;
  totalMeals: number;
  totalOre: number;
  totalWood: number;
  totalBars: number;
  totalPlanks: number;
};

function computeResourceTotals(
  foodStockpiles: FoodStockpile[] | undefined,
  mealStockpiles: MealStockpile[] | undefined,
  oreStockpiles: OreStockpile[] | undefined,
  woodStockpiles: WoodStockpile[] | undefined,
  barStockpiles: BarStockpile[] | undefined,
  plankStockpiles: PlankStockpile[] | undefined,
): ResourceTotals {
  return {
    totalFood: foodStockpiles?.reduce((s, p) => s + p.food, 0) ?? 0,
    totalMeals: mealStockpiles?.reduce((s, p) => s + p.meals, 0) ?? 0,
    totalOre: oreStockpiles?.reduce((s, p) => s + p.ore, 0) ?? 0,
    totalWood: woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0,
    totalBars: barStockpiles?.reduce((s, p) => s + p.bars, 0) ?? 0,
    totalPlanks: plankStockpiles?.reduce((s, p) => s + p.planks, 0) ?? 0,
  };
}

function resolveGoblinsForPressure(livingGoblinCount?: number): number {
  return livingGoblinCount !== undefined && livingGoblinCount > 0
    ? livingGoblinCount
    : DEFAULT_GOBLINS_FOR_PRESSURE;
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

/** Fraction of cold penalty removed at full shelter (0 = no reduction, 0.3 = 30% less penalty). */
const SHELTER_COLD_REDUCTION = 0.3;
const BURROW_SHELTER_FLOOR = 0.75;
const WOUND_FATIGUE_DRAIN: Partial<Record<string, number>> = {
  bruised: 0.30,
  leg: 0.15,
  arm: 0.10,
  eye: 0.05,
};

/** Ticks of inactivity after which cooking/sawing/smithing progress is cleared when task no longer matches. */
const PROGRESS_GRACE_TICKS = 40;

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
  weatherType: WeatherType | undefined,
  ambientColdStress: number,
  rooms?: Room[],
  grid?: Tile[][],
  onLog?: LogFn,
): void {
  // ── Hunger ──────────────────────────────────────────────────────────────────
  // Grows every tick. weatherMetabolismMod is >1 in cold/drought, making
  // food more scarce relative to consumption without changing the map.
  goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * weatherMetabolismMod);

  // Shelter: being inside well-walled rooms feels safer; used for cold penalty and morale.
  // shelterScore ~ [0,1]: 0 = fully exposed, 1 = inside room with fully walled perimeter.
  const shelterScore = computeShelterScore(goblin, rooms, grid);
  const restingOnBurrowBed = goblin.task.includes('resting') && isOnBurrowBed(goblin, rooms);
  const burrowResters = restingOnBurrowBed
    ? countNearbyRestingAlliesOnBurrowBeds(goblin, goblins, rooms, 3)
    : 0;
  const burrowComfort = restingOnBurrowBed
    ? Math.min(1, 0.5 + burrowResters * 0.1)
    : 0;

  // ── Cold exposure penalty ────────────────────────────────────────────────────
  // During cold weather, goblins away from warmth accumulate fatigue and extra hunger.
  // Shelter reduces effective cold penalty (less wind/rain = less heat loss).
  applyColdExposurePenalty(goblin, currentTick, ambientColdStress, shelterScore, onLog);

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

  let targetMorale = computeBaseMoraleTargetFromThoughtsAndMemories(goblin);
  targetMorale = applySituationalMoraleAdjustments(goblin, targetMorale, ambientColdStress, shelterScore, burrowComfort);

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
  applyFatigueAndWoundDrain(goblin, currentTick, onLog);

  // Wound healing — check and clear expired wounds
  tickWoundHealing(goblin, currentTick, onLog);

  // ── Social ───────────────────────────────────────────────────────────────────
  // Social is a loneliness meter: 0 = content, 100 = isolated.
  // It ticks *down* when a friendly goblin is nearby, and *up* when alone.
  // Isolation accumulates slowly (capped at 0.5/tick), so a briefly solo goblin is fine;
  // one stuck alone for hundreds of ticks starts suffering morale loss.
  applySocialNeedTick(goblin, goblins, currentTick, onLog);
  if (burrowComfort > 0) {
    goblin.social = Math.max(0, goblin.social - Math.min(0.7, 0.15 + burrowResters * 0.12));
  }
}

function computeShelterScore(goblin: Goblin, rooms?: Room[], grid?: Tile[][]): number {
  let shelterScore = 0.5;
  if (rooms && rooms.length > 0 && grid) {
    const currentRoom = rooms.find(
      r => goblin.x >= r.x && goblin.x < r.x + r.w && goblin.y >= r.y && goblin.y < r.y + r.h,
    );
    if (currentRoom) {
      if (isOutdoorRoomType(currentRoom.type)) {
        shelterScore = 0.1;
      } else {
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
        shelterScore = 0.4 + 0.6 * wallFraction;
        if (currentRoom.type === 'burrow' && goblin.task.includes('resting') && isOnBurrowBed(goblin, rooms)) {
          shelterScore = Math.max(shelterScore, BURROW_SHELTER_FLOOR);
        }
      }
    } else {
      shelterScore = 0.1;
    }
  }
  return shelterScore;
}

function applyColdExposurePenalty(
  goblin: Goblin,
  currentTick: number,
  ambientColdStress: number,
  shelterScore: number,
  onLog?: LogFn,
): void {
  if (ambientColdStress > 0.05) {
    const warmth = goblin.warmth ?? 0;
    let coldPenalty = inverseSigmoid(warmth, 30, 0.12);
    coldPenalty *= ambientColdStress;
    coldPenalty *= Math.max(0, 1 - SHELTER_COLD_REDUCTION * shelterScore);
    if (coldPenalty > 0.05) {
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.3 * coldPenalty);
      goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.2 * coldPenalty);
      if (shouldLog(goblin, 'freezing', currentTick, 150)) {
        addMemory(goblin, 'freezing', currentTick);
        onLog?.('🥶 freezing in the open', 'warn');
      }
    }
  }
}

function computeBaseMoraleTargetFromThoughtsAndMemories(goblin: Goblin): number {
  let targetMorale = 50;
  for (const t of goblin.thoughts) {
    targetMorale += THOUGHT_DEFS[t.defId]?.delta ?? 0;
  }
  for (const m of goblin.memories) {
    const def = MEMORY_DEFS[m.defId];
    if (def) targetMorale += (def.deltas[m.stage] ?? 0);
  }
  return targetMorale;
}

function applySituationalMoraleAdjustments(
  goblin: Goblin,
  targetMorale: number,
  ambientColdStress: number,
  shelterScore: number,
  burrowComfort: number,
): number {
  let adjusted = targetMorale;
  if (goblin.hunger > 60) adjusted -= Math.round(15 * sigmoid(goblin.hunger, 70));
  if (goblin.hunger < 30) adjusted += Math.round(10 * inverseSigmoid(goblin.hunger, 20));
  if (goblin.social > 60) adjusted -= Math.round(15 * sigmoid(goblin.social, 75));
  if (goblin.fatigue > 80) adjusted -= Math.round(15 * sigmoid(goblin.fatigue, 90));
  if (goblin.onFire) adjusted -= 40;
  if (ambientColdStress > 0.05) {
    const warmth = goblin.warmth ?? 0;
    if (warmth < 30) adjusted -= Math.round(20 * inverseSigmoid(warmth, 15) * ambientColdStress);
  }

  const coldFactor = 0.5 + 0.5 * ambientColdStress;
  if (shelterScore < 0.3) {
    const penalty = Math.round(8 * (0.3 - shelterScore) / 0.3 * coldFactor);
    adjusted -= penalty;
  } else if (shelterScore > 0.7) {
    const bonus = Math.round(8 * (shelterScore - 0.7) / 0.3);
    adjusted += bonus;
  }
  if (burrowComfort > 0) {
    adjusted += Math.round(8 * burrowComfort);
  }
  return Math.max(0, Math.min(100, adjusted));
}

function applyFatigueAndWoundDrain(goblin: Goblin, currentTick: number, onLog?: LogFn): void {
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.08);
  const woundDrain = goblin.wound ? (WOUND_FATIGUE_DRAIN[goblin.wound.type] ?? 0) : 0;
  if (woundDrain > 0) {
    goblin.fatigue = Math.min(100, goblin.fatigue + woundDrain);
  }
  if (goblin.fatigue > 80 && shouldLog(goblin, 'exhausted', currentTick, 150)) {
    addMemory(goblin, 'exhausted_work', currentTick);
    onLog?.('😩 exhausted', 'warn');
  }
}

function applySocialNeedTick(
  goblin: Goblin,
  goblins: Goblin[] | undefined,
  currentTick: number,
  onLog?: LogFn,
): void {
  if (goblins) {
    const FRIEND_RADIUS = traitMod(goblin, 'generosityRange', 2) + 1;
    const FRIEND_REL = 40;
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
      const isolationTicks = currentTick - goblin.lastSocialTick;
      goblin.social = Math.min(100, goblin.social + Math.min(0.5, isolationTicks / 400));
    }
  }
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
  refuelHearth: 'refueling the hearth',
  seekSafety: 'fleeing to safety',
  socialize: 'socializing',
  avoidRival: 'avoiding a rival',
  wander: 'exploring',
  commandMove: 'following orders',
  cook: 'cooking',
  saw: 'sawing',
  smith: 'smithing',
  fightFire: 'fighting fire',
  establishStockpile: 'establishing stockpile',
  captureChicken: 'chasing chicken',
  depositChicken: 'hauling chicken',
};

/** On-fire override: move toward nearest water/pool and set task; pathfinding never routes onto water so we step on when adjacent. */
function tickOnFireGoblin(goblin: Goblin, grid: Tile[][]): void {
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
    if (isWalkable(grid, next.x, next.y)) {
      goblin.x = next.x;
      goblin.y = next.y;
    }
    const distToWater = Math.abs(goblin.x - waterTarget.x) + Math.abs(goblin.y - waterTarget.y);
    if (distToWater === 1) {
      goblin.x = waterTarget.x;
      goblin.y = waterTarget.y;
    }
    goblin.task = `🔥 ON FIRE! → water (${bestDist} tiles)`;
  } else {
    goblin.task = '🔥 ON FIRE! (no water nearby!)';
  }
}

/** Clear cooking/sawing/smithing progress if the goblin has been doing something else for longer than PROGRESS_GRACE_TICKS. Only cooking logs. */
function clearProgressIfInterrupted(
  goblin: Goblin,
  kind: 'cooking' | 'sawing' | 'smithing',
  currentTick: number,
  onLog?: LogFn,
): void {
  if (kind === 'cooking') {
    const idle = currentTick - (goblin.cookingLastActiveTick ?? 0);
    if (goblin.cookingProgress !== undefined && !goblin.task.includes('cooking') && idle > PROGRESS_GRACE_TICKS) {
      goblin.cookingProgress = undefined;
      if (shouldLog(goblin, 'cooking_interrupted', currentTick, 100)) {
        onLog?.(`🔥 ${goblin.name} abandoned their cooking! The food is ruined!`, 'warn');
      }
    }
  } else if (kind === 'sawing') {
    const idle = currentTick - (goblin.sawingLastActiveTick ?? 0);
    if (goblin.sawingProgress !== undefined && !goblin.task.includes('sawing') && idle > PROGRESS_GRACE_TICKS) {
      goblin.sawingProgress = undefined;
    }
  } else {
    const idle = currentTick - (goblin.smithingLastActiveTick ?? 0);
    if (goblin.smithingProgress !== undefined && !goblin.task.includes('smithing') && idle > PROGRESS_GRACE_TICKS) {
      goblin.smithingProgress = undefined;
    }
  }
}

const MOMENTUM_BONUS = 0.4;  // single tune point for action stickiness
const UNDERSTAFF_BONUS_CAP = 0.12;
const SKILL_PREFERENCE_PER_LEVEL = 0.04;
const SKILL_PREFERENCE_CAP = 0.18;
const PREFERRED_CATEGORY_BONUS = 0.07;
const ASSIGNED_JOB_BONUS = 0.6;
/** Ceiling for action score so trait-boosted scores above 1.0 can win; must be >= trait module's TRAIT_SCORE_CAP. */
const MAX_ACTION_SCORE = 2.0;

type ActionSelectionState = {
  bestAction: Action | null;
  bestScore: number;
  secondName: string;
  secondScore: number;
};

function buildActionContext(params: {
  goblin: Goblin;
  grid: Tile[][];
  currentTick: number;
  goblins?: Goblin[];
  onLog?: LogFn;
  foodStockpiles?: FoodStockpile[];
  adventurers?: Adventurer[];
  oreStockpiles?: OreStockpile[];
  colonyGoal?: ColonyGoal;
  woodStockpiles?: WoodStockpile[];
  dangerField?: Float32Array;
  weatherType?: WeatherType;
  ambientColdStress?: number;
  rooms?: Room[];
  mealStockpiles?: MealStockpile[];
  plankStockpiles?: PlankStockpile[];
  barStockpiles?: BarStockpile[];
  chickens?: Chicken[];
  workerTargets?: WorkerTargets;
  currentHeadcounts?: Record<WorkCategoryId, number>;
}): ActionContext {
  const {
    goblin, grid, currentTick, goblins, onLog, foodStockpiles, adventurers, oreStockpiles, colonyGoal,
    woodStockpiles, dangerField, weatherType, ambientColdStress, rooms, mealStockpiles, plankStockpiles, barStockpiles,
    chickens, workerTargets, currentHeadcounts,
  } = params;
  const livingGoblinCount = goblins?.reduce((n, g) => n + (g.alive ? 1 : 0), 0) ?? 0;
  const resourceBalanceBase = computeResourceBalanceModifier(
    foodStockpiles, oreStockpiles, woodStockpiles, mealStockpiles, barStockpiles, plankStockpiles,
    livingGoblinCount,
  );
  const refuelableHearthCount = getRefuelableHearthCount(grid);
  const resourceBalance = {
    ...resourceBalanceBase,
    refuelableHearthCount,
    livingGoblinCount,
  };
  const hasStorage = rooms?.some(r => r.type === 'storage') ?? false;
  const hasLumberHut = rooms?.some(r => r.type === 'lumber_hut') ?? false;
  const hasBlacksmith = rooms?.some(r => r.type === 'blacksmith') ?? false;
  const hasKitchen = rooms?.some(r => r.type === 'kitchen') ?? false;
  const hasBurrow = rooms?.some(r => r.type === 'burrow') ?? false;
  return {
    goblin, grid, currentTick, goblins, onLog,
    foodStockpiles, adventurers, oreStockpiles, woodStockpiles, colonyGoal,
    dangerField, weatherType, ambientColdStress, rooms, mealStockpiles,
    plankStockpiles, barStockpiles,
    chickens,
    resourceBalance,
    roomBonuses: {
      hasStorage,
      hasLumberHut,
      hasBlacksmith,
      hasKitchen,
      hasBurrow,
    },
    workerTargets,
    currentHeadcounts,
  };
}

function applyActionScoreAdjustments(
  score: number,
  action: Action,
  ctx: ActionContext,
  goalBonuses: Partial<Record<string, number>>,
  noFood: boolean,
): number {
  const goblin = ctx.goblin;
  let nextScore = applyTraitBias(goblin, action, score);
  const category = actionNameToWorkCategory(action.name);
  const skillKey = category ? getSkillForCategory(category) : null;
  const level = skillKey ? xpToLevel(goblin.skills[skillKey]) : 0;
  if (category && ctx.workerTargets?.[category] != null && ctx.currentHeadcounts?.[category] != null) {
    const target = ctx.workerTargets[category]!;
    const current = ctx.currentHeadcounts[category]!;
    if (target > 0 && current < target) {
      let bonus = 0.05 * (target - current) / Math.max(target, 1);
      if (skillKey) bonus *= 1 + 0.1 * level;
      bonus = Math.min(bonus, UNDERSTAFF_BONUS_CAP);
      nextScore = Math.min(MAX_ACTION_SCORE, nextScore + bonus);
    }
  }
  if (skillKey) {
    const skillBonus = Math.min(SKILL_PREFERENCE_PER_LEVEL * level, SKILL_PREFERENCE_CAP);
    nextScore = Math.min(MAX_ACTION_SCORE, nextScore + skillBonus);
  }
  if (category && goblin.preferredWorkCategory === category) {
    nextScore = Math.min(MAX_ACTION_SCORE, nextScore + PREFERRED_CATEGORY_BONUS);
  }
  if (category && goblin.assignedJob != null && goblin.assignedJob === category) {
    nextScore = Math.min(MAX_ACTION_SCORE, nextScore + ASSIGNED_JOB_BONUS);
  }
  nextScore *= goalBonuses[action.name] ?? 1.0;
  if (action.name === goblin.lastActionName && action.name !== 'wander') {
    nextScore = Math.min(MAX_ACTION_SCORE, nextScore + MOMENTUM_BONUS);
  }
  if (noFood && goblin.hunger > 70 && (action.name === 'forage' || action.name === 'withdrawFood')) {
    nextScore += 0.08;
  }
  if (action.name === 'wander' && (ctx.resourceBalance?.consumablesPressure ?? 0) > 0.6) {
    nextScore += 0.03;
  }
  if (noFood && goblin.hunger > 85 && action.name === 'withdrawFood') {
    nextScore = Math.max(nextScore, 2.0);
  }
  if (noFood && goblin.hunger > 85 && action.name === 'forage' && nextScore > 0.2) {
    nextScore = Math.max(nextScore, 2.0);
  }
  if (action.name === 'seekSafety' && ctx.dangerField && getDanger(ctx.dangerField, goblin.x, goblin.y) > 85) {
    nextScore = Math.max(nextScore, 2.0);
  }
  if (action.name === 'eat' && goblin.hunger > 90) {
    nextScore = Math.max(nextScore, 2.0);
  }
  if (action.name === 'rest' && goblin.fatigue > 90) {
    nextScore = Math.max(nextScore, 2.0);
  }
  return nextScore;
}

function updateSelectionState(
  state: ActionSelectionState,
  action: Action,
  score: number,
): ActionSelectionState {
  if (score > state.bestScore) {
    return {
      bestAction: action,
      bestScore: score,
      secondName: state.bestAction?.name ?? '',
      secondScore: state.bestScore,
    };
  }
  if (score > state.secondScore) {
    return {
      ...state,
      secondName: action.name,
      secondScore: score,
    };
  }
  return state;
}

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
  dangerField?: Float32Array,
  weatherType?: WeatherType,
  ambientColdStress?: number,
  rooms?: Room[],
  mealStockpiles?: MealStockpile[],
  plankStockpiles?: PlankStockpile[],
  barStockpiles?: BarStockpile[],
  chickens?: Chicken[],
  workerTargets?: WorkerTargets,
  currentHeadcounts?: Record<WorkCategoryId, number>,
): void {
  if (!goblin.alive) return;

  // Safety: if a world event (wall built, tile changed) trapped the goblin on an
  // unwalkable tile, nudge them to an adjacent walkable tile before doing anything else.
  if (!isWalkable(grid, goblin.x, goblin.y)) {
    for (const d of CARDINAL_DIRECTIONS) {
      if (isWalkable(grid, goblin.x + d.x, goblin.y + d.y)) {
        goblin.x += d.x; goblin.y += d.y;
        break;
      }
    }
  }

  // ── Step 1: Update needs ──────────────────────────────────────────────────────
  // Hunger, morale, fatigue, and social all advance here before any decision is made.
  // These feed into action scores — a goblin with hunger=80 will score "eat" near 1.0.
  updateNeeds(goblin, goblins, currentTick, weatherMetabolismMod ?? 1, weatherType, ambientColdStress ?? 0, rooms, grid, onLog);

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
  if (goblin.onFire) {
    tickOnFireGoblin(goblin, grid);
    return;
  }

  // ── Step 3: Build action context ─────────────────────────────────────────────
  // ActionContext is just a read-only bag of world references passed to every action's
  // eligible() and score() functions. Actions don't reach outside this object.
  // Compute resource balance once per tick and cache it to avoid redundant array reduces.
  const ctx: ActionContext = buildActionContext({
    goblin, grid, currentTick, goblins, onLog, foodStockpiles, adventurers, oreStockpiles, colonyGoal,
    woodStockpiles, dangerField, weatherType, ambientColdStress, rooms, mealStockpiles, plankStockpiles, barStockpiles,
    chickens, workerTargets, currentHeadcounts,
  });

  // Stale mushroom memories still made forage score high (stock-the-larder floor + hunger
  // override) while execute only cleared them after winning — goblins looped "searching for food".
  pruneInvalidKnownFoodSites(goblin, grid);

  // ── Step 4: Score all eligible actions ──────────────────────────────────────
  // Each action has two functions:
  //   eligible(ctx) → boolean  — hard gate (role check, resource check, etc.)
  //   score(ctx)    → 0.0–1.0  — soft preference built from response curves
  const goalBonuses = colonyGoal ? GOAL_CONFIG[colonyGoal.type].actionBonuses : {};
  let selectionState: ActionSelectionState = {
    bestAction: null,
    bestScore: -1,
    secondName: '',
    secondScore: -1,
  };
  const noFood = goblin.inventory.food === 0 && goblin.inventory.meals === 0;

  for (const action of ALL_ACTIONS) {
    if (!action.eligible(ctx)) continue;
    const score = applyActionScoreAdjustments(action.score(ctx), action, ctx, goalBonuses, noFood);
    selectionState = updateSelectionState(selectionState, action, score);
  }

  // Close-call log: fires when top two scores are within 0.03 AND both are genuinely urgent
  // (above 0.45). A goblin choosing between "idle" and "wander" isn't agonizing — one
  // choosing between "eat" and "flee" is.
  if (selectionState.bestAction && selectionState.secondScore >= 0 && selectionState.bestScore - selectionState.secondScore <= 0.03 && selectionState.bestScore > 0.45) {
    if (shouldLog(goblin, 'close_call', currentTick, 400)) {
      const nameA = ACTION_DISPLAY_NAMES[selectionState.bestAction.name] ?? selectionState.bestAction.name;
      const nameB = ACTION_DISPLAY_NAMES[selectionState.secondName] ?? selectionState.secondName;
      onLog?.(`⚖ agonizing over ${nameA} vs ${nameB}`, 'info');
    }
  }

  // ── Step 5: Execute ──────────────────────────────────────────────────────────
  // Set an idle description first — execute() will overwrite goblin.task if it does real work.
  // If execute() returns early (e.g. pathfinding finds nothing), the idle string shows in the HUD.
  goblin.task = idleDescription(goblin);
  let workCategoryRefreshedThisTick = false;
  if (selectionState.bestAction) {
    selectionState.bestAction.execute(ctx);
    goblin.lastActionName = selectionState.bestAction.name;
    const workCat = actionNameToWorkCategory(selectionState.bestAction.name);
    if (workCat != null) {
      goblin.lastWorkCategory = workCat;
      goblin.lastWorkCategoryTick = currentTick;
      workCategoryRefreshedThisTick = true;
    }
  } else {
    goblin.lastActionName = '';
  }
  if (!workCategoryRefreshedThisTick) {
    const age = currentTick - (goblin.lastWorkCategoryTick ?? 0);
    if (age > LAST_JOB_PERSIST_TICKS) {
      goblin.lastWorkCategory = undefined;
      goblin.lastWorkCategoryTick = undefined;
    }
  }

  // ── Step 6: Handle interrupted multi-tick progress ────────────────────────────
  clearProgressIfInterrupted(goblin, 'cooking', currentTick, onLog);
  clearProgressIfInterrupted(goblin, 'sawing', currentTick, onLog);
  clearProgressIfInterrupted(goblin, 'smithing', currentTick, onLog);
}

/** Describe why a goblin is between actions — shown when execute returns early or nothing wins. */
function idleDescription(goblin: Goblin): string {
  if (goblin.fatigue > 60) return 'exhausted, catching breath';
  if (goblin.fatigue > 20) return 'catching breath';
  if (goblin.hunger > 70) return 'desperately hungry';
  if (goblin.hunger > 50) return 'hungry, looking for food';
  if ((goblin.warmth ?? 100) < 20) return 'looking for warmth';
  if (goblin.morale < 25) return 'brooding';
  if (goblin.social > 65) return 'feeling lonely';
  if ((goblin.warmth ?? 100) < 35) return 'a bit chilly';
  return 'idle';
}
