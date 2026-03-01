/**
 * Utility AI action definitions.
 *
 * Each action has:
 *   eligible(ctx) — can this action run right now?
 *   score(ctx)    — 0–1 desirability
 *   execute(ctx)  — mutate dwarf state (movement, harvesting, etc.)
 *   intentMatch   — LLM intent that boosts this action's score by +0.5
 *
 * Actions are evaluated in order but the highest score wins — order only
 * matters as a tiebreaker for equal scores.
 */

import { TileType, type Dwarf, type Tile, type LLMIntent, type DwarfTrait, type Goblin, type FoodStockpile, type OreStockpile, type WoodStockpile, type ColonyGoal, type ResourceSite } from '../shared/types';
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

const TRAIT_FLAVOR: Record<DwarfTrait, Record<string, string>> = {
  lazy:      { eat: 'scarfed down food',    rest: 'collapsed for a nap',        share: 'grudgingly shared' },
  helpful:   { eat: 'ate quickly',          rest: 'rested briefly',             share: 'happily shared' },
  greedy:    { eat: 'ate greedily',         rest: 'rested',                     share: 'reluctantly shared' },
  brave:     { eat: 'ate',                  rest: 'caught breath',              share: 'shared' },
  cheerful:  { eat: 'ate cheerfully',       rest: 'rested with a smile',        share: 'gladly shared' },
  mean:      { eat: 'ate alone',            rest: 'rested',                     share: 'begrudgingly shared' },
  paranoid:  { eat: 'ate nervously',        rest: 'rested with one eye open',   share: 'cautiously shared' },
  forgetful: { eat: 'ate',                  rest: 'dozed off',                  share: 'shared' },
};

function traitText(dwarf: Dwarf, action: string): string {
  return TRAIT_FLAVOR[dwarf.trait]?.[action] ?? action;
}

/** Cooldown-gated log: returns true (and records the tick) at most once per `cooldown` ticks. */
function shouldLog(dwarf: Dwarf, key: string, tick: number, cooldown: number): boolean {
  if (tick - (dwarf.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  dwarf.lastLoggedTicks[key] = tick;
  return true;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export interface ActionContext {
  dwarf:           Dwarf;
  grid:            Tile[][];
  currentTick:     number;
  dwarves?:        Dwarf[];
  onLog?:          LogFn;
  foodStockpiles?: FoodStockpile[];
  goblins?:        Goblin[];
  oreStockpiles?:  OreStockpile[];
  woodStockpiles?: WoodStockpile[];
  colonyGoal?:     ColonyGoal;
}

export interface Action {
  name:         string;
  intentMatch?: LLMIntent;  // which LLM intent boosts this action
  eligible:     (ctx: ActionContext) => boolean;
  score:        (ctx: ActionContext) => number;
  execute:      (ctx: ActionContext) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fatigueRate(dwarf: Dwarf): number {
  return traitMod(dwarf, 'fatigueRate', 1.0);
}

function moveTo(dwarf: Dwarf, target: { x: number; y: number }, grid: Tile[][]): void {
  // Leg wound: 40% chance to skip this tick's movement (limp)
  if (isLegWoundSkip(dwarf)) return;
  const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, target, grid);
  dwarf.x = next.x;
  dwarf.y = next.y;
  dwarf.fatigue = Math.min(100, dwarf.fatigue + 0.2 * fatigueRate(dwarf));
}

function addWorkFatigue(dwarf: Dwarf): void {
  dwarf.fatigue = Math.min(100, dwarf.fatigue + 0.4 * fatigueRate(dwarf));
}

/** Find nearest food stockpile matching a filter. */
function nearestFoodStockpile(
  dwarf: Dwarf, stockpiles: FoodStockpile[] | undefined, filter: (s: FoodStockpile) => boolean,
): FoodStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<FoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - dwarf.x) + Math.abs(s.y - dwarf.y);
      const bestDist = best ? Math.abs(best.x - dwarf.x) + Math.abs(best.y - dwarf.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

function nearestOreStockpile(
  dwarf: Dwarf, stockpiles: OreStockpile[] | undefined, filter: (s: OreStockpile) => boolean,
): OreStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<OreStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - dwarf.x) + Math.abs(s.y - dwarf.y);
      const bestDist = best ? Math.abs(best.x - dwarf.x) + Math.abs(best.y - dwarf.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

function nearestWoodStockpile(
  dwarf: Dwarf, stockpiles: WoodStockpile[] | undefined, filter: (s: WoodStockpile) => boolean,
): WoodStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<WoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - dwarf.x) + Math.abs(s.y - dwarf.y);
      const bestDist = best ? Math.abs(best.x - dwarf.x) + Math.abs(best.y - dwarf.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

// ── Action definitions ─────────────────────────────────────────────────────────

// --- commandMove: player override (always wins) ---
const commandMove: Action = {
  name: 'commandMove',
  eligible: ({ dwarf }) => dwarf.commandTarget !== null,
  score: () => 1.0,
  execute: ({ dwarf, grid, onLog }) => {
    const { x: tx, y: ty } = dwarf.commandTarget!;
    if (dwarf.x === tx && dwarf.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      dwarf.commandTarget = null;
      dwarf.task          = 'arrived';
    } else {
      moveTo(dwarf, dwarf.commandTarget!, grid);
      dwarf.task = `→ (${tx},${ty})`;
    }
  },
};

// --- eat: consume food from inventory ---
const eat: Action = {
  name: 'eat',
  intentMatch: 'eat',
  eligible: ({ dwarf }) => dwarf.inventory.food > 0 && dwarf.hunger > 20,
  score: ({ dwarf }) => {
    const mid = traitMod(dwarf, 'eatThreshold', 70);
    return sigmoid(dwarf.hunger, mid);
  },
  execute: ({ dwarf, currentTick, onLog }) => {
    const wasDesperatelyHungry = dwarf.hunger > 80;
    const bite = Math.min(dwarf.inventory.food, 3);
    dwarf.inventory.food -= bite;
    dwarf.hunger = Math.max(0, dwarf.hunger - bite * 20);
    dwarf.task = 'eating';
    // Only log desperate eating — routine meals are too noisy
    if (wasDesperatelyHungry && shouldLog(dwarf, 'eat', currentTick, 200)) {
      onLog?.(`🍖 ${traitText(dwarf, 'eat')} — was starving`, 'warn');
    }
  },
};

// --- rest: stay still, recover fatigue ---
const rest: Action = {
  name: 'rest',
  intentMatch: 'rest',
  eligible: ({ dwarf }) => dwarf.fatigue > 20,
  score: ({ dwarf }) => sigmoid(dwarf.fatigue, 60),
  execute: ({ dwarf }) => {
    dwarf.fatigue = Math.max(0, dwarf.fatigue - 1.5);
    // Resting accelerates wound healing (~3× faster)
    accelerateHealing(dwarf, 2);
    dwarf.task = dwarf.wound ? `resting (healing ${dwarf.wound.type})` : 'resting';
    // Rest is routine — no log entry (too noisy)
  },
};

// --- share: gift food to a hungry neighbor ---
const share: Action = {
  name: 'share',
  eligible: ({ dwarf, dwarves }) => {
    if (!dwarves) return false;
    const shareThresh = traitMod(dwarf, 'shareThreshold', 8);
    if (dwarf.inventory.food < shareThresh) return false;
    const relGate = traitMod(dwarf, 'shareRelationGate', 30);
    return dwarves.some(d =>
      d.alive && d.id !== dwarf.id &&
      Math.abs(d.x - dwarf.x) <= 2 && Math.abs(d.y - dwarf.y) <= 2 &&
      d.hunger > 60 && d.inventory.food < 3 &&
      (dwarf.relations[d.id] ?? 50) >= relGate,
    );
  },
  score: ({ dwarf, dwarves }) => {
    if (!dwarves) return 0;
    const relGate = traitMod(dwarf, 'shareRelationGate', 30);
    const target = dwarves
      .filter(d =>
        d.alive && d.id !== dwarf.id &&
        Math.abs(d.x - dwarf.x) <= 2 && Math.abs(d.y - dwarf.y) <= 2 &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (dwarf.relations[d.id] ?? 50) >= relGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return 0;
    // Higher score when target is hungrier and we have more surplus
    return sigmoid(target.hunger, 70) * ramp(dwarf.inventory.food, 6, 15) * 0.7;
  },
  execute: ({ dwarf, dwarves, currentTick, onLog }) => {
    if (!dwarves) return;
    const relGate = traitMod(dwarf, 'shareRelationGate', 30);
    const donorKeeps = traitMod(dwarf, 'shareDonorKeeps', 5);
    const target = dwarves
      .filter(d =>
        d.alive && d.id !== dwarf.id &&
        Math.abs(d.x - dwarf.x) <= 2 && Math.abs(d.y - dwarf.y) <= 2 &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (dwarf.relations[d.id] ?? 50) >= relGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return;
    const give = Math.min(3, dwarf.inventory.food - donorKeeps);
    if (give <= 0) return;
    const headroom = MAX_INVENTORY_FOOD - target.inventory.food;
    const actual   = Math.min(give, headroom);
    if (actual <= 0) return;
    dwarf.inventory.food  -= actual;
    target.inventory.food += actual;
    const prevRel = dwarf.relations[target.id] ?? 50;
    dwarf.relations[target.id]  = Math.min(100, prevRel + 5);
    target.relations[dwarf.id]  = Math.min(100, (target.relations[dwarf.id] ?? 50) + 3);
    dwarf.task = `shared ${actual.toFixed(0)} food → ${target.name}`;
    onLog?.(`🤝 ${traitText(dwarf, 'share')} ${actual.toFixed(0)} food with ${target.name}`, 'info');
    // Friendship milestone — relation crossed 70
    if (prevRel < 70 && dwarf.relations[target.id] >= 70 && shouldLog(dwarf, `friend_${target.id}`, currentTick, 300)) {
      onLog?.(`💛 became friends with ${target.name}`, 'info');
    }
  },
};

// --- fight: fighters hunt nearby goblins ---
const fight: Action = {
  name: 'fight',
  intentMatch: null,
  eligible: ({ dwarf, goblins }) => {
    if (dwarf.role !== 'fighter' || !goblins || goblins.length === 0) return false;
    const fleeAt = traitMod(dwarf, 'fleeThreshold', 80);
    return dwarf.hunger < fleeAt;
  },
  score: ({ dwarf, goblins }) => {
    if (!goblins || goblins.length === 0) return 0;
    const HUNT_RADIUS = effectiveVision(dwarf) * 2;
    const nearest = goblins.reduce<{ dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - dwarf.x) + Math.abs(g.y - dwarf.y);
      return (!best || dist < best.dist) ? { dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return 0;
    // Closer goblins score higher; less hungry = more willing to fight
    return inverseSigmoid(nearest.dist, HUNT_RADIUS * 0.5, 0.2) * inverseSigmoid(dwarf.hunger, 60);
  },
  execute: ({ dwarf, goblins, grid, currentTick, onLog }) => {
    if (!goblins) return;
    const HUNT_RADIUS = effectiveVision(dwarf) * 2;
    const nearest = goblins.reduce<{ g: Goblin; dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - dwarf.x) + Math.abs(g.y - dwarf.y);
      return (!best || dist < best.dist) ? { g, dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return;
    if (nearest.dist > 0) {
      // Sprint — two steps toward goblin (leg wound may skip each step)
      if (!isLegWoundSkip(dwarf)) {
        const step1 = pathNextStep({ x: dwarf.x, y: dwarf.y }, { x: nearest.g.x, y: nearest.g.y }, grid);
        dwarf.x = step1.x; dwarf.y = step1.y;
      }
      if (!isLegWoundSkip(dwarf)) {
        const step2 = pathNextStep({ x: dwarf.x, y: dwarf.y }, { x: nearest.g.x, y: nearest.g.y }, grid);
        dwarf.x = step2.x; dwarf.y = step2.y;
      }
    }
    dwarf.fatigue = Math.min(100, dwarf.fatigue + 0.4 * fatigueRate(dwarf));
    const distAfter = Math.abs(nearest.g.x - dwarf.x) + Math.abs(nearest.g.y - dwarf.y);
    dwarf.task = distAfter === 0 ? 'fighting goblin!' : `→ goblin (${distAfter} tiles)`;
    // Fighter XP — grant on engaging in combat
    if (distAfter === 0) grantXp(dwarf, currentTick, onLog);
  },
};

// --- forage: scan for food, pathfind, harvest ---
const forage: Action = {
  name: 'forage',
  intentMatch: 'forage',
  eligible: ({ dwarf }) => {
    const inventoryFull = dwarf.inventory.food >= MAX_INVENTORY_FOOD;
    if (inventoryFull) return false;
    // Miners/lumberjacks skip food when not hungry
    if ((dwarf.role === 'miner' || dwarf.role === 'lumberjack') && dwarf.hunger < 50) return false;
    return true;
  },
  score: ({ dwarf, grid }) => {
    const vision = effectiveVision(dwarf);
    const radius = dwarf.hunger > 65 ? Math.min(vision * 2, 15) : vision;
    const target = bestFoodTile(dwarf, grid, radius);
    if (!target) {
      // Check remembered food sites
      if (dwarf.knownFoodSites.length > 0) return sigmoid(dwarf.hunger, 40) * 0.4;
      return 0;
    }
    return sigmoid(dwarf.hunger, 40) * 0.8;
  },
  execute: (ctx) => {
    const { dwarf, grid, currentTick, dwarves, onLog } = ctx;
    const vision = effectiveVision(dwarf);
    const radius = dwarf.llmIntent === 'forage' ? 15
      : dwarf.hunger > 65 ? Math.min(vision * 2, 15)
      : vision;
    const foodTarget = bestFoodTile(dwarf, grid, radius);

    // Record visible food sites in memory
    if (foodTarget) {
      const tv = grid[foodTarget.y][foodTarget.x].foodValue;
      if (tv >= SITE_RECORD_THRESHOLD) {
        recordSite(dwarf.knownFoodSites, foodTarget.x, foodTarget.y, tv, currentTick);
      }
    }

    if (foodTarget) {
      if (dwarf.x !== foodTarget.x || dwarf.y !== foodTarget.y) {
        moveTo(dwarf, foodTarget, grid);
      }
      const here = grid[dwarf.y][dwarf.x];

      // Contest yield — if a hungrier dwarf is on the same tile, yield
      if (dwarves) {
        const rival = dwarves.find(d =>
          d.alive && d.id !== dwarf.id &&
          d.x === dwarf.x && d.y === dwarf.y &&
          d.hunger > dwarf.hunger,
        );
        if (rival) {
          const relation = dwarf.relations[rival.id] ?? 50;
          if (relation >= 60) {
            dwarf.relations[rival.id] = Math.min(100, relation + 2);
            dwarf.task = `sharing tile with ${rival.name}`;
            return;
          }
          const penalty = traitMod(dwarf, 'contestPenalty', -5);
          const newRel = Math.max(0, relation + penalty);
          dwarf.relations[rival.id] = newRel;
          // Rivalry milestone — relation dropped below 20
          if (relation >= 20 && newRel < 20 && shouldLog(dwarf, `rival_${rival.id}`, currentTick, 300)) {
            onLog?.(`💢 growing rivalry with ${rival.name}`, 'warn');
          }
          const escapeDirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
          const escapeOpen = escapeDirs
            .map(d => ({ x: dwarf.x + d.dx, y: dwarf.y + d.dy }))
            .filter(p => isWalkable(grid, p.x, p.y));
          if (escapeOpen.length > 0) {
            const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
            dwarf.x = step.x; dwarf.y = step.y;
          }
          dwarf.task = `yielding to ${rival.name}`;
          return;
        }
      }

      // Harvest
      const headroom = MAX_INVENTORY_FOOD - dwarf.inventory.food;
      if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
        const depletionRate = dwarf.role === 'forager' ? 6 : 5;
        const baseYield     = (dwarf.role === 'forager' ? 2 : 1) + skillYieldBonus(dwarf);
        const moraleScale   = 0.5 + (dwarf.morale / 100) * 0.5;
        const fatigueScale  = dwarf.fatigue > 70 ? 0.5 : 1.0;
        const woundScale    = woundYieldMultiplier(dwarf);
        const harvestYield  = Math.max(1, Math.round(baseYield * moraleScale * fatigueScale * woundScale));
        const hadFood       = here.foodValue;
        const depleted      = Math.min(hadFood, depletionRate);
        here.foodValue      = Math.max(0, hadFood - depleted);
        if (here.foodValue === 0) { here.type = TileType.Dirt; here.maxFood = 0; }
        const amount         = Math.min(harvestYield, depleted, headroom);
        dwarf.inventory.food += amount;
        addWorkFatigue(dwarf);
        // Forager XP — grant on successful harvest
        if (dwarf.role === 'forager') grantXp(dwarf, currentTick, onLog);
        dwarf.task = `harvesting (food: ${dwarf.inventory.food.toFixed(0)})`;
      } else {
        dwarf.task = `foraging → (${foodTarget.x},${foodTarget.y})`;
      }
      return;
    }

    // No food visible — try remembered food site
    if (dwarf.knownFoodSites.length > 0) {
      const best = dwarf.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
      if (dwarf.x === best.x && dwarf.y === best.y) {
        // Arrived — check if still harvestable
        const tileHere  = grid[dwarf.y][dwarf.x];
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
            dwarf.knownFoodSites = dwarf.knownFoodSites.map(
              s => (s.x === best.x && s.y === best.y) ? better! : s,
            );
          } else {
            dwarf.knownFoodSites = dwarf.knownFoodSites.filter(
              s => !(s.x === best.x && s.y === best.y),
            );
          }
        } else {
          recordSite(dwarf.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
        }
        // Fall through to let next tick harvest
      } else {
        moveTo(dwarf, best, grid);
        dwarf.task = '→ remembered patch';
      }
    }
  },
};

// --- depositFood: carry surplus food to stockpile ---
const depositFood: Action = {
  name: 'depositFood',
  eligible: ({ dwarf, foodStockpiles }) => {
    if (dwarf.inventory.food < 10 || dwarf.hunger >= 55) return false;
    const target = nearestFoodStockpile(dwarf, foodStockpiles, s => s.food < s.maxFood);
    return target !== null && !(dwarf.x === target.x && dwarf.y === target.y);
  },
  score: ({ dwarf }) => ramp(dwarf.inventory.food, 8, 20) * inverseSigmoid(dwarf.hunger, 50) * 0.6,
  execute: ({ dwarf, grid, foodStockpiles }) => {
    const target = nearestFoodStockpile(dwarf, foodStockpiles, s => s.food < s.maxFood);
    if (!target) return;
    moveTo(dwarf, target, grid);
    dwarf.task = '→ home (deposit)';
  },
};

// --- withdrawFood: run to stockpile when hungry and empty ---
const withdrawFood: Action = {
  name: 'withdrawFood',
  eligible: ({ dwarf, foodStockpiles }) => {
    if (dwarf.hunger <= 65 || dwarf.inventory.food > 0) return false;
    const target = nearestFoodStockpile(dwarf, foodStockpiles, s => s.food > 0);
    return target !== null && !(dwarf.x === target.x && dwarf.y === target.y);
  },
  score: ({ dwarf }) => sigmoid(dwarf.hunger, 65) * 0.55,
  execute: ({ dwarf, grid, foodStockpiles }) => {
    const target = nearestFoodStockpile(dwarf, foodStockpiles, s => s.food > 0);
    if (!target) return;
    moveTo(dwarf, target, grid);
    dwarf.task = `→ stockpile (${target.food.toFixed(0)} food)`;
  },
};

// --- mine: miners target ore tiles ---
const mine: Action = {
  name: 'mine',
  eligible: ({ dwarf }) => dwarf.role === 'miner',
  score: ({ dwarf, grid }) => {
    const target = bestMaterialTile(dwarf, grid, effectiveVision(dwarf));
    if (!target) {
      // Check remembered ore sites
      if (dwarf.knownOreSites.length > 0) return inverseSigmoid(dwarf.hunger, 60) * 0.35;
      return 0;
    }
    return inverseSigmoid(dwarf.hunger, 60) * 0.6;
  },
  execute: (ctx) => {
    const { dwarf, grid, currentTick, onLog } = ctx;
    const oreTarget = bestMaterialTile(dwarf, grid, effectiveVision(dwarf));

    // Record visible ore sites
    if (oreTarget) {
      const mv = grid[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(dwarf.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }

    if (oreTarget) {
      if (dwarf.x !== oreTarget.x || dwarf.y !== oreTarget.y) {
        moveTo(dwarf, oreTarget, grid);
      }
      const here = grid[dwarf.y][dwarf.x];
      if (here.materialValue >= 1) {
        const hadMat       = here.materialValue;
        const baseOre      = 2 + skillOreBonus(dwarf);
        const oreYield     = Math.max(1, Math.round(baseOre * woundYieldMultiplier(dwarf)));
        const mined        = Math.min(hadMat, oreYield);
        here.materialValue = Math.max(0, hadMat - mined);
        if (here.materialValue === 0) { here.type = TileType.Stone; here.maxMaterial = 0; }
        dwarf.inventory.materials = Math.min(dwarf.inventory.materials + mined, MAX_INVENTORY_FOOD);
        addWorkFatigue(dwarf);
        // Miner XP — grant on successful ore extraction
        grantXp(dwarf, currentTick, onLog);
        dwarf.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
      } else {
        dwarf.task = `mining → (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }

    // No ore visible — try remembered ore site
    if (dwarf.knownOreSites.length > 0) {
      const best = dwarf.knownOreSites.reduce((a, b) => b.value > a.value ? b : a);
      if (dwarf.x === best.x && dwarf.y === best.y) {
        const tileHere = grid[dwarf.y][dwarf.x];
        if (tileHere.materialValue < 1 || tileHere.type === TileType.Forest) {
          dwarf.knownOreSites = dwarf.knownOreSites.filter(s => !(s.x === best.x && s.y === best.y));
        } else {
          recordSite(dwarf.knownOreSites, best.x, best.y, tileHere.materialValue, currentTick);
        }
      } else {
        moveTo(dwarf, best, grid);
        dwarf.task = '→ remembered ore vein';
      }
    }
  },
};

// --- chop: lumberjacks target forest tiles ---
const chop: Action = {
  name: 'chop',
  eligible: ({ dwarf }) => dwarf.role === 'lumberjack',
  score: ({ dwarf, grid }) => {
    const target = bestWoodTile(dwarf, grid, effectiveVision(dwarf));
    if (!target) {
      if (dwarf.knownWoodSites.length > 0) return inverseSigmoid(dwarf.hunger, 60) * 0.35;
      return 0;
    }
    return inverseSigmoid(dwarf.hunger, 60) * 0.6;
  },
  execute: (ctx) => {
    const { dwarf, grid, currentTick, onLog } = ctx;
    const woodTarget = bestWoodTile(dwarf, grid, effectiveVision(dwarf));

    // Record visible wood sites
    if (woodTarget) {
      const mv = grid[woodTarget.y][woodTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(dwarf.knownWoodSites, woodTarget.x, woodTarget.y, mv, currentTick);
      }
    }

    if (woodTarget) {
      if (dwarf.x !== woodTarget.x || dwarf.y !== woodTarget.y) {
        moveTo(dwarf, woodTarget, grid);
      }
      const here = grid[dwarf.y][dwarf.x];
      if (here.type === TileType.Forest && here.materialValue >= 1) {
        const hadWood      = here.materialValue;
        const baseChop     = 2 + skillYieldBonus(dwarf);
        const chopYield    = Math.max(1, Math.round(baseChop * woundYieldMultiplier(dwarf)));
        const chopped      = Math.min(hadWood, chopYield);
        here.materialValue = Math.max(0, hadWood - chopped);
        dwarf.inventory.materials = Math.min(dwarf.inventory.materials + chopped, MAX_INVENTORY_FOOD);
        addWorkFatigue(dwarf);
        // Lumberjack XP — grant on successful wood chop
        grantXp(dwarf, currentTick, onLog);
        dwarf.task = `logging (wood: ${here.materialValue.toFixed(0)})`;
      } else {
        dwarf.task = `→ forest (${woodTarget.x},${woodTarget.y})`;
      }
      return;
    }

    // No wood visible — try remembered wood site
    if (dwarf.knownWoodSites.length > 0) {
      const best = dwarf.knownWoodSites.reduce((a, b) => b.value > a.value ? b : a);
      if (dwarf.x === best.x && dwarf.y === best.y) {
        const tileHere = grid[dwarf.y][dwarf.x];
        if (tileHere.type !== TileType.Forest || tileHere.materialValue < 1) {
          dwarf.knownWoodSites = dwarf.knownWoodSites.filter(s => !(s.x === best.x && s.y === best.y));
        } else {
          recordSite(dwarf.knownWoodSites, best.x, best.y, tileHere.materialValue, currentTick);
        }
      } else {
        moveTo(dwarf, best, grid);
        dwarf.task = '→ remembered forest';
      }
    }
  },
};

// --- depositOre: miners carry ore to stockpile ---
const depositOre: Action = {
  name: 'depositOre',
  eligible: ({ dwarf, oreStockpiles }) => {
    if (dwarf.role !== 'miner' || dwarf.inventory.materials < 8) return false;
    const target = nearestOreStockpile(dwarf, oreStockpiles, s => s.ore < s.maxOre);
    return target !== null && !(dwarf.x === target.x && dwarf.y === target.y);
  },
  score: ({ dwarf }) => ramp(dwarf.inventory.materials, 6, 20) * 0.5,
  execute: ({ dwarf, grid, oreStockpiles }) => {
    const target = nearestOreStockpile(dwarf, oreStockpiles, s => s.ore < s.maxOre);
    if (!target) return;
    moveTo(dwarf, target, grid);
    dwarf.task = `→ ore stockpile (${dwarf.inventory.materials.toFixed(0)} ore)`;
  },
};

// --- depositWood: lumberjacks carry wood to stockpile ---
const depositWood: Action = {
  name: 'depositWood',
  eligible: ({ dwarf, woodStockpiles }) => {
    if (dwarf.role !== 'lumberjack' || dwarf.inventory.materials < 8) return false;
    const target = nearestWoodStockpile(dwarf, woodStockpiles, s => s.wood < s.maxWood);
    return target !== null && !(dwarf.x === target.x && dwarf.y === target.y);
  },
  score: ({ dwarf }) => ramp(dwarf.inventory.materials, 6, 20) * 0.5,
  execute: ({ dwarf, grid, woodStockpiles }) => {
    const target = nearestWoodStockpile(dwarf, woodStockpiles, s => s.wood < s.maxWood);
    if (!target) return;
    moveTo(dwarf, target, grid);
    dwarf.task = `→ wood stockpile (${dwarf.inventory.materials.toFixed(0)} wood)`;
  },
};

// --- buildWall: miners build fort walls ---
const buildWall: Action = {
  name: 'buildWall',
  eligible: ({ dwarf, foodStockpiles, oreStockpiles, goblins }) => {
    if (dwarf.role !== 'miner') return false;
    if (dwarf.hunger >= 65) return false;
    if (!foodStockpiles?.length || !oreStockpiles?.length) return false;
    const buildStockpile = oreStockpiles.find(s => s.ore >= 3);
    return buildStockpile !== null && buildStockpile !== undefined;
  },
  score: ({ dwarf, oreStockpiles }) => {
    const totalOre = oreStockpiles?.reduce((s, o) => s + o.ore, 0) ?? 0;
    return ramp(totalOre, 3, 30) * inverseSigmoid(dwarf.hunger, 50) * 0.45;
  },
  execute: ({ dwarf, grid, foodStockpiles, oreStockpiles, dwarves, goblins }) => {
    if (!foodStockpiles || !oreStockpiles) return;
    const buildStockpile = oreStockpiles.find(s => s.ore >= 3);
    if (!buildStockpile) return;

    let wallSlots = fortWallSlots(foodStockpiles, oreStockpiles, grid, dwarves, dwarf.id, goblins);
    if (wallSlots.length === 0) {
      wallSlots = fortEnclosureSlots(foodStockpiles, oreStockpiles, grid, dwarves, dwarf.id, goblins);
    }

    let nearestSlot: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (const s of wallSlots) {
      const dist = Math.abs(s.x - dwarf.x) + Math.abs(s.y - dwarf.y);
      if (dist > 0 && dist < nearestDist) { nearestDist = dist; nearestSlot = s; }
    }

    if (nearestSlot) {
      const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, nearestSlot, grid);
      if (next.x === nearestSlot.x && next.y === nearestSlot.y) {
        const t = grid[nearestSlot.y][nearestSlot.x];
        grid[nearestSlot.y][nearestSlot.x] = {
          ...t, type: TileType.Wall,
          foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0,
        };
        buildStockpile.ore -= 3;
        addWorkFatigue(dwarf);
        dwarf.task = 'built fort wall!';
      } else {
        dwarf.x = next.x; dwarf.y = next.y;
        dwarf.fatigue = Math.min(100, dwarf.fatigue + 0.2 * fatigueRate(dwarf));
        dwarf.task = '→ fort wall';
      }
    }
  },
};

// --- socialize: seek out a friendly dwarf ---
const socialize: Action = {
  name: 'socialize',
  intentMatch: 'socialize',
  eligible: ({ dwarf }) => dwarf.social > 30,
  score: ({ dwarf }) => sigmoid(dwarf.social, 50) * 0.6,
  execute: ({ dwarf, dwarves, grid }) => {
    if (!dwarves) { dwarf.task = 'lonely'; return; }
    const FRIEND_REL = 40;
    let bestDist = Infinity;
    let bestFriend: Dwarf | null = null;
    for (const other of dwarves) {
      if (other.id === dwarf.id || !other.alive) continue;
      if ((dwarf.relations[other.id] ?? 50) < FRIEND_REL) continue;
      const dist = Math.abs(other.x - dwarf.x) + Math.abs(other.y - dwarf.y);
      if (dist < bestDist) { bestDist = dist; bestFriend = other; }
    }
    if (bestFriend && bestDist > 1) {
      moveTo(dwarf, { x: bestFriend.x, y: bestFriend.y }, grid);
    }
    dwarf.task = 'socializing';
  },
};

// --- avoidRival: flee from nearby threats ---
const avoidRival: Action = {
  name: 'avoidRival',
  intentMatch: 'avoid',
  eligible: ({ dwarf, dwarves }) => {
    if (!dwarves) return false;
    return dwarves.some(r =>
      r.alive && r.id !== dwarf.id &&
      Math.abs(r.x - dwarf.x) + Math.abs(r.y - dwarf.y) <= 5 &&
      (dwarf.relations[r.id] ?? 50) < 30,
    );
  },
  score: () => 0.3,
  execute: ({ dwarf, dwarves, grid }) => {
    if (!dwarves) return;
    const rival = dwarves
      .filter(r => r.alive && r.id !== dwarf.id)
      .map(r => ({ r, dist: Math.abs(r.x - dwarf.x) + Math.abs(r.y - dwarf.y) }))
      .filter(e => e.dist <= 5 && (dwarf.relations[e.r.id] ?? 50) < 30)
      .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;
    if (!rival) return;
    const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const avoidOpen = avoidDirs
      .map(d => ({ x: dwarf.x + d.x, y: dwarf.y + d.y }))
      .filter(p => isWalkable(grid, p.x, p.y));
    if (avoidOpen.length > 0) {
      const next = avoidOpen.reduce((best, p) =>
        (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
        (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
      );
      dwarf.x = next.x; dwarf.y = next.y;
      dwarf.task = `avoiding ${rival.name}`;
    }
  },
};

// --- wander: default fallback exploration ---
const wander: Action = {
  name: 'wander',
  eligible: () => true,
  score: () => 0.05,
  execute: ({ dwarf, grid, currentTick, onLog }) => {
    const WANDER_HOLD_TICKS = 25;
    const WANDER_MIN_DIST   = 10;
    const WANDER_MAX_DIST   = 20;

    // Invalidate wander target if blocked
    if (dwarf.wanderTarget && !isWalkable(grid, dwarf.wanderTarget.x, dwarf.wanderTarget.y)) {
      dwarf.wanderTarget = null;
    }

    // Scout XP — grant on reaching wander target
    if (dwarf.wanderTarget && dwarf.x === dwarf.wanderTarget.x && dwarf.y === dwarf.wanderTarget.y) {
      if (dwarf.role === 'scout') grantXp(dwarf, currentTick, onLog);
    }

    if (!dwarf.wanderTarget || currentTick >= dwarf.wanderExpiry
        || (dwarf.x === dwarf.wanderTarget.x && dwarf.y === dwarf.wanderTarget.y)) {
      let picked = false;

      // Home drift
      const homeDrift = traitMod(dwarf, 'wanderHomeDrift', 0.25);
      if (Math.random() < homeDrift && (dwarf.homeTile.x !== 0 || dwarf.homeTile.y !== 0)) {
        const hx = dwarf.homeTile.x + Math.round((Math.random() - 0.5) * 20);
        const hy = dwarf.homeTile.y + Math.round((Math.random() - 0.5) * 20);
        if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid, hx, hy)) {
          dwarf.wanderTarget = { x: hx, y: hy };
          dwarf.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
          picked = true;
        }
      }

      if (!picked) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const angle = Math.random() * Math.PI * 2;
          const dist  = WANDER_MIN_DIST + Math.random() * (WANDER_MAX_DIST - WANDER_MIN_DIST);
          const wx    = Math.round(dwarf.x + Math.cos(angle) * dist);
          const wy    = Math.round(dwarf.y + Math.sin(angle) * dist);
          if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid, wx, wy)) {
            dwarf.wanderTarget = { x: wx, y: wy };
            dwarf.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
            picked = true;
            break;
          }
        }
      }

      if (!picked) {
        // Constrained — random adjacent step
        const fallDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
        const fallOpen = fallDirs
          .map(d => ({ x: dwarf.x + d.x, y: dwarf.y + d.y }))
          .filter(p => isWalkable(grid, p.x, p.y));
        if (fallOpen.length > 0) {
          const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
          dwarf.x = fb.x; dwarf.y = fb.y;
        }
        dwarf.task = 'wandering';
        return;
      }
    }

    moveTo(dwarf, dwarf.wanderTarget!, grid);
    dwarf.task = 'exploring';
  },
};

// ── Export all actions ──────────────────────────────────────────────────────────

export const ALL_ACTIONS: Action[] = [
  commandMove,
  eat,
  rest,
  share,
  fight,
  forage,
  depositFood,
  withdrawFood,
  mine,
  chop,
  depositOre,
  depositWood,
  buildWall,
  socialize,
  avoidRival,
  wander,
];
