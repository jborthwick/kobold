import { TileType } from '../../shared/types';
import { MAX_INVENTORY_CAPACITY } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import {
  bestMaterialTile, bestWoodTile, recordSite, SITE_RECORD_THRESHOLD,
  ROLE_MINING_APT, ROLE_CHOP_APT, traitMod,
} from '../agents';
import { grantXp, skillOreBonus, skillYieldBonus } from '../skills';
import { effectiveVision, woundYieldMultiplier } from '../wounds';
import { moveTo, moveToward, addWorkFatigue, totalLoad, nearestOreStockpile, nearestWoodStockpile } from './helpers';
import { addThought } from '../mood';
import type { Action } from './types';

// --- mine: miners target ore tiles ---
export const mine: Action = {
  name: 'mine',
  tags: ['work'],
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid, oreStockpiles }) => {
    const apt = ROLE_MINING_APT[goblin.role];
    // Colony need: score scales from 0.2 (full stockpile) to 1.0 (empty)
    const totalOre = oreStockpiles?.reduce((s, p) => s + p.ore, 0) ?? 0;
    const maxOre = oreStockpiles?.reduce((s, p) => s + p.maxOre, 0) ?? 1;
    const oreNeed = maxOre > 0 ? 0.2 + 0.8 * (1 - totalOre / maxOre) : 1.0;
    // Warmth safety: if freezing, prioritize survival over work
    if ((goblin.warmth ?? 100) < 15 && !goblin.task.includes('warming')) return 0;

    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, 'maxSearchRadius', 15));
    const target = bestMaterialTile(goblin, grid, radius);
    if (!target) {
      // No ore in view: only score if we have remembered sites, and keep score modest so other actions get share
      if (goblin.knownOreSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.2 * apt * oreNeed;
      return 0;
    }
    const base = inverseSigmoid(goblin.hunger, 60) * 0.6 * apt * oreNeed;
    const momentum = (goblin.task.includes('mining') || goblin.task.includes('remembered ore')) ? 0.15 : 0;
    return Math.min(1.0, base + momentum);
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
          grantXp(goblin, currentTick, onLog);
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
  score: ({ goblin, grid, woodStockpiles }) => {
    const apt = ROLE_CHOP_APT[goblin.role];
    // Colony need: score scales from 0.2 (full stockpile) to 1.0 (empty)
    const totalWood = woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0;
    const maxWood = woodStockpiles?.reduce((s, p) => s + p.maxWood, 0) ?? 1;
    const woodNeed = maxWood > 0 ? 0.2 + 0.8 * (1 - totalWood / maxWood) : 1.0;
    // Warmth safety: if freezing, prioritize survival over work
    if ((goblin.warmth ?? 100) < 15 && !goblin.task.includes('warming')) return 0;

    const radius = Math.max(effectiveVision(goblin), traitMod(goblin, 'maxSearchRadius', 15));
    const target = bestWoodTile(goblin, grid, radius);
    if (!target) {
      if (goblin.knownWoodSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35 * apt * woodNeed;
      return 0;
    }
    const base = inverseSigmoid(goblin.hunger, 60) * 0.6 * apt * woodNeed;
    const momentum = (goblin.task.includes('logging') || goblin.task.includes('forest') || goblin.task.includes('remembered forest') || goblin.task.includes('stump')) ? 0.15 : 0;
    return Math.min(1.0, base + momentum);
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
          const roleChopBonus = goblin.role === 'lumberjack' ? 15 : 0;
          const baseChop = 5 + roleChopBonus + traitMod(goblin, 'chopPower', 0) + skillYieldBonus(goblin);
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
          grantXp(goblin, currentTick, onLog);
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
export const depositOre: Action = {
  name: 'depositOre',
  tags: ['work'],
  eligible: ({ goblin, oreStockpiles }) => {
    if (goblin.inventory.ore <= 0) return false;
    return nearestOreStockpile(goblin, oreStockpiles, s => s.ore < s.maxOre) !== null;
  },
  score: ({ goblin, oreStockpiles }) => {
    const onStockpile = oreStockpiles?.some(s => s.x === goblin.x && s.y === goblin.y) ?? false;
    return ramp(goblin.inventory.ore, 6, 20) * 0.5 * (onStockpile ? 2.5 : 1.0);
  },
  execute: ({ goblin, grid, oreStockpiles }) => {
    const target = nearestOreStockpile(goblin, oreStockpiles, s => s.ore < s.maxOre);
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
export const depositWood: Action = {
  name: 'depositWood',
  tags: ['work'],
  eligible: ({ goblin, woodStockpiles }) => {
    if (goblin.inventory.wood <= 0) return false;
    return nearestWoodStockpile(goblin, woodStockpiles, s => s.wood < s.maxWood) !== null;
  },
  score: ({ goblin, woodStockpiles }) => {
    const onStockpile = woodStockpiles?.some(s => s.x === goblin.x && s.y === goblin.y) ?? false;
    return ramp(goblin.inventory.wood, 6, 20) * 0.5 * (onStockpile ? 2.5 : 1.0);
  },
  execute: ({ goblin, grid, woodStockpiles }) => {
    const target = nearestWoodStockpile(goblin, woodStockpiles, s => s.wood < s.maxWood);
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
