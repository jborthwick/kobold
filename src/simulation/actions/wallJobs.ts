/**
 * Shared wall-build job selection: fortifiable slots only, reachability, short cooldown on dead ends.
 */

import type { Goblin, Tile } from '../../shared/types';
import { isWallType } from '../../shared/types';
import { pathNextStep } from '../agents/pathfinding';
import { isWallSlotTerrain } from '../agents/fort';

export const WALL_JOB_COOLDOWN_TICKS = 30;
const WALL_BLK_PREFIX = 'wallBlk:';

function wallBlockKey(x: number, y: number): string {
  return `${WALL_BLK_PREFIX}${x},${y}`;
}

export function markWallSlotBlocked(goblin: Goblin, x: number, y: number, tick: number): void {
  goblin.lastLoggedTicks[wallBlockKey(x, y)] = tick;
}

function isWallSlotCoolingDown(
  goblin: Goblin,
  x: number,
  y: number,
  tick: number,
  cooldownTicks: number,
): boolean {
  return tick - (goblin.lastLoggedTicks[wallBlockKey(x, y)] ?? -Infinity) < cooldownTicks;
}

/** Fraction of fortifiable wall slots that are already built as walls (any wall type). */
export function wallCompletionFraction(
  grid: Tile[][],
  slots: Array<{ x: number; y: number }>,
): number {
  if (slots.length === 0) return 1;
  const walled = slots.filter(s => isWallType(grid[s.y][s.x].type)).length;
  return walled / slots.length;
}

/**
 * Best empty wall slot within Manhattan distance that has a non-stuck first path step.
 * Marks unreachable candidates on cooldown so goblins don't loop on the same dead end.
 */
export function pickReachableWallSlot(
  goblin: Goblin,
  grid: Tile[][],
  slots: Array<{ x: number; y: number }>,
  maxDist: number,
  currentTick: number,
  cooldownTicks: number = WALL_JOB_COOLDOWN_TICKS,
): { x: number; y: number } | null {
  const from = { x: goblin.x, y: goblin.y };
  const candidates = slots
    .filter(s => {
      if (isWallType(grid[s.y][s.x].type)) return false;
      if (!isWallSlotTerrain(grid[s.y][s.x].type)) return false;
      const dist = Math.abs(s.x - from.x) + Math.abs(s.y - from.y);
      if (dist > maxDist) return false;
      if (isWallSlotCoolingDown(goblin, s.x, s.y, currentTick, cooldownTicks)) return false;
      return true;
    })
    .sort((a, b) => {
      const da = Math.abs(a.x - from.x) + Math.abs(a.y - from.y);
      const db = Math.abs(b.x - from.x) + Math.abs(b.y - from.y);
      return da - db;
    });

  for (const s of candidates) {
    const next = pathNextStep(from, s, grid);
    if (next.x !== from.x || next.y !== from.y) {
      return s;
    }
    markWallSlotBlocked(goblin, s.x, s.y, currentTick);
  }
  return null;
}
