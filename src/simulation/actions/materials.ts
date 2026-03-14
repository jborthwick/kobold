/**
 * mine, chop, depositOre, depositWood. Resource balance modifier scales scores:
 * when materials (ore, wood, bars, planks) outweigh consumables (food, meals),
 * material actions are nerfed and food actions boosted. Miners and lumberjacks
 * target ore/forest tiles via pathfinding, using known sites when in range.
 */
import { TileType } from '../../shared/types';
import { MAX_INVENTORY_CAPACITY } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import {
  bestMaterialTile, bestWoodTile, recordSite, SITE_RECORD_THRESHOLD,
  traitMod,
} from '../agents';
import { grantXp, skillOreBonus, skillChopBonus } from '../skills';
import { effectiveVision, woundYieldMultiplier } from '../wounds';
import { moveTo, moveToward, addWorkFatigue, totalLoad, nearestStockpile } from './helpers';
import { addThought } from '../mood';
import type { Action } from './types';

// --- mine: miners target ore tiles ---
export const mine: Action = {
  name: 'mine',
  tags: ['work'],
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid, resourceBalance, oreStockpiles, rooms }) => {
    if ((goblin.warmth ?? 100) < 15 && !goblin.task.includes('warming')) return 0;

    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, 'maxSearchRadius', 15));
    const target = bestMaterialTile(goblin, grid, radius);
    const { materialPriority = 1, materialsPressure = 0.65 } = resourceBalance ?? {};
    const balanceFactor = 0.5 + 0.5 * materialPriority;
    const hasBlacksmith = rooms?.some(r => r.type === 'blacksmith') ?? false;
    const totalOre = oreStockpiles?.reduce((s, sp) => s + sp.ore, 0) ?? 0;
    const oreScarce = hasBlacksmith && totalOre < 80;

    if (!target) {
      if (goblin.knownOreSites.length > 0) {
        let baseKnown = inverseSigmoid(goblin.hunger, 60) * 0.2 * balanceFactor * materialsPressure;
        if (oreScarce) baseKnown *= 1.25;
        let flooredKnown = baseKnown;
        if (materialsPressure > 0.5 && oreScarce) {
          flooredKnown = Math.max(flooredKnown, 0.35);
        }
        return Math.min(1.0, flooredKnown);
      }
      return 0;
    }
    let base = inverseSigmoid(goblin.hunger, 60) * 0.6 * balanceFactor * materialsPressure;
    if (oreScarce) base *= 1.25;
    let score = Math.min(1.0, base);
    if (materialsPressure > 0.5 && oreScarce) {
      score = Math.max(score, 0.35);
    }
    return score;
  },
  execute: (ctx) => {
    const { goblin, grid, currentTick, onLog } = ctx;
    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, 'maxSearchRadius', 15));
    const oreTarget = bestMaterialTile(goblin, grid, radius);

    // Record visible ore sites
    if (oreTarget) {
      const mv = grid[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }

    if (oreTarget) {
      if (goblin.x === oreTarget.x && goblin.y === oreTarget.y) {
        const here = grid[goblin.y][goblin.x];
        if (here.type === TileType.Ore && here.materialValue >= 1) {
          const hadMat = here.materialValue;
          const baseOre = 2 + skillOreBonus(goblin);
          const oreYield = Math.max(1, Math.round(baseOre * woundYieldMultiplier(goblin)));
          const mined = Math.min(hadMat, oreYield);
          here.materialValue = Math.max(0, hadMat - mined);
          if (here.materialValue === 0) {
            here.type = TileType.Stone;
            here.maxMaterial = 0;
          }
          goblin.inventory.ore += Math.min(mined, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
          addWorkFatigue(goblin);
          grantXp(goblin, 'mine', currentTick, onLog);
          addThought(goblin, 'mined_ore', currentTick);
          goblin.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
        } else {
          // Edge case: target changed type underfoot (e.g. became stone)
          goblin.task = 'mining… looking for vein';
        }
      } else {
        moveToward(goblin, oreTarget, grid, currentTick);
        goblin.task = `mining → (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }

    // No ore visible — try remembered ore site
    if (goblin.knownOreSites.length > 0) {
      const best = goblin.knownOreSites.reduce((a, b) => {
        const distA = Math.abs(a.x - goblin.x) + Math.abs(a.y - goblin.y);
        const distB = Math.abs(b.x - goblin.x) + Math.abs(b.y - goblin.y);
        const scoreA = distA - a.value * 2;
        const scoreB = distB - b.value * 2;
        return scoreA < scoreB ? a : b;
      });
      if (goblin.x === best.x && goblin.y === best.y) {
        // We reached the remembered site but it's not visible in oreTarget?
        // This implies it's no longer Ore or has 0 material. Clear it.
        const tileHere = grid[goblin.y][goblin.x];
        if (tileHere.type !== TileType.Ore || tileHere.materialValue < 1) {
          goblin.knownOreSites = goblin.knownOreSites.filter(s => !(s.x === best.x && s.y === best.y));
          goblin.task = 'searching for ore…';
        } else {
          // Still good, update visibility record and stay here
          recordSite(goblin.knownOreSites, best.x, best.y, tileHere.materialValue, currentTick);
          goblin.task = 'preparing to mine…';
        }
      } else {
        moveToward(goblin, best, grid, currentTick);
        goblin.task = `→ remembered ore (${best.x},${best.y})`;
      }
    }
  },
};

// --- chop: lumberjacks target forest tiles ---
export const chop: Action = {
  name: 'chop',
  tags: ['work'],
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid, resourceBalance, woodStockpiles, rooms, roomBonuses, plankStockpiles }) => {
    if ((goblin.warmth ?? 100) < 15 && !goblin.task.includes('warming')) return 0;

    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, 'maxSearchRadius', 15));
    const target = bestWoodTile(goblin, grid, radius);
    const { materialPriority = 1, materialsPressure = 0.65 } = resourceBalance ?? {};
    const balanceFactor = 0.5 + 0.5 * materialPriority;
    const hasLumberHut = roomBonuses?.hasLumberHut ?? (rooms?.some(r => r.type === 'lumber_hut') ?? false);
    const totalWood = woodStockpiles?.reduce((s, sp) => s + sp.wood, 0) ?? 0;
    const totalPlanks = plankStockpiles?.reduce((s, p) => s + p.planks, 0) ?? 0;
    const woodScarce = hasLumberHut && totalWood < 40;

    if (!target) {
      if (goblin.knownWoodSites.length > 0) {
        let baseKnown = inverseSigmoid(goblin.hunger, 60) * 0.35 * balanceFactor * materialsPressure;
        if (woodScarce) baseKnown *= 1.3;
        let flooredKnown = baseKnown;
        // When materials are scarce, ensure a modest floor so remembered-tree logging competes with other work.
        if (materialsPressure > 0.5 && woodScarce) {
          flooredKnown = Math.max(flooredKnown, 0.4);
        }
        return Math.min(1.0, flooredKnown);
      }
      return 0;
    }
    let base = inverseSigmoid(goblin.hunger, 60) * 0.6 * balanceFactor * materialsPressure;
    if (woodScarce) base *= 1.3;
    let score = Math.min(1.0, base);
    // Stock-the-wood: when stored materials are low, give chop a floor so it can win ties vs. forage.
    if (materialsPressure > 0.5 && woodScarce) {
      score = Math.max(score, 0.4);
    }
    return score;
  },
  execute: (ctx) => {
    const { goblin, grid, currentTick, onLog } = ctx;
    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, 'maxSearchRadius', 15));
    const woodTarget = bestWoodTile(goblin, grid, radius);

    // Record visible wood sites
    if (woodTarget) {
      const mv = grid[woodTarget.y][woodTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownWoodSites, woodTarget.x, woodTarget.y, mv, currentTick);
      }
    }

    if (woodTarget) {
      if (goblin.x === woodTarget.x && goblin.y === woodTarget.y) {
        const here = grid[goblin.y][goblin.x];
        const isWoodSource = here.type === TileType.Forest ||
          (here.type === TileType.TreeStump && here.materialValue >= 1);
        if (isWoodSource && here.materialValue >= 1) {
          const hadWood = here.materialValue;
          const baseChop = 5 + traitMod(goblin, 'chopPower', 0) + skillChopBonus(goblin);
          const chopYield = Math.max(1, Math.round(baseChop * woundYieldMultiplier(goblin)));
          const chopped = Math.min(hadWood, chopYield);
          here.materialValue = Math.max(0, hadWood - chopped);
          if (here.type === TileType.Forest && here.materialValue === 0) {
            // Forest becomes stump when fully harvested — stumps have small wood yield
            here.type = TileType.TreeStump;
            here.maxMaterial = 4;  // Stump provides a little wood
            here.materialValue = 4;
            here.growbackRate = 0;
            goblin.task = `logging (felled tree)`;
          } else if (here.type === TileType.TreeStump && here.materialValue === 0) {
            // Stump becomes dirt when fully harvested
            here.type = TileType.Dirt;
            here.maxMaterial = 0;
            here.growbackRate = 0;
            goblin.task = `cleared stump`;
          } else {
            goblin.task = `logging (wood: ${here.materialValue.toFixed(0)})`;
          }
          goblin.inventory.wood += Math.min(chopped, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
          addWorkFatigue(goblin);
          grantXp(goblin, 'chop', currentTick, onLog);
        } else {
          goblin.task = 'logging… looking for tree';
        }
      } else {
        moveToward(goblin, woodTarget, grid, currentTick);
        goblin.task = `logging → (${woodTarget.x},${woodTarget.y})`;
      }
      return;
    }

    // No wood visible — try remembered wood site
    if (goblin.knownWoodSites.length > 0) {
      const best = goblin.knownWoodSites.reduce((a, b) => {
        const distA = Math.abs(a.x - goblin.x) + Math.abs(a.y - goblin.y);
        const distB = Math.abs(b.x - goblin.x) + Math.abs(b.y - goblin.y);
        const scoreA = distA - a.value * 2;
        const scoreB = distB - b.value * 2;
        return scoreA < scoreB ? a : b;
      });
      if (goblin.x === best.x && goblin.y === best.y) {
        const tileHere = grid[goblin.y][goblin.x];
        const hasWood = (tileHere.type === TileType.Forest || tileHere.type === TileType.TreeStump) && tileHere.materialValue >= 1;
        if (!hasWood) {
          goblin.knownWoodSites = goblin.knownWoodSites.filter(s => !(s.x === best.x && s.y === best.y));
          goblin.task = 'searching for forest…';
        } else {
          recordSite(goblin.knownWoodSites, best.x, best.y, tileHere.materialValue, currentTick);
          goblin.task = 'preparing to log…';
        }
      } else {
        moveToward(goblin, best, grid, currentTick);
        goblin.task = `→ remembered forest (${best.x},${best.y})`;
      }
    }
  },
};

// --- depositOre: miners carry ore to stockpile ---
// Score grows with ore carried; tuned so deposit competes with mine when carrying a reasonable load.
export const depositOre: Action = {
  name: 'depositOre',
  tags: ['work'],
  eligible: ({ goblin, oreStockpiles }) => {
    if (goblin.inventory.ore <= 0) return false;
    return nearestStockpile(goblin, oreStockpiles, s => s.ore < s.maxOre) !== null;
  },
  score: ({ goblin, oreStockpiles, resourceBalance }) => {
    const onStockpile = oreStockpiles?.some(s => s.x === goblin.x && s.y === goblin.y) ?? false;
    const base = ramp(goblin.inventory.ore, 4, 14) * 0.6 * (onStockpile ? 2.5 : 1.0);
    const { materialsPressure = 0 } = resourceBalance ?? {};
    // When stored materials are low (high materialsPressure), boost hauling so deposits actually happen.
    const scarcityBoost = 1 + materialsPressure * 0.5;
    return Math.min(1.0, base * scarcityBoost);
  },
  execute: ({ goblin, grid, oreStockpiles }) => {
    const target = nearestStockpile(goblin, oreStockpiles, s => s.ore < s.maxOre);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const stored = Math.min(goblin.inventory.ore, target.maxOre - target.ore);
      if (stored > 0) {
        target.ore += stored;
        goblin.inventory.ore -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} ore → stockpile`;
      }
    } else {
      moveTo(goblin, target, grid);
      goblin.task = `→ ore stockpile (${goblin.inventory.ore.toFixed(0)} ore)`;
    }
  },
};

// --- depositWood: lumberjacks carry wood to stockpile ---
// Score grows with wood carried; tuned so deposit competes with chop when carrying a reasonable load.
export const depositWood: Action = {
  name: 'depositWood',
  tags: ['work'],
  eligible: ({ goblin, woodStockpiles }) => {
    if (goblin.inventory.wood <= 0) return false;
    return nearestStockpile(goblin, woodStockpiles, s => s.wood < s.maxWood) !== null;
  },
  score: ({ goblin, woodStockpiles, resourceBalance }) => {
    const onStockpile = woodStockpiles?.some(s => s.x === goblin.x && s.y === goblin.y) ?? false;
    const base = ramp(goblin.inventory.wood, 4, 14) * 0.6 * (onStockpile ? 2.5 : 1.0);
    const { materialsPressure = 0 } = resourceBalance ?? {};
    // Same scarcity boost as ore: when wood stockpiles are low, make hauling wood more competitive.
    const scarcityBoost = 1 + materialsPressure * 0.5;
    return Math.min(1.0, base * scarcityBoost);
  },
  execute: ({ goblin, grid, woodStockpiles }) => {
    const target = nearestStockpile(goblin, woodStockpiles, s => s.wood < s.maxWood);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const stored = Math.min(goblin.inventory.wood, target.maxWood - target.wood);
      if (stored > 0) {
        target.wood += stored;
        goblin.inventory.wood -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} wood → stockpile`;
      }
    } else {
      moveTo(goblin, target, grid);
      goblin.task = `→ wood stockpile (${goblin.inventory.wood.toFixed(0)} wood)`;
    }
  },
};
