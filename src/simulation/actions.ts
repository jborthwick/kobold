/**
 * Utility AI action definitions.
 *
 * Each action has:
 *   eligible(ctx) — can this action run right now?
 *   score(ctx)    — 0–1 desirability
 *   execute(ctx)  — mutate goblin state (movement, harvesting, etc.)
 *   intentMatch   — LLM intent that boosts this action's score by +0.5
 *
 * Actions are evaluated in order but the highest score wins — order only
 * matters as a tiebreaker for equal scores.
 */

import { TileType, type Goblin, type Tile, type LLMIntent, type GoblinTrait, type Adventurer, type FoodStockpile, type OreStockpile, type WoodStockpile, type ColonyGoal, type ResourceSite, type WeatherType } from '../shared/types';
import { getWarmth, getDanger } from './diffusion';
import { getActiveFaction } from '../shared/factions';
import { GRID_SIZE, MAX_INVENTORY_FOOD } from '../shared/constants';
import { isWalkable } from './world';
import { sigmoid, inverseSigmoid, ramp } from './utilityAI';
import {
  pathNextStep, bestFoodTile, bestMaterialTile, bestWoodTile,
  fortWallSlots, fortEnclosureSlots,
  recordSite, FORAGEABLE_TILES, SITE_RECORD_THRESHOLD, PATCH_MERGE_RADIUS,
  traitMod,
} from './agents';
import { grantXp, skillYieldBonus, skillOreBonus } from './skills';
import { effectiveVision, isLegWoundSkip, woundYieldMultiplier, accelerateHealing } from './wounds';

// ── Trait-flavored log text ──────────────────────────────────────────────────

const TRAIT_FLAVOR: Record<GoblinTrait, Record<string, string>> = {
  lazy:      { eat: 'scarfed down food messily',       rest: 'collapsed into a heap',          share: 'grudgingly tossed over some food' },
  helpful:   { eat: 'gobbled food quickly',            rest: 'rested briefly',                 share: 'excitedly shared' },
  greedy:    { eat: 'ate greedily, hiding scraps',     rest: 'rested atop his hoard',          share: 'painfully parted with some food' },
  brave:     { eat: 'ate without looking',             rest: 'caught breath mid-charge',       share: 'shared' },
  cheerful:  { eat: 'ate with a grin',                 rest: 'napped with a smile',            share: 'gladly shared' },
  mean:      { eat: 'ate alone, growling',             rest: 'rested, glaring at everyone',    share: 'begrudgingly shared' },
  paranoid:  { eat: 'ate while looking around wildly', rest: 'rested with both eyes open',     share: 'cautiously shared' },
  forgetful: { eat: 'ate... wait, what?',              rest: 'dozed off mid-thought',          share: 'shared (forgot he gave it away)' },
};

function traitText(goblin: Goblin, action: string): string {
  return TRAIT_FLAVOR[goblin.trait]?.[action] ?? action;
}

/** Cooldown-gated log: returns true (and records the tick) at most once per `cooldown` ticks. */
function shouldLog(goblin: Goblin, key: string, tick: number, cooldown: number): boolean {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export interface ActionContext {
  goblin:           Goblin;
  grid:            Tile[][];
  currentTick:     number;
  goblins?:        Goblin[];
  onLog?:          LogFn;
  foodStockpiles?: FoodStockpile[];
  adventurers?:        Adventurer[];
  oreStockpiles?:  OreStockpile[];
  woodStockpiles?: WoodStockpile[];
  colonyGoal?:     ColonyGoal;
  warmthField?:    Float32Array;  // diffusion field: warmth 0–100 per tile
  dangerField?:    Float32Array;  // diffusion field: danger 0–100 per tile
  weatherType?:    WeatherType;
}

export interface Action {
  name:         string;
  intentMatch?: LLMIntent;  // which LLM intent boosts this action
  eligible:     (ctx: ActionContext) => boolean;
  score:        (ctx: ActionContext) => number;
  execute:      (ctx: ActionContext) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fatigueRate(goblin: Goblin): number {
  return traitMod(goblin, 'fatigueRate', 1.0);
}

function moveTo(goblin: Goblin, target: { x: number; y: number }, grid: Tile[][]): void {
  // Leg wound: 40% chance to skip this tick's movement (limp)
  if (isLegWoundSkip(goblin)) return;
  const next = pathNextStep({ x: goblin.x, y: goblin.y }, target, grid);
  goblin.x = next.x;
  goblin.y = next.y;
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
}

function addWorkFatigue(goblin: Goblin): void {
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate(goblin));
}

/** Find nearest food stockpile matching a filter. */
function nearestFoodStockpile(
  goblin: Goblin, stockpiles: FoodStockpile[] | undefined, filter: (s: FoodStockpile) => boolean,
): FoodStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<FoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

function nearestOreStockpile(
  goblin: Goblin, stockpiles: OreStockpile[] | undefined, filter: (s: OreStockpile) => boolean,
): OreStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<OreStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

function nearestWoodStockpile(
  goblin: Goblin, stockpiles: WoodStockpile[] | undefined, filter: (s: WoodStockpile) => boolean,
): WoodStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<WoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

// ── Action definitions ─────────────────────────────────────────────────────────

// --- commandMove: player override (always wins) ---
const commandMove: Action = {
  name: 'commandMove',
  eligible: ({ goblin }) => goblin.commandTarget !== null,
  score: () => 1.0,
  execute: ({ goblin, grid, onLog }) => {
    const { x: tx, y: ty } = goblin.commandTarget!;
    if (goblin.x === tx && goblin.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      goblin.commandTarget = null;
      goblin.task          = 'arrived';
    } else {
      moveTo(goblin, goblin.commandTarget!, grid);
      goblin.task = `→ (${tx},${ty})`;
    }
  },
};

// --- eat: consume food from inventory ---
const eat: Action = {
  name: 'eat',
  intentMatch: 'eat',
  eligible: ({ goblin }) => goblin.inventory.food > 0 && goblin.hunger > 20,
  score: ({ goblin }) => {
    const mid = traitMod(goblin, 'eatThreshold', 70);
    return sigmoid(goblin.hunger, mid);
  },
  execute: ({ goblin, currentTick, onLog }) => {
    const wasDesperatelyHungry = goblin.hunger > 80;
    const bite = Math.min(goblin.inventory.food, 3);
    goblin.inventory.food -= bite;
    goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
    goblin.task = 'eating';
    // Only log desperate eating — routine meals are too noisy
    if (wasDesperatelyHungry && shouldLog(goblin, 'eat', currentTick, 200)) {
      onLog?.(`🍖 ${traitText(goblin, 'eat')} — was starving`, 'warn');
    }
  },
};

// --- rest: stay still, recover fatigue; warmth tiers bonus ---
const rest: Action = {
  name: 'rest',
  intentMatch: 'rest',
  eligible: ({ goblin }) => goblin.fatigue > 20,
  score: ({ goblin }) => sigmoid(goblin.fatigue, 60),
  execute: ({ goblin, warmthField }) => {
    const warmth = warmthField ? getWarmth(warmthField, goblin.x, goblin.y) : 0;
    if (warmth >= 40) {
      // Sheltered by hearth — best recovery
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.5);
      accelerateHealing(goblin, 3);
      goblin.morale  = Math.min(100, goblin.morale + 0.3);
      goblin.task    = goblin.wound ? `resting by the hearth (healing ${goblin.wound.type})` : 'resting by the hearth';
    } else if (warmth >= 20) {
      // Mild warmth — small bonus
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.0);
      accelerateHealing(goblin, 2);
      goblin.morale  = Math.min(100, goblin.morale + 0.1);
      goblin.task    = goblin.wound ? `resting near warmth (healing ${goblin.wound.type})` : 'resting near warmth';
    } else {
      // Exposed — baseline
      goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
      accelerateHealing(goblin, 2);
      goblin.task    = goblin.wound ? `resting (healing ${goblin.wound.type})` : 'resting';
    }
  },
};

// --- share: gift food to a hungry neighbor ---
const share: Action = {
  name: 'share',
  eligible: ({ goblin, goblins }) => {
    if (!goblins) return false;
    const shareThresh = traitMod(goblin, 'shareThreshold', 8);
    if (goblin.inventory.food < shareThresh) return false;
    const relGate = traitMod(goblin, 'shareRelationGate', 30);
    return goblins.some(d =>
      d.alive && d.id !== goblin.id &&
      Math.abs(d.x - goblin.x) <= 2 && Math.abs(d.y - goblin.y) <= 2 &&
      d.hunger > 60 && d.inventory.food < 3 &&
      (goblin.relations[d.id] ?? 50) >= relGate,
    );
  },
  score: ({ goblin, goblins }) => {
    if (!goblins) return 0;
    const relGate = traitMod(goblin, 'shareRelationGate', 30);
    const target = goblins
      .filter(d =>
        d.alive && d.id !== goblin.id &&
        Math.abs(d.x - goblin.x) <= 2 && Math.abs(d.y - goblin.y) <= 2 &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (goblin.relations[d.id] ?? 50) >= relGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return 0;
    // Higher score when target is hungrier and we have more surplus
    return sigmoid(target.hunger, 70) * ramp(goblin.inventory.food, 6, 15) * 0.7;
  },
  execute: ({ goblin, goblins, currentTick, onLog }) => {
    if (!goblins) return;
    const relGate = traitMod(goblin, 'shareRelationGate', 30);
    const donorKeeps = traitMod(goblin, 'shareDonorKeeps', 5);
    const target = goblins
      .filter(d =>
        d.alive && d.id !== goblin.id &&
        Math.abs(d.x - goblin.x) <= 2 && Math.abs(d.y - goblin.y) <= 2 &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (goblin.relations[d.id] ?? 50) >= relGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return;
    const give = Math.min(3, goblin.inventory.food - donorKeeps);
    if (give <= 0) return;
    const headroom = MAX_INVENTORY_FOOD - target.inventory.food;
    const actual   = Math.min(give, headroom);
    if (actual <= 0) return;
    goblin.inventory.food  -= actual;
    target.inventory.food += actual;
    const prevRel = goblin.relations[target.id] ?? 50;
    goblin.relations[target.id]  = Math.min(100, prevRel + 5);
    target.relations[goblin.id]  = Math.min(100, (target.relations[goblin.id] ?? 50) + 3);
    goblin.task = `shared ${actual.toFixed(0)} food → ${target.name}`;
    onLog?.(`🤝 ${traitText(goblin, 'share')} ${actual.toFixed(0)} food with ${target.name}`, 'info');
    // Friendship milestone — relation crossed 70
    if (prevRel < 70 && goblin.relations[target.id] >= 70 && shouldLog(goblin, `friend_${target.id}`, currentTick, 300)) {
      onLog?.(`💛 became friends with ${target.name}`, 'info');
    }
  },
};

// --- fight: fighters hunt nearby adventurers ---
const fight: Action = {
  name: 'fight',
  intentMatch: undefined,
  eligible: ({ goblin, adventurers }) => {
    if (goblin.role !== 'fighter' || !adventurers || adventurers.length === 0) return false;
    const fleeAt = traitMod(goblin, 'fleeThreshold', 80);
    return goblin.hunger < fleeAt;
  },
  score: ({ goblin, adventurers }) => {
    if (!adventurers || adventurers.length === 0) return 0;
    const HUNT_RADIUS = effectiveVision(goblin) * 2;
    const nearest = adventurers.reduce<{ dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return (!best || dist < best.dist) ? { dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return 0;
    // Closer adventurers score higher; less hungry = more willing to fight
    return inverseSigmoid(nearest.dist, HUNT_RADIUS * 0.5, 0.2) * inverseSigmoid(goblin.hunger, 60);
  },
  execute: ({ goblin, adventurers, grid, currentTick, onLog }) => {
    if (!adventurers) return;
    const HUNT_RADIUS = effectiveVision(goblin) * 2;
    const nearest = adventurers.reduce<{ g: Adventurer; dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return (!best || dist < best.dist) ? { g, dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return;
    if (nearest.dist > 0) {
      // Sprint — two steps toward adventurer (leg wound may skip each step)
      if (!isLegWoundSkip(goblin)) {
        const step1 = pathNextStep({ x: goblin.x, y: goblin.y }, { x: nearest.g.x, y: nearest.g.y }, grid);
        goblin.x = step1.x; goblin.y = step1.y;
      }
      if (!isLegWoundSkip(goblin)) {
        const step2 = pathNextStep({ x: goblin.x, y: goblin.y }, { x: nearest.g.x, y: nearest.g.y }, grid);
        goblin.x = step2.x; goblin.y = step2.y;
      }
    }
    goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate(goblin));
    const distAfter = Math.abs(nearest.g.x - goblin.x) + Math.abs(nearest.g.y - goblin.y);
    const enemySing = getActiveFaction().enemyNounPlural.replace(/s$/, '');
    goblin.task = distAfter === 0 ? `fighting ${enemySing}!` : `→ ${enemySing} (${distAfter} tiles)`;
    // Fighter XP — grant on engaging in combat
    if (distAfter === 0) grantXp(goblin, currentTick, onLog);
  },
};

// --- forage: scan for food, pathfind, harvest ---
const forage: Action = {
  name: 'forage',
  intentMatch: 'forage',
  eligible: ({ goblin }) => {
    const inventoryFull = goblin.inventory.food >= MAX_INVENTORY_FOOD;
    if (inventoryFull) return false;
    // Miners/lumberjacks skip food when not hungry
    if ((goblin.role === 'miner' || goblin.role === 'lumberjack') && goblin.hunger < 50) return false;
    return true;
  },
  score: ({ goblin, grid }) => {
    const vision = effectiveVision(goblin);
    const radius = goblin.hunger > 65 ? Math.min(vision * 2, 15) : vision;
    const target = bestFoodTile(goblin, grid, radius);
    if (!target) {
      // Check remembered food sites
      if (goblin.knownFoodSites.length > 0) return sigmoid(goblin.hunger, 40) * 0.4;
      return 0;
    }
    return sigmoid(goblin.hunger, 40) * 0.8;
  },
  execute: (ctx) => {
    const { goblin, grid, currentTick, goblins, onLog } = ctx;
    const vision = effectiveVision(goblin);
    const radius = goblin.llmIntent === 'forage' ? 15
      : goblin.hunger > 65 ? Math.min(vision * 2, 15)
      : vision;
    const foodTarget = bestFoodTile(goblin, grid, radius);

    // Record visible food sites in memory
    if (foodTarget) {
      const tv = grid[foodTarget.y][foodTarget.x].foodValue;
      if (tv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownFoodSites, foodTarget.x, foodTarget.y, tv, currentTick);
      }
    }

    if (foodTarget) {
      if (goblin.x !== foodTarget.x || goblin.y !== foodTarget.y) {
        moveTo(goblin, foodTarget, grid);
      }
      const here = grid[goblin.y][goblin.x];

      // Contest yield — if a hungrier goblin is on the same tile, yield
      if (goblins) {
        const rival = goblins.find(d =>
          d.alive && d.id !== goblin.id &&
          d.x === goblin.x && d.y === goblin.y &&
          d.hunger > goblin.hunger,
        );
        if (rival) {
          const relation = goblin.relations[rival.id] ?? 50;
          if (relation >= 60) {
            goblin.relations[rival.id] = Math.min(100, relation + 2);
            goblin.task = `sharing tile with ${rival.name}`;
            return;
          }
          const penalty = traitMod(goblin, 'contestPenalty', -5);
          const newRel = Math.max(0, relation + penalty);
          goblin.relations[rival.id] = newRel;
          // Rivalry milestone — relation dropped below 20
          if (relation >= 20 && newRel < 20 && shouldLog(goblin, `rival_${rival.id}`, currentTick, 300)) {
            onLog?.(`💢 growing rivalry with ${rival.name}`, 'warn');
          }
          const escapeDirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
          const escapeOpen = escapeDirs
            .map(d => ({ x: goblin.x + d.dx, y: goblin.y + d.dy }))
            .filter(p => isWalkable(grid, p.x, p.y));
          if (escapeOpen.length > 0) {
            const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
            goblin.x = step.x; goblin.y = step.y;
          }
          goblin.task = `yielding to ${rival.name}`;
          return;
        }
      }

      // Harvest
      const headroom = MAX_INVENTORY_FOOD - goblin.inventory.food;
      if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
        const depletionRate = goblin.role === 'forager' ? 6 : 5;
        const baseYield     = (goblin.role === 'forager' ? 2 : 1) + skillYieldBonus(goblin);
        const moraleScale   = 0.5 + (goblin.morale / 100) * 0.5;
        const fatigueScale  = goblin.fatigue > 70 ? 0.5 : 1.0;
        const woundScale    = woundYieldMultiplier(goblin);
        const harvestYield  = Math.max(1, Math.round(baseYield * moraleScale * fatigueScale * woundScale));
        const hadFood       = here.foodValue;
        const depleted      = Math.min(hadFood, depletionRate);
        here.foodValue      = Math.max(0, hadFood - depleted);
        if (here.foodValue === 0) { here.type = TileType.Dirt; here.maxFood = 0; }
        const amount         = Math.min(harvestYield, depleted, headroom);
        goblin.inventory.food += amount;
        addWorkFatigue(goblin);
        // Forager XP — grant on successful harvest
        if (goblin.role === 'forager') grantXp(goblin, currentTick, onLog);
        goblin.task = `harvesting (food: ${goblin.inventory.food.toFixed(0)})`;
      } else {
        goblin.task = `foraging → (${foodTarget.x},${foodTarget.y})`;
      }
      return;
    }

    // No food visible — try remembered food site
    if (goblin.knownFoodSites.length > 0) {
      const best = goblin.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
      if (goblin.x === best.x && goblin.y === best.y) {
        // Arrived — check if still harvestable
        const tileHere  = grid[goblin.y][goblin.x];
        const stillGood = tileHere.foodValue >= 1 && FORAGEABLE_TILES.has(tileHere.type);
        if (!stillGood) {
          let better: ResourceSite | null = null;
          for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
            for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
              const nx = best.x + dx, ny = best.y + dy;
              if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
              const t = grid[ny][nx];
              if (!FORAGEABLE_TILES.has(t.type) || t.foodValue < 1) continue;
              if (!better || t.foodValue > better.value) {
                better = { x: nx, y: ny, value: t.foodValue, tick: currentTick };
              }
            }
          }
          if (better) {
            goblin.knownFoodSites = goblin.knownFoodSites.map(
              s => (s.x === best.x && s.y === best.y) ? better! : s,
            );
          } else {
            goblin.knownFoodSites = goblin.knownFoodSites.filter(
              s => !(s.x === best.x && s.y === best.y),
            );
          }
        } else {
          recordSite(goblin.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
        }
        // Fall through to let next tick harvest
      } else {
        moveTo(goblin, best, grid);
        goblin.task = '→ remembered patch';
      }
    }
  },
};

// --- depositFood: carry surplus food to stockpile ---
const depositFood: Action = {
  name: 'depositFood',
  eligible: ({ goblin, foodStockpiles }) => {
    if (goblin.inventory.food < 10 || goblin.hunger >= 55) return false;
    const target = nearestFoodStockpile(goblin, foodStockpiles, s => s.food < s.maxFood);
    return target !== null && !(goblin.x === target.x && goblin.y === target.y);
  },
  score: ({ goblin }) => ramp(goblin.inventory.food, 8, 20) * inverseSigmoid(goblin.hunger, 50) * 0.6,
  execute: ({ goblin, grid, foodStockpiles }) => {
    const target = nearestFoodStockpile(goblin, foodStockpiles, s => s.food < s.maxFood);
    if (!target) return;
    moveTo(goblin, target, grid);
    goblin.task = '→ home (deposit)';
  },
};

// --- withdrawFood: run to stockpile when hungry and empty ---
const withdrawFood: Action = {
  name: 'withdrawFood',
  eligible: ({ goblin, foodStockpiles }) => {
    if (goblin.hunger <= 65 || goblin.inventory.food > 0) return false;
    const target = nearestFoodStockpile(goblin, foodStockpiles, s => s.food > 0);
    return target !== null && !(goblin.x === target.x && goblin.y === target.y);
  },
  score: ({ goblin }) => sigmoid(goblin.hunger, 65) * 0.55,
  execute: ({ goblin, grid, foodStockpiles }) => {
    const target = nearestFoodStockpile(goblin, foodStockpiles, s => s.food > 0);
    if (!target) return;
    moveTo(goblin, target, grid);
    goblin.task = `→ stockpile (${target.food.toFixed(0)} food)`;
  },
};

// --- mine: miners target ore tiles ---
const mine: Action = {
  name: 'mine',
  eligible: ({ goblin }) => goblin.role === 'miner',
  score: ({ goblin, grid }) => {
    const target = bestMaterialTile(goblin, grid, effectiveVision(goblin));
    if (!target) {
      // Check remembered ore sites
      if (goblin.knownOreSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35;
      return 0;
    }
    return inverseSigmoid(goblin.hunger, 60) * 0.6;
  },
  execute: (ctx) => {
    const { goblin, grid, currentTick, onLog } = ctx;
    const oreTarget = bestMaterialTile(goblin, grid, effectiveVision(goblin));

    // Record visible ore sites
    if (oreTarget) {
      const mv = grid[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }

    if (oreTarget) {
      if (goblin.x !== oreTarget.x || goblin.y !== oreTarget.y) {
        moveTo(goblin, oreTarget, grid);
      }
      const here = grid[goblin.y][goblin.x];
      if (here.materialValue >= 1) {
        const hadMat       = here.materialValue;
        const baseOre      = 2 + skillOreBonus(goblin);
        const oreYield     = Math.max(1, Math.round(baseOre * woundYieldMultiplier(goblin)));
        const mined        = Math.min(hadMat, oreYield);
        here.materialValue = Math.max(0, hadMat - mined);
        if (here.materialValue === 0) { here.type = TileType.Stone; here.maxMaterial = 0; }
        goblin.inventory.materials = Math.min(goblin.inventory.materials + mined, MAX_INVENTORY_FOOD);
        addWorkFatigue(goblin);
        // Miner XP — grant on successful ore extraction
        grantXp(goblin, currentTick, onLog);
        goblin.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
      } else {
        goblin.task = `mining → (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }

    // No ore visible — try remembered ore site
    if (goblin.knownOreSites.length > 0) {
      const best = goblin.knownOreSites.reduce((a, b) => b.value > a.value ? b : a);
      if (goblin.x === best.x && goblin.y === best.y) {
        const tileHere = grid[goblin.y][goblin.x];
        if (tileHere.materialValue < 1 || tileHere.type === TileType.Forest) {
          goblin.knownOreSites = goblin.knownOreSites.filter(s => !(s.x === best.x && s.y === best.y));
        } else {
          recordSite(goblin.knownOreSites, best.x, best.y, tileHere.materialValue, currentTick);
        }
      } else {
        moveTo(goblin, best, grid);
        goblin.task = '→ remembered ore vein';
      }
    }
  },
};

// --- chop: lumberjacks target forest tiles ---
const chop: Action = {
  name: 'chop',
  eligible: ({ goblin }) => goblin.role === 'lumberjack',
  score: ({ goblin, grid }) => {
    const target = bestWoodTile(goblin, grid, effectiveVision(goblin));
    if (!target) {
      if (goblin.knownWoodSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35;
      return 0;
    }
    return inverseSigmoid(goblin.hunger, 60) * 0.6;
  },
  execute: (ctx) => {
    const { goblin, grid, currentTick, onLog } = ctx;
    const woodTarget = bestWoodTile(goblin, grid, effectiveVision(goblin));

    // Record visible wood sites
    if (woodTarget) {
      const mv = grid[woodTarget.y][woodTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownWoodSites, woodTarget.x, woodTarget.y, mv, currentTick);
      }
    }

    if (woodTarget) {
      if (goblin.x !== woodTarget.x || goblin.y !== woodTarget.y) {
        moveTo(goblin, woodTarget, grid);
      }
      const here = grid[goblin.y][goblin.x];
      if (here.type === TileType.Forest && here.materialValue >= 1) {
        const hadWood      = here.materialValue;
        const baseChop     = 2 + skillYieldBonus(goblin);
        const chopYield    = Math.max(1, Math.round(baseChop * woundYieldMultiplier(goblin)));
        const chopped      = Math.min(hadWood, chopYield);
        here.materialValue = Math.max(0, hadWood - chopped);
        goblin.inventory.materials = Math.min(goblin.inventory.materials + chopped, MAX_INVENTORY_FOOD);
        addWorkFatigue(goblin);
        // Lumberjack XP — grant on successful wood chop
        grantXp(goblin, currentTick, onLog);
        goblin.task = `logging (wood: ${here.materialValue.toFixed(0)})`;
      } else {
        goblin.task = `→ forest (${woodTarget.x},${woodTarget.y})`;
      }
      return;
    }

    // No wood visible — try remembered wood site
    if (goblin.knownWoodSites.length > 0) {
      const best = goblin.knownWoodSites.reduce((a, b) => b.value > a.value ? b : a);
      if (goblin.x === best.x && goblin.y === best.y) {
        const tileHere = grid[goblin.y][goblin.x];
        if (tileHere.type !== TileType.Forest || tileHere.materialValue < 1) {
          goblin.knownWoodSites = goblin.knownWoodSites.filter(s => !(s.x === best.x && s.y === best.y));
        } else {
          recordSite(goblin.knownWoodSites, best.x, best.y, tileHere.materialValue, currentTick);
        }
      } else {
        moveTo(goblin, best, grid);
        goblin.task = '→ remembered forest';
      }
    }
  },
};

// --- depositOre: miners carry ore to stockpile ---
const depositOre: Action = {
  name: 'depositOre',
  eligible: ({ goblin, oreStockpiles }) => {
    if (goblin.role !== 'miner' || goblin.inventory.materials < 8) return false;
    const target = nearestOreStockpile(goblin, oreStockpiles, s => s.ore < s.maxOre);
    return target !== null && !(goblin.x === target.x && goblin.y === target.y);
  },
  score: ({ goblin }) => ramp(goblin.inventory.materials, 6, 20) * 0.5,
  execute: ({ goblin, grid, oreStockpiles }) => {
    const target = nearestOreStockpile(goblin, oreStockpiles, s => s.ore < s.maxOre);
    if (!target) return;
    moveTo(goblin, target, grid);
    goblin.task = `→ ore stockpile (${goblin.inventory.materials.toFixed(0)} ore)`;
  },
};

// --- depositWood: lumberjacks carry wood to stockpile ---
const depositWood: Action = {
  name: 'depositWood',
  eligible: ({ goblin, woodStockpiles }) => {
    if (goblin.role !== 'lumberjack' || goblin.inventory.materials < 8) return false;
    const target = nearestWoodStockpile(goblin, woodStockpiles, s => s.wood < s.maxWood);
    return target !== null && !(goblin.x === target.x && goblin.y === target.y);
  },
  score: ({ goblin }) => ramp(goblin.inventory.materials, 6, 20) * 0.5,
  execute: ({ goblin, grid, woodStockpiles }) => {
    const target = nearestWoodStockpile(goblin, woodStockpiles, s => s.wood < s.maxWood);
    if (!target) return;
    moveTo(goblin, target, grid);
    goblin.task = `→ wood stockpile (${goblin.inventory.materials.toFixed(0)} wood)`;
  },
};

// --- buildWall: any goblin can build fort walls ---
const buildWall: Action = {
  name: 'buildWall',
  eligible: ({ goblin, foodStockpiles, oreStockpiles }) => {
    if (goblin.hunger >= 65) return false;
    if (!foodStockpiles?.length || !oreStockpiles?.length) return false;
    const buildStockpile = oreStockpiles.find(s => s.ore >= 3);
    return buildStockpile !== null && buildStockpile !== undefined;
  },
  score: ({ goblin, oreStockpiles }) => {
    const totalOre = oreStockpiles?.reduce((s, o) => s + o.ore, 0) ?? 0;
    return ramp(totalOre, 3, 30) * inverseSigmoid(goblin.hunger, 50) * 0.45;
  },
  execute: ({ goblin, grid, foodStockpiles, oreStockpiles, goblins, adventurers }) => {
    if (!foodStockpiles || !oreStockpiles) return;
    const buildStockpile = oreStockpiles.find(s => s.ore >= 3);
    if (!buildStockpile) return;

    let wallSlots = fortWallSlots(foodStockpiles, oreStockpiles, grid, goblins, goblin.id, adventurers);
    if (wallSlots.length === 0) {
      wallSlots = fortEnclosureSlots(foodStockpiles, oreStockpiles, grid, goblins, goblin.id, adventurers);
    }

    let nearestSlot: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (const s of wallSlots) {
      const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      if (dist > 0 && dist < nearestDist) { nearestDist = dist; nearestSlot = s; }
    }

    if (nearestSlot) {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, nearestSlot, grid);
      if (next.x === nearestSlot.x && next.y === nearestSlot.y) {
        const t = grid[nearestSlot.y][nearestSlot.x];
        grid[nearestSlot.y][nearestSlot.x] = {
          ...t, type: TileType.Wall,
          foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0,
        };
        buildStockpile.ore -= 3;
        addWorkFatigue(goblin);
        goblin.task = 'built fort wall!';
      } else {
        goblin.x = next.x; goblin.y = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
        goblin.task = '→ fort wall';
      }
    }
  },
};

// --- socialize: seek out a friendly goblin ---
const socialize: Action = {
  name: 'socialize',
  intentMatch: 'socialize',
  eligible: ({ goblin }) => goblin.social > 30,
  score: ({ goblin }) => sigmoid(goblin.social, 50) * 0.6,
  execute: ({ goblin, goblins, grid }) => {
    if (!goblins) { goblin.task = 'lonely'; return; }
    const FRIEND_REL = 40;
    let bestDist = Infinity;
    let bestFriend: Goblin | null = null;
    for (const other of goblins) {
      if (other.id === goblin.id || !other.alive) continue;
      if ((goblin.relations[other.id] ?? 50) < FRIEND_REL) continue;
      const dist = Math.abs(other.x - goblin.x) + Math.abs(other.y - goblin.y);
      if (dist < bestDist) { bestDist = dist; bestFriend = other; }
    }
    if (bestFriend && bestDist > 1) {
      moveTo(goblin, { x: bestFriend.x, y: bestFriend.y }, grid);
    }
    goblin.task = 'socializing';
  },
};

// --- avoidRival: flee from nearby threats ---
const avoidRival: Action = {
  name: 'avoidRival',
  intentMatch: 'avoid',
  eligible: ({ goblin, goblins }) => {
    if (!goblins) return false;
    return goblins.some(r =>
      r.alive && r.id !== goblin.id &&
      Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) <= 5 &&
      (goblin.relations[r.id] ?? 50) < 30,
    );
  },
  score: () => 0.3,
  execute: ({ goblin, goblins, grid }) => {
    if (!goblins) return;
    const rival = goblins
      .filter(r => r.alive && r.id !== goblin.id)
      .map(r => ({ r, dist: Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) }))
      .filter(e => e.dist <= 5 && (goblin.relations[e.r.id] ?? 50) < 30)
      .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;
    if (!rival) return;
    const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const avoidOpen = avoidDirs
      .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
      .filter(p => isWalkable(grid, p.x, p.y));
    if (avoidOpen.length > 0) {
      const next = avoidOpen.reduce((best, p) =>
        (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
        (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
      );
      goblin.x = next.x; goblin.y = next.y;
      goblin.task = `avoiding ${rival.name}`;
    }
  },
};

// --- wander: default fallback exploration ---
const wander: Action = {
  name: 'wander',
  eligible: () => true,
  score: () => 0.05,
  execute: ({ goblin, grid, currentTick, onLog }) => {
    const WANDER_HOLD_TICKS = 25;
    const WANDER_MIN_DIST   = 10;
    const WANDER_MAX_DIST   = 20;

    // Invalidate wander target if blocked
    if (goblin.wanderTarget && !isWalkable(grid, goblin.wanderTarget.x, goblin.wanderTarget.y)) {
      goblin.wanderTarget = null;
    }

    // Scout XP — grant on reaching wander target
    if (goblin.wanderTarget && goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y) {
      if (goblin.role === 'scout') grantXp(goblin, currentTick, onLog);
    }

    if (!goblin.wanderTarget || currentTick >= goblin.wanderExpiry
        || (goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y)) {
      let picked = false;

      // Home drift
      const homeDrift = traitMod(goblin, 'wanderHomeDrift', 0.25);
      if (Math.random() < homeDrift && (goblin.homeTile.x !== 0 || goblin.homeTile.y !== 0)) {
        const hx = goblin.homeTile.x + Math.round((Math.random() - 0.5) * 20);
        const hy = goblin.homeTile.y + Math.round((Math.random() - 0.5) * 20);
        if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid, hx, hy)) {
          goblin.wanderTarget = { x: hx, y: hy };
          goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
          picked = true;
        }
      }

      if (!picked) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const angle = Math.random() * Math.PI * 2;
          const dist  = WANDER_MIN_DIST + Math.random() * (WANDER_MAX_DIST - WANDER_MIN_DIST);
          const wx    = Math.round(goblin.x + Math.cos(angle) * dist);
          const wy    = Math.round(goblin.y + Math.sin(angle) * dist);
          if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid, wx, wy)) {
            goblin.wanderTarget = { x: wx, y: wy };
            goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
            picked = true;
            break;
          }
        }
      }

      if (!picked) {
        // Constrained — random adjacent step
        const fallDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
        const fallOpen = fallDirs
          .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
          .filter(p => isWalkable(grid, p.x, p.y));
        if (fallOpen.length > 0) {
          const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
          goblin.x = fb.x; goblin.y = fb.y;
        }
        goblin.task = 'wandering';
        return;
      }
    }

    moveTo(goblin, goblin.wanderTarget!, grid);
    goblin.task = 'exploring';
  },
};

// --- seekWarmth: comfort preference — pathfinds to nearest hearth, stops once warm ---
const SEEK_WARMTH_RADIUS    = 15;
// Longer cooldown: prevents re-triggering immediately after being satisfied
const SEEK_WARMTH_COOLDOWN  = 150;
const seekWarmth: Action = {
  name: 'seekWarmth',
  intentMatch: 'rest',
  eligible: ({ goblin, warmthField, grid, currentTick }) => {
    if (!warmthField) return false;
    // Use smoothed goblin.warmth to avoid single-step threshold crossings.
    // Hysteresis: if already en route (task from last tick), stay committed until comfortably warm (50);
    // otherwise only start when actually cold (< 25).
    const warmth = goblin.warmth ?? 100;
    const exitThreshold = goblin.task === 'seeking warmth' ? 50 : 25;
    if (warmth >= exitThreshold) return false;
    // Cooldown: prevents re-triggering immediately after being warm
    if (currentTick - (goblin.lastLoggedTicks['seekWarmthDone'] ?? 0) < SEEK_WARMTH_COOLDOWN) return false;
    // Eligible if a hearth is visible in range OR remembered from a previous visit
    for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
      for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE
            && grid[ny][nx].type === TileType.Hearth) return true;
      }
    }
    return (goblin.knownHearthSites ?? []).length > 0;
  },
  score: ({ goblin, warmthField, weatherType }) => {
    if (!warmthField) return 0;
    const warmth = goblin.warmth ?? 100;
    const maxScore = weatherType === 'cold' ? 0.28 : 0.08;
    return inverseSigmoid(warmth, 20, 0.12) * maxScore;
  },
  execute: ({ goblin, grid, currentTick }) => {
    // Scan visible range: record any spotted hearths, find nearest
    let nearestHearth: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
      for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (grid[ny][nx].type !== TileType.Hearth) continue;
        recordSite(goblin.knownHearthSites ?? (goblin.knownHearthSites = []), nx, ny, 1, currentTick);
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < nearestDist) { nearestDist = dist; nearestHearth = { x: nx, y: ny }; }
      }
    }

    // Nothing in range — fall back to memory (navigate toward remembered hearth)
    if (!nearestHearth) {
      const sites = goblin.knownHearthSites ?? [];
      // Pick closest remembered hearth; evict if it's no longer there
      const sorted = [...sites].sort((a, b) =>
        (Math.abs(a.x - goblin.x) + Math.abs(a.y - goblin.y)) -
        (Math.abs(b.x - goblin.x) + Math.abs(b.y - goblin.y)),
      );
      for (const site of sorted) {
        if (grid[site.y]?.[site.x]?.type === TileType.Hearth) {
          nearestHearth = { x: site.x, y: site.y };
          nearestDist   = Math.abs(site.x - goblin.x) + Math.abs(site.y - goblin.y);
          break;
        }
        // Hearth is gone — evict
        goblin.knownHearthSites = sites.filter(s => !(s.x === site.x && s.y === site.y));
      }
    }

    if (!nearestHearth) return;  // no hearth known — skip silently

    // Satisfied: close to hearth or smoothed warmth has risen enough — start cooldown
    const warmth = goblin.warmth ?? 0;
    if (nearestDist <= 2 || warmth >= 40) {
      goblin.lastLoggedTicks['seekWarmthDone'] = currentTick;
      return;
    }

    // Pathfind directly to the hearth (handles doorways and walls correctly)
    moveTo(goblin, nearestHearth, grid);
    goblin.task = 'seeking warmth';
  },
};

// --- seekSafety: flee to lowest-danger tile when threatened ---
const seekSafety: Action = {
  name: 'seekSafety',
  intentMatch: 'avoid',
  eligible: ({ goblin, dangerField }) => {
    if (!dangerField) return false;
    return getDanger(dangerField, goblin.x, goblin.y) > 60;
  },
  score: ({ goblin, dangerField }) => {
    if (!dangerField) return 0;
    return sigmoid(getDanger(dangerField, goblin.x, goblin.y), 60, 0.12) * 0.65;
  },
  execute: ({ goblin, grid, dangerField }) => {
    if (!dangerField) return;
    const SCAN = Math.min(5, effectiveVision(goblin));
    let bestDanger = getDanger(dangerField, goblin.x, goblin.y);
    let bestTile: { x: number; y: number } | null = null;

    for (let dy = -SCAN; dy <= SCAN; dy++) {
      for (let dx = -SCAN; dx <= SCAN; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (!isWalkable(grid, nx, ny)) continue;
        const d = getDanger(dangerField, nx, ny);
        if (d < bestDanger) { bestDanger = d; bestTile = { x: nx, y: ny }; }
      }
    }
    if (bestTile) {
      moveTo(goblin, bestTile, grid);
      goblin.task = 'fleeing to safety';
    }
  },
};

// --- buildHearth: any goblin builds a hearth from 2 wood when they're cold ---
// "Near base" clustering emerges naturally: goblins spend most time near home,
// so the first fire gets built there. Once it warms that area, nearby goblins
// stay warm and won't build another. Only goblins cold in a different location build elsewhere.
const HEARTH_COVERAGE_RADIUS = 8;  // matches warmth BFS radius — if a hearth covers you, don't build
const HEARTH_BUILD_COOLDOWN  = 300; // personal cooldown after placing, prevents back-to-back builds
const buildHearth: Action = {
  name: 'buildHearth',
  eligible: ({ goblin, woodStockpiles, foodStockpiles, grid, currentTick }) => {
    if (goblin.hunger >= 70) return false;
    const totalFood = foodStockpiles?.reduce((s, f) => s + f.food, 0) ?? 0;
    if (totalFood < 20) return false;
    const totalWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    if (totalWood < 2) return false;
    // Goblin must actually feel cold (uses smoothed warmth — single steps don't flip this)
    if ((goblin.warmth ?? 100) >= 35) return false;
    // Personal cooldown — prevents a goblin from placing one then immediately starting another
    if (currentTick - (goblin.lastLoggedTicks['builtHearth'] ?? 0) < HEARTH_BUILD_COOLDOWN) return false;
    // A hearth already within coverage radius means this area is served — building would be wasteful
    for (let dy = -HEARTH_COVERAGE_RADIUS; dy <= HEARTH_COVERAGE_RADIUS; dy++) {
      for (let dx = -HEARTH_COVERAGE_RADIUS; dx <= HEARTH_COVERAGE_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE
            && grid[ny][nx].type === TileType.Hearth) return false;
      }
    }
    return true;
  },
  score: ({ goblin, woodStockpiles }) => {
    const totalWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    const warmth    = goblin.warmth ?? 100;
    const base      = inverseSigmoid(warmth, 25, 0.12)
                    * ramp(totalWood, 2, 20)
                    * inverseSigmoid(goblin.hunger, 60)
                    * 0.5;
    // Momentum: already en route → commit, but only while base conditions still hold
    const momentum  = (goblin.task === '→ hearth site' && base > 0) ? 0.15 : 0;
    return base + momentum;
  },
  execute: ({ goblin, grid, woodStockpiles, currentTick, onLog }) => {
    if (!woodStockpiles) return;

    // Find nearest wood stockpile with surplus
    const buildStockpile = woodStockpiles
      .filter(s => s.wood >= 2)
      .reduce<typeof woodStockpiles[0] | null>((best, s) => {
        const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
        const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
        return dist < bestDist ? s : best;
      }, null);
    if (!buildStockpile) return;

    // Find best buildable Dirt/Grass tile near goblin's current position.
    // Soft home bias: score = distToGoblin + 0.2 × distToHome, so tiles toward home are preferred
    // without being forced. When the goblin is already near home, fires cluster there naturally.
    let buildTarget: { x: number; y: number } | null = null;
    let bestScore = Infinity;
    const RADIUS = 5;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        const t = grid[ny][nx];
        if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
        const distToGoblin = Math.abs(dx) + Math.abs(dy);
        const distToHome   = Math.abs(nx - goblin.homeTile.x) + Math.abs(ny - goblin.homeTile.y);
        const siteScore    = distToGoblin + 0.2 * distToHome;
        if (siteScore < bestScore) { bestScore = siteScore; buildTarget = { x: nx, y: ny }; }
      }
    }
    if (!buildTarget) return;

    // Move toward build site
    if (goblin.x !== buildTarget.x || goblin.y !== buildTarget.y) {
      moveTo(goblin, buildTarget, grid);
      goblin.task = '→ hearth site';
      return;
    }

    // Place the hearth
    const t = grid[buildTarget.y][buildTarget.x];
    grid[buildTarget.y][buildTarget.x] = {
      ...t, type: TileType.Hearth,
      foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0,
    };
    buildStockpile.wood -= 2;
    addWorkFatigue(goblin);
    goblin.lastLoggedTicks['builtHearth'] = currentTick;
    recordSite(goblin.knownHearthSites ?? (goblin.knownHearthSites = []), buildTarget.x, buildTarget.y, 1, currentTick);
    goblin.task = 'built a hearth!';
    if (shouldLog(goblin, 'buildHearth', currentTick, 300)) {
      onLog?.('🔥 built a hearth for warmth', 'info');
    }
  },
};

// ── Export all actions ──────────────────────────────────────────────────────────

export const ALL_ACTIONS: Action[] = [
  commandMove,
  eat,
  seekSafety,   // danger-driven flee — high urgency, runs before rest/work
  rest,
  share,
  fight,
  buildHearth,
  forage,
  depositFood,
  withdrawFood,
  mine,
  chop,
  depositOre,
  depositWood,
  buildWall,
  socialize,
  seekWarmth,   // comfort nudge — low score, loses to most work actions
  avoidRival,
  wander,
];
