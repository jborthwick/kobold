/**
 * wander: low-score fallback when nothing urgent — keeps goblins moving and discovering tiles.
 * Warmth is now derived per-goblin (shelter-style); no seekWarmth action.
 */
import { GRID_SIZE, TASK_STRINGS } from '../../shared/constants';
import { isWalkable } from '../world';
import { traitMod } from '../agents';
import { grantXp } from '../skills';
import { moveTo, getWalkableAdjacent } from './helpers';
import type { Action } from './types';

// --- wander: default fallback exploration ---
export const wander: Action = {
  name: 'wander',
  tags: ['explore'],
  eligible: () => true,
  score: () => 0.05,
  execute: ({ goblin, grid, currentTick, onLog }) => {
    const WANDER_HOLD_TICKS = 25;
    const wanDrift = traitMod(goblin, 'wariness', 2);
    const WANDER_MIN_DIST = 8 + wanDrift;
    const WANDER_MAX_DIST = 16 + wanDrift * 2;

    // Check if target is invalid or expired
    const hasValidTarget = goblin.wanderTarget && isWalkable(grid, goblin.wanderTarget.x, goblin.wanderTarget.y) && currentTick < goblin.wanderExpiry;
    const reachedTarget = goblin.wanderTarget && goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y;

    if (reachedTarget) {
      grantXp(goblin, 'scout', currentTick, onLog);
    }

    if (!hasValidTarget || reachedTarget) {
      // Try home drift first
      const homeDrift = traitMod(goblin, 'wanderHomeDrift', 0.25);
      if (Math.random() < homeDrift && (goblin.homeTile.x !== 0 || goblin.homeTile.y !== 0)) {
        const hx = goblin.homeTile.x + Math.round((Math.random() - 0.5) * 20);
        const hy = goblin.homeTile.y + Math.round((Math.random() - 0.5) * 20);
        if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid, hx, hy)) {
          goblin.wanderTarget = { x: hx, y: hy };
          goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
          moveTo(goblin, goblin.wanderTarget, grid);
          goblin.task = TASK_STRINGS.EXPLORING;
          return;
        }
      }

      // Try random exploration
      for (let attempt = 0; attempt < 8; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = WANDER_MIN_DIST + Math.random() * (WANDER_MAX_DIST - WANDER_MIN_DIST);
        const wx = Math.round(goblin.x + Math.cos(angle) * dist);
        const wy = Math.round(goblin.y + Math.sin(angle) * dist);
        if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid, wx, wy)) {
          goblin.wanderTarget = { x: wx, y: wy };
          goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
          moveTo(goblin, goblin.wanderTarget, grid);
          goblin.task = TASK_STRINGS.EXPLORING;
          return;
        }
      }

      // Fallback: random adjacent step
      const fallOpen = getWalkableAdjacent(grid, goblin.x, goblin.y);
      if (fallOpen.length > 0) {
        const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
        goblin.x = fb.x;
        goblin.y = fb.y;
      }
      goblin.task = TASK_STRINGS.WANDERING;
      return;
    }

    moveTo(goblin, goblin.wanderTarget!, grid);
    goblin.task = TASK_STRINGS.EXPLORING;
  },
};
