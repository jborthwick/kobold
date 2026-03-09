import type { Adventurer } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { getActiveFaction } from '../../shared/factions';
import { isWalkable } from '../world';
import { sigmoid, inverseSigmoid } from '../utilityAI';
import { traitMod, pathNextStep, ROLE_COMBAT_APT } from '../agents';
import { effectiveVision, isLegWoundSkip } from '../wounds';
import { getDanger } from '../diffusion';
import { grantXp } from '../skills';
import { moveTo, fatigueRate, getOrSetMoveTarget } from './helpers';
import type { Action } from './types';

// --- fight: fighters hunt nearby adventurers ---
export const fight: Action = {
  name: 'fight',
  tags: ['combat'],
  eligible: ({ goblin, adventurers }) => {
    if (!adventurers || adventurers.length === 0) return false;
    const fleeAt = traitMod(goblin, 'fleeThreshold', 80);
    return goblin.hunger < fleeAt;
  },
  score: ({ goblin, adventurers }) => {
    if (!adventurers || adventurers.length === 0) return 0;
    const HUNT_RADIUS = effectiveVision(goblin) * traitMod(goblin, 'huntRange', 2.0);
    const nearest = adventurers.reduce<{ dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return (!best || dist < best.dist) ? { dist } : best;
    }, null);
    if (!nearest || nearest.dist > HUNT_RADIUS) return 0;
    // Closer adventurers score higher; less hungry = more willing to fight
    // Role aptitude scales the score so non-fighters rarely choose this over foraging
    return inverseSigmoid(nearest.dist, HUNT_RADIUS * 0.5, 0.2)
      * inverseSigmoid(goblin.hunger, 60)
      * ROLE_COMBAT_APT[goblin.role];
  },
  execute: ({ goblin, adventurers, grid, currentTick, onLog }) => {
    if (!adventurers) return;
    const HUNT_RADIUS = effectiveVision(goblin) * traitMod(goblin, 'huntRange', 2.0);
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

// --- seekSafety: flee to lowest-danger tile when threatened ---
export const seekSafety: Action = {
  name: 'seekSafety',
  tags: ['safety'],
  eligible: ({ goblin, dangerField }) => {
    if (!dangerField) return false;
    return getDanger(dangerField, goblin.x, goblin.y) > 60;
  },
  score: ({ goblin, grid, dangerField }) => {
    if (!dangerField) return 0;
    const currentDanger = getDanger(dangerField, goblin.x, goblin.y);
    if (currentDanger <= 60) return 0;

    // Scan for better tile: only score if we actually have somewhere safer to go
    let bestDanger = currentDanger;
    const SCAN = Math.min(5, effectiveVision(goblin));
    for (let dy = -SCAN; dy <= SCAN; dy++) {
      for (let dx = -SCAN; dx <= SCAN; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (!isWalkable(grid, nx, ny)) continue;
        const d = getDanger(dangerField, nx, ny);
        if (d < bestDanger) bestDanger = d;
      }
    }
    if (bestDanger >= currentDanger) return 0; // no safer tile visible

    return sigmoid(currentDanger, 60, 0.12) * 0.65;
  },
  execute: ({ goblin, grid, dangerField, currentTick }) => {
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
      const dest = getOrSetMoveTarget(goblin, bestTile, currentTick, 20, 3);
      moveTo(goblin, dest, grid);
      goblin.task = 'fleeing to safety';
    }
  },
};
