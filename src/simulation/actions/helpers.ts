/**
 * Shared helpers for actions: movement, fatigue, stockpile lookup, flavor text. These helpers
 * mutate goblin state (position, fatigue, moveTarget, moveExpiry, lastLoggedTicks).
 *
 * Movement: use moveToward() (or getOrSetMoveTarget + moveTo) so the goblin commits to a target
 * for a few ticks — otherwise re-scanning every tick makes them ping-pong between two equally
 * good tiles. moveTo does one A* step and adds fatigue; leg wounds can skip (wounds.ts).
 * Fatigue: fatigueRate() is trait-modified. moveTo adds 0.2× rate per step; addWorkFatigue() adds
 * 0.4× (call from harvest/mine/chop/build). Stockpiles: nearest*Stockpile(filter) returns
 * Manhattan-nearest matching pile. Logging: traitText() for eat/rest/share; shouldLog() is
 * cooldown-gated so logs don't spam.
 */

import type { Goblin, Tile, GoblinTrait, FoodStockpile, OreStockpile, WoodStockpile, PlankStockpile, BarStockpile } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { pathNextStep, traitMod } from '../agents';
import { isLegWoundSkip } from '../wounds';
import { isWalkable } from '../world';

/** Total items a goblin is carrying across all slots. */
export function totalLoad(inv: { food: number; ore: number; wood: number }): number {
  return inv.food + inv.ore + inv.wood;
}

// ── Trait-flavored log text ──────────────────────────────────────────────────

/** Per-trait override strings for eat / rest / share (used in action logs). */
export const TRAIT_FLAVOR: Record<GoblinTrait, Record<string, string>> = {
  lazy:      { eat: 'scarfed down food messily',       rest: 'collapsed into a heap',          share: 'grudgingly tossed over some food' },
  helpful:   { eat: 'gobbled food quickly',            rest: 'rested briefly',                 share: 'excitedly shared' },
  greedy:    { eat: 'ate greedily, hiding scraps',     rest: 'rested atop his hoard',          share: 'painfully parted with some food' },
  brave:     { eat: 'ate without looking',             rest: 'caught breath mid-charge',       share: 'shared' },
  cheerful:  { eat: 'ate with a grin',                 rest: 'napped with a smile',            share: 'gladly shared' },
  mean:      { eat: 'ate alone, growling',             rest: 'rested, glaring at everyone',    share: 'begrudgingly shared' },
  paranoid:  { eat: 'ate while looking around wildly', rest: 'rested with both eyes open',     share: 'cautiously shared' },
  forgetful: { eat: 'ate... wait, what?',              rest: 'dozed off mid-thought',          share: 'shared (forgot he gave it away)' },
};

export function traitText(goblin: Goblin, action: string): string {
  return TRAIT_FLAVOR[goblin.trait]?.[action] ?? action;
}

/** Cooldown-gated log: true at most once per cooldown ticks; updates goblin.lastLoggedTicks[key]. */
export function shouldLog(goblin: Goblin, key: string, tick: number, cooldown: number): boolean {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}

/** Trait-modified fatigue rate (e.g. lazy = higher). */
export function fatigueRate(goblin: Goblin): number {
  return traitMod(goblin, 'fatigueRate', 1.0);
}

/** Current committed target, or set and return new target if expired/arrived. */
export function getOrSetMoveTarget(
  goblin: Goblin,
  newTarget: { x: number; y: number },
  currentTick: number,
  expiry = 20,      // ticks before forced re-scan
  arrivalRadius = 0 // Chebyshev distance considered "arrived"
): { x: number; y: number } {
  const t = goblin.moveTarget;
  const arrived = t && Math.max(Math.abs(goblin.x - t.x), Math.abs(goblin.y - t.y)) <= arrivalRadius;
  if (t && !arrived && currentTick < (goblin.moveExpiry ?? 0)) {
    return t;  // committed — keep going
  }
  goblin.moveTarget = newTarget;
  goblin.moveExpiry = currentTick + expiry;
  return newTarget;
}

/** One step toward target. Leg wound may skip movement (wounds.ts). */
export function moveTo(goblin: Goblin, target: { x: number; y: number }, grid: Tile[][]): void {
  // Leg wound: 40% chance to skip this tick's movement (limp)
  if (isLegWoundSkip(goblin)) return;
  const next = pathNextStep({ x: goblin.x, y: goblin.y }, target, grid);
  goblin.x = next.x;
  goblin.y = next.y;
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
}

/** Move toward target with path commitment (getOrSetMoveTarget + moveTo). */
export function moveToward(
  goblin: Goblin,
  newTarget: { x: number; y: number },
  grid: Tile[][],
  currentTick: number,
  expiry = 15,
): void {
  const dest = getOrSetMoveTarget(goblin, newTarget, currentTick, expiry);
  moveTo(goblin, dest, grid);
}

/** Add work fatigue (0.4 × fatigueRate). Call from harvest/mine/chop/build. */
export function addWorkFatigue(goblin: Goblin): void {
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate(goblin));
}

/** Find nearest food stockpile matching a filter. */
export function nearestFoodStockpile(
  goblin: Goblin, stockpiles: FoodStockpile[] | undefined, filter: (s: FoodStockpile) => boolean,
): FoodStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<FoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

export function nearestOreStockpile(
  goblin: Goblin, stockpiles: OreStockpile[] | undefined, filter: (s: OreStockpile) => boolean,
): OreStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<OreStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

export function nearestWoodStockpile(
  goblin: Goblin, stockpiles: WoodStockpile[] | undefined, filter: (s: WoodStockpile) => boolean,
): WoodStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<WoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

export function nearestPlankStockpile(
  goblin: Goblin, stockpiles: PlankStockpile[] | undefined, filter: (s: PlankStockpile) => boolean,
): PlankStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<PlankStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

export function nearestBarStockpile(
  goblin: Goblin, stockpiles: BarStockpile[] | undefined, filter: (s: BarStockpile) => boolean,
): BarStockpile | null {
  return stockpiles
    ?.filter(filter)
    .reduce<BarStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
}

// ── Grid navigation helpers ──────────────────────────────────────────────────

/** Cardinal directions (N, S, E, W) for neighbor enumeration. */
export const CARDINAL_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
] as const;

/** Get walkable adjacent tiles in cardinal directions. */
export function getWalkableAdjacent(grid: Tile[][], x: number, y: number): { x: number; y: number }[] {
  return CARDINAL_DIRECTIONS
    .map(d => ({ x: x + d.x, y: y + d.y }))
    .filter(p => isWalkable(grid, p.x, p.y));
}
