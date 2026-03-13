/**
 * seekWarmth, wander. seekWarmth moves toward high warmth (diffusion) when cold; wander is
 * the low-score fallback when nothing urgent — keeps goblins moving and discovering tiles.
 */
import { TileType } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { isWalkable } from '../world';
import { getWarmth } from '../diffusion';
import { inverseSigmoid } from '../utilityAI';
import { traitMod, recordSite } from '../agents';
import { grantXp } from '../skills';
import { moveTo } from './helpers';
import type { Action } from './types';

// --- wander: default fallback exploration ---
export const wander: Action = {
  name: 'wander',
  tags: ['explore'],
  eligible: () => true,
  score: () => 0.05,
  execute: ({ goblin, grid, currentTick, onLog }) => {
    // Paranoid goblins (wariness 4) roam further; default wariness=2 → normal wander distances
    const WANDER_HOLD_TICKS = 25;
    const wanDrift  = traitMod(goblin, 'wariness', 2); // higher wariness = wider exploration
    const WANDER_MIN_DIST   = 8 + wanDrift;
    const WANDER_MAX_DIST   = 16 + wanDrift * 2;

    // Invalidate wander target if blocked
    if (goblin.wanderTarget && !isWalkable(grid, goblin.wanderTarget.x, goblin.wanderTarget.y)) {
      goblin.wanderTarget = null;
    }

    // Scout XP — grant on reaching wander target
    if (goblin.wanderTarget && goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y) {
      grantXp(goblin, 'scout', currentTick, onLog);
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

// --- seekWarmth: comfort preference — pathfinds to nearest hearth or warm zone, stops once warm ---
const SEEK_WARMTH_RADIUS              = 15;
const SEEK_WARMTH_WARMTH_THRESHOLD    = 35;    // min warmth to target as warm zone
const SEEK_WARMTH_COOLDOWN            = 80;
const SEEK_WARMTH_SCORE_COLD          = 0.45;
const SEEK_WARMTH_SCORE_DEFAULT       = 0.18;
export const seekWarmth: Action = {
  name: 'seekWarmth',
  tags: ['comfort'],
  eligible: ({ goblin, warmthField, grid, currentTick }) => {
    if (!warmthField) return false;
    // Use smoothed goblin.warmth to avoid single-step threshold crossings.
    // Hysteresis: if already en route (task from last tick), stay committed until comfortably warm (50);
    // otherwise only start when actually cold (< 35).
    const warmth = goblin.warmth ?? 100;
    const exitThreshold = goblin.task === 'seeking warmth' ? 50 : 35;
    if (warmth >= exitThreshold) return false;
    // Cooldown: prevents re-triggering immediately after being warm
    if (currentTick - (goblin.lastLoggedTicks['seekWarmthDone'] ?? 0) < SEEK_WARMTH_COOLDOWN) return false;
    // Eligible if a hearth is visible in range OR a warm zone (warmth field >= threshold) OR remembered hearth
    for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
      for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
          if (grid[ny][nx].type === TileType.Hearth) return true;
          if (getWarmth(warmthField, nx, ny) >= SEEK_WARMTH_WARMTH_THRESHOLD) return true;
        }
      }
    }
    return (goblin.knownHearthSites ?? []).length > 0;
  },
  score: ({ goblin, warmthField, weatherType }) => {
    if (!warmthField) return 0;
    // eligible() already verified a warmth target exists; just compute the score
    const warmth = goblin.warmth ?? 100;
    const maxScore = weatherType === 'cold' ? SEEK_WARMTH_SCORE_COLD : SEEK_WARMTH_SCORE_DEFAULT;
    return inverseSigmoid(warmth, 20, 0.12) * maxScore;
  },
  execute: ({ goblin, grid, warmthField, currentTick }) => {
    let nearestHearth: { x: number; y: number } | null = null;
    let nearestHearthDist = Infinity;
    let warmestTile: { x: number; y: number } | null = null;
    let warmestValue = SEEK_WARMTH_WARMTH_THRESHOLD;
    let warmestDist = Infinity;

    // Single scan: find nearest hearth and warmest tile (fallback)
    for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
      for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;

        const dist = Math.abs(dx) + Math.abs(dy);

        // Check for hearth
        if (grid[ny][nx].type === TileType.Hearth) {
          recordSite(goblin.knownHearthSites ?? (goblin.knownHearthSites = []), nx, ny, 1, currentTick);
          if (dist < nearestHearthDist) {
            nearestHearthDist = dist;
            nearestHearth = { x: nx, y: ny };
          }
        }

        // Check for warm zone (fallback if no hearth)
        if (warmthField) {
          const w = getWarmth(warmthField, nx, ny);
          if (w > warmestValue) {
            warmestValue = w;
            warmestDist = dist;
            warmestTile = { x: nx, y: ny };
          }
        }
      }
    }

    // Prefer hearth, fall back to warmest tile
    let target = nearestHearth ?? warmestTile;
    let targetDist = nearestHearth ? nearestHearthDist : warmestTile ? warmestDist : Infinity;

    // Nothing in range — fall back to memory (navigate toward remembered hearth)
    if (!target) {
      const sites = goblin.knownHearthSites ?? [];
      const sorted = [...sites].sort(
        (a, b) =>
          Math.abs(a.x - goblin.x) +
          Math.abs(a.y - goblin.y) -
          (Math.abs(b.x - goblin.x) + Math.abs(b.y - goblin.y)),
      );
      for (const site of sorted) {
        if (grid[site.y]?.[site.x]?.type === TileType.Hearth) {
          target = { x: site.x, y: site.y };
          targetDist = Math.abs(site.x - goblin.x) + Math.abs(site.y - goblin.y);
          break;
        }
        // Hearth is gone — evict
        goblin.knownHearthSites = sites.filter(s => !(s.x === site.x && s.y === site.y));
      }
    }

    if (!target) return; // no warmth target known — skip silently

    // Satisfied: close to target or smoothed warmth has risen enough — start cooldown
    const warmth = goblin.warmth ?? 0;
    if (targetDist <= traitMod(goblin, 'coziness', 2) || warmth >= 40) {
      goblin.lastLoggedTicks['seekWarmthDone'] = currentTick;
      goblin.task = 'warming up';
      return;
    }

    // Pathfind directly to the target warm tile (handles doorways and walls correctly)
    moveTo(goblin, target, grid);
    goblin.task = 'seeking warmth';
  },
};

