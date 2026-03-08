import { TileType } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { isWalkable } from '../world';
import { inverseSigmoid } from '../utilityAI';
import { traitMod, recordSite } from '../agents';
import { grantXp } from '../skills';
import { moveTo } from './helpers';
import type { Action } from './types';

// --- wander: default fallback exploration ---
export const wander: Action = {
  name: 'wander',
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
const SEEK_WARMTH_RADIUS              = 15;
const SEEK_WARMTH_COOLDOWN            = 150;
const SEEK_WARMTH_SCORE_COLD          = 0.28;
const SEEK_WARMTH_SCORE_DEFAULT       = 0.08;
export const seekWarmth: Action = {
  name: 'seekWarmth',
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
  score: ({ goblin, grid, warmthField, weatherType }) => {
    if (!warmthField) return 0;

    // Check if a hearth is visible or known BEFORE scoring
    let hearthExists = (goblin.knownHearthSites ?? []).length > 0;
    if (!hearthExists) {
      for (let dy = -SEEK_WARMTH_RADIUS; dy <= SEEK_WARMTH_RADIUS; dy++) {
        for (let dx = -SEEK_WARMTH_RADIUS; dx <= SEEK_WARMTH_RADIUS; dx++) {
          const nx = goblin.x + dx, ny = goblin.y + dy;
          if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && grid[ny][nx].type === TileType.Hearth) {
            hearthExists = true;
            break;
          }
        }
        if (hearthExists) break;
      }
    }
    if (!hearthExists) return 0; // No hearth visible or known, do not score

    const warmth = goblin.warmth ?? 100;
    const maxScore = weatherType === 'cold' ? SEEK_WARMTH_SCORE_COLD : SEEK_WARMTH_SCORE_DEFAULT;
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
    if (nearestDist <= traitMod(goblin, 'coziness', 2) || warmth >= 40) {
      goblin.lastLoggedTicks['seekWarmthDone'] = currentTick;
      goblin.task = 'warming up';
      return;
    }

    // Pathfind directly to the hearth (handles doorways and walls correctly)
    moveTo(goblin, nearestHearth, grid);
    goblin.task = 'seeking warmth';
  },
};

