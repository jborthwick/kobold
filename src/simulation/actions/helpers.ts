import type { Goblin, Tile, GoblinTrait, FoodStockpile, OreStockpile, WoodStockpile } from '../../shared/types';
import { pathNextStep, traitMod } from '../agents';
import { isLegWoundSkip } from '../wounds';

/** Total items a goblin is carrying across all slots. */
export function totalLoad(inv: { food: number; ore: number; wood: number }): number {
  return inv.food + inv.ore + inv.wood;
}

// ── Trait-flavored log text ──────────────────────────────────────────────────

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

/** Cooldown-gated log: returns true (and records the tick) at most once per `cooldown` ticks. */
export function shouldLog(goblin: Goblin, key: string, tick: number, cooldown: number): boolean {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}

export function fatigueRate(goblin: Goblin): number {
  return traitMod(goblin, 'fatigueRate', 1.0);
}

/** Returns a committed movement target, or scanned target if expired/arrived. */
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

export function moveTo(goblin: Goblin, target: { x: number; y: number }, grid: Tile[][]): void {
  // Leg wound: 40% chance to skip this tick's movement (limp)
  if (isLegWoundSkip(goblin)) return;
  const next = pathNextStep({ x: goblin.x, y: goblin.y }, target, grid);
  goblin.x = next.x;
  goblin.y = next.y;
  goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate(goblin));
}

/** Move toward a target with committed path memory to prevent oscillations.
 * Combines getOrSetMoveTarget + moveTo into a single call. */
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
