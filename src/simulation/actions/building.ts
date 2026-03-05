import { TileType } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import { roomWallSlots, recordSite, pathNextStep } from '../agents';
import { moveTo, addWorkFatigue, shouldLog, fatigueRate, nearestWoodStockpile } from './helpers';
import type { Action } from './types';

// --- buildWall: any goblin can build walls around rooms ---
export const buildWall: Action = {
  name: 'buildWall',
  eligible: ({ rooms, oreStockpiles, goblin }) => {
    if (!rooms || rooms.length === 0) return false;
    // Need ore to build — either in stockpile or inventory
    const stockpileOre = oreStockpiles?.reduce((s, o) => s + o.ore, 0) ?? 0;
    return (stockpileOre >= 3) || (goblin.inventory.ore >= 3);
  },
  score: ({ goblin, oreStockpiles, rooms, grid, goblins, adventurers }) => {
    const totalOre = (oreStockpiles?.reduce((s, o) => s + o.ore, 0) ?? 0) + goblin.inventory.ore;
    if (totalOre < 3) return 0;

    if (!rooms || rooms.length === 0) return 0;
    const wallSlots = roomWallSlots(rooms, grid, goblins, goblin.id, adventurers);
    if (wallSlots.length === 0) return 0;

    return ramp(totalOre, 3, 30) * inverseSigmoid(goblin.hunger, 50) * 0.45;
  },
  execute: ({ goblin, grid, rooms, oreStockpiles, goblins, adventurers }) => {
    if (!rooms || rooms.length === 0) return;

    // Prefer stockpile ore, fall back to inventory
    const buildStockpile = oreStockpiles?.find(s => s.ore >= 3);
    const useInventory = !buildStockpile && goblin.inventory.ore >= 3;
    if (!buildStockpile && !useInventory) return;

    const wallSlots = roomWallSlots(rooms, grid, goblins, goblin.id, adventurers);

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
        if (buildStockpile) {
          buildStockpile.ore -= 3;
        } else {
          goblin.inventory.ore -= 3;
        }
        addWorkFatigue(goblin);
        goblin.task = 'built room wall!';
      } else {
        goblin.x = next.x; goblin.y = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
        goblin.task = '→ room wall';
      }
    }
  },
};

// --- buildHearth: any goblin builds a hearth from 2 wood when they're cold ---
// "Near base" clustering emerges naturally: goblins spend most time near home,
// so the first fire gets built there. Once it warms that area, nearby goblins
// stay warm and won't build another. Only goblins cold in a different location build elsewhere.
const HEARTH_COVERAGE_RADIUS = 8;  // matches warmth BFS radius — if a hearth covers you, don't build
const HEARTH_BUILD_COOLDOWN  = 300; // personal cooldown after placing, prevents back-to-back builds
export const buildHearth: Action = {
  name: 'buildHearth',
  eligible: ({ goblin, woodStockpiles, foodStockpiles, grid, currentTick }) => {
    const totalFood = foodStockpiles?.reduce((s, f) => s + f.food, 0) ?? 0;
    if (totalFood < 20) return false;
    const totalWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    if (totalWood < 2) return false;
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
    const buildStockpile = nearestWoodStockpile(goblin, woodStockpiles, s => s.wood >= 2);
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
