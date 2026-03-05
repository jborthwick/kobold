import { TileType } from '../../shared/types';
import { MAX_INVENTORY_CAPACITY } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import {
  bestMaterialTile, bestWoodTile, recordSite, SITE_RECORD_THRESHOLD,
  ROLE_MINING_APT, ROLE_CHOP_APT, traitMod,
} from '../agents';
import { grantXp, skillOreBonus, skillYieldBonus } from '../skills';
import { effectiveVision, woundYieldMultiplier } from '../wounds';
import { moveTo, addWorkFatigue, totalLoad, nearestOreStockpile, nearestWoodStockpile } from './helpers';
import type { Action } from './types';

// --- mine: miners target ore tiles ---
export const mine: Action = {
  name: 'mine',
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid, oreStockpiles }) => {
    const apt = ROLE_MINING_APT[goblin.role];
    // Colony need: score scales from 0.2 (full stockpile) to 1.0 (empty)
    const totalOre = oreStockpiles?.reduce((s, p) => s + p.ore, 0) ?? 0;
    const maxOre   = oreStockpiles?.reduce((s, p) => s + p.maxOre, 0) ?? 1;
    const oreNeed  = maxOre > 0 ? 0.2 + 0.8 * (1 - totalOre / maxOre) : 1.0;
    const target = bestMaterialTile(goblin, grid, effectiveVision(goblin));
    if (!target) {
      if (goblin.knownOreSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35 * apt * oreNeed;
      return 0;
    }
    return inverseSigmoid(goblin.hunger, 60) * 0.6 * apt * oreNeed;
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
        goblin.inventory.ore += Math.min(mined, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
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
export const chop: Action = {
  name: 'chop',
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: ({ goblin, grid, woodStockpiles }) => {
    const apt = ROLE_CHOP_APT[goblin.role];
    // Colony need: score scales from 0.2 (full stockpile) to 1.0 (empty)
    const totalWood = woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0;
    const maxWood   = woodStockpiles?.reduce((s, p) => s + p.maxWood, 0) ?? 1;
    const woodNeed  = maxWood > 0 ? 0.2 + 0.8 * (1 - totalWood / maxWood) : 1.0;
    const target = bestWoodTile(goblin, grid, effectiveVision(goblin));
    if (!target) {
      if (goblin.knownWoodSites.length > 0) return inverseSigmoid(goblin.hunger, 60) * 0.35 * apt * woodNeed;
      return 0;
    }
    return inverseSigmoid(goblin.hunger, 60) * 0.6 * apt * woodNeed;
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
        const roleChopBonus = goblin.role === 'lumberjack' ? 15 : 0;
        const baseChop     = 5 + roleChopBonus + traitMod(goblin, 'chopPower', 0) + skillYieldBonus(goblin);
        const chopYield    = Math.max(1, Math.round(baseChop * woundYieldMultiplier(goblin)));
        const chopped      = Math.min(hadWood, chopYield);
        here.materialValue = Math.max(0, hadWood - chopped);
        // Depleted forest reverts to a tree stump
        if (here.materialValue === 0) { here.type = TileType.TreeStump; here.maxMaterial = 0; }
        goblin.inventory.wood += Math.min(chopped, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
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
export const depositOre: Action = {
  name: 'depositOre',
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
        target.ore          += stored;
        goblin.inventory.ore -= stored;
        goblin.task          = `deposited ${stored.toFixed(0)} ore → stockpile`;
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
        target.wood           += stored;
        goblin.inventory.wood -= stored;
        goblin.task            = `deposited ${stored.toFixed(0)} wood → stockpile`;
      }
    } else {
      moveTo(goblin, target, grid);
      goblin.task = `→ wood stockpile (${goblin.inventory.wood.toFixed(0)} wood)`;
    }
  },
};
