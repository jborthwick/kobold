import { type Dwarf, type Tile } from '../shared/types';
import { GRID_SIZE, INITIAL_DWARVES, DWARF_NAMES } from '../shared/constants';
import { isWalkable } from './world';

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function spawnDwarves(grid: Tile[][]): Dwarf[] {
  const dwarves: Dwarf[] = [];
  for (let i = 0; i < INITIAL_DWARVES; i++) {
    let x: number, y: number;
    do {
      x = rand(2, 25);
      y = rand(2, 25);
    } while (!isWalkable(grid, x, y));

    dwarves.push({
      id:            `dwarf-${i}`,
      name:          DWARF_NAMES[i % DWARF_NAMES.length],
      x, y,
      health:        100,
      maxHealth:     100,
      hunger:        rand(10, 40),
      metabolism:    rand(1, 3),
      vision:        rand(2, 5),
      inventory:     { food: rand(8, 15), materials: 0 },
      morale:        70 + rand(0, 20),
      alive:         true,
      task:          'idle',
      commandTarget: null,
    });
  }
  return dwarves;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bestVisibleFoodTile(
  dwarf: Dwarf,
  grid: Tile[][],
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 0.5;

  for (let dy = -dwarf.vision; dy <= dwarf.vision; dy++) {
    for (let dx = -dwarf.vision; dx <= dwarf.vision; dx++) {
      const nx = dwarf.x + dx;
      const ny = dwarf.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const v = grid[ny][nx].foodValue;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

function stepToward(
  from: { x: number; y: number },
  to:   { x: number; y: number },
  grid: Tile[][],
): { x: number; y: number } {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);

  const candidates = [
    dx !== 0 ? { x: from.x + dx, y: from.y }                   : null,
    dy !== 0 ? { x: from.x,       y: from.y + dy }              : null,
    dx !== 0 && dy !== 0 ? { x: from.x + dx, y: from.y + dy }  : null,
  ].filter((p): p is { x: number; y: number } => p !== null && isWalkable(grid, p.x, p.y));

  return candidates[0] ?? from;
}

// ── Behavior Tree ──────────────────────────────────────────────────────────
// Priority cascade (highest first):
//   1. Starvation damage / death
//   2. Eat from inventory
//   3. Harvest tile underfoot
//   4. Follow player commandTarget
//   5. Forage toward richest visible food
//   6. Wander

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export function tickAgent(
  dwarf: Dwarf,
  grid:  Tile[][],
  onLog?: LogFn,
): void {
  if (!dwarf.alive) return;

  // Hunger grows every tick
  dwarf.hunger = Math.min(100, dwarf.hunger + dwarf.metabolism);

  // ── 1. Starvation ─────────────────────────────────────────────────────
  if (dwarf.hunger >= 100 && dwarf.inventory.food === 0) {
    dwarf.health -= 10;
    dwarf.morale  = Math.max(0, dwarf.morale - 5);
    dwarf.task    = 'starving!';
    onLog?.(`is starving! (health ${dwarf.health})`, 'warn');
    if (dwarf.health <= 0) {
      dwarf.alive = false;
      dwarf.task  = 'dead';
      onLog?.('has died!', 'error');
      return;
    }
    // Still alive — fall through so they can still move toward food
  }

  // ── 2. Eat from inventory ──────────────────────────────────────────────
  if (dwarf.hunger > 50 && dwarf.inventory.food > 0) {
    const bite        = Math.min(dwarf.inventory.food, 3);
    dwarf.inventory.food -= bite;
    dwarf.hunger      = Math.max(0, dwarf.hunger - bite * 20);
    dwarf.task        = 'eating';
    return;
  }

  // ── 3. Harvest tile underfoot ──────────────────────────────────────────
  const here = grid[dwarf.y][dwarf.x];
  if (here.foodValue > 0) {
    const amount          = Math.min(here.foodValue, 3);
    here.foodValue        = Math.max(0, here.foodValue - amount);
    dwarf.inventory.food += amount;
    dwarf.task            = `harvesting (food: ${dwarf.inventory.food.toFixed(0)})`;
    return;
  }

  // ── 4. Follow player command ───────────────────────────────────────────
  if (dwarf.commandTarget) {
    const { x: tx, y: ty } = dwarf.commandTarget;
    if (dwarf.x === tx && dwarf.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      dwarf.commandTarget = null;
      dwarf.task          = 'arrived';
    } else {
      const next = stepToward({ x: dwarf.x, y: dwarf.y }, dwarf.commandTarget, grid);
      dwarf.x    = next.x;
      dwarf.y    = next.y;
      dwarf.task = `→ (${tx},${ty})`;
    }
    return;
  }

  // ── 5. Forage toward richest visible food ──────────────────────────────
  const target = bestVisibleFoodTile(dwarf, grid);
  if (target) {
    const next = stepToward({ x: dwarf.x, y: dwarf.y }, target, grid);
    dwarf.x    = next.x;
    dwarf.y    = next.y;
    dwarf.task = `foraging → (${target.x},${target.y})`;
    return;
  }

  // ── 6. Wander ──────────────────────────────────────────────────────────
  const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const open = dirs
    .map(d => ({ x: dwarf.x + d.x, y: dwarf.y + d.y }))
    .filter(p => isWalkable(grid, p.x, p.y));
  if (open.length > 0) {
    const next = open[Math.floor(Math.random() * open.length)];
    dwarf.x    = next.x;
    dwarf.y    = next.y;
  }
  dwarf.task = 'wandering';
}
