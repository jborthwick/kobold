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
      id:         `dwarf-${i}`,
      name:       DWARF_NAMES[i % DWARF_NAMES.length],
      x, y,
      health:     100,
      maxHealth:  100,
      hunger:     rand(10, 40),
      metabolism: rand(1, 3),
      vision:     rand(2, 5),
      inventory:  { food: rand(8, 15), materials: 0 },
      morale:     70 + rand(0, 20),
      alive:      true,
      task:       'idle',
    });
  }
  return dwarves;
}

function bestVisibleFoodTile(
  dwarf: Dwarf,
  grid: Tile[][],
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 0.5; // minimum worth moving toward

  for (let dy = -dwarf.vision; dy <= dwarf.vision; dy++) {
    for (let dx = -dwarf.vision; dx <= dwarf.vision; dx++) {
      const nx = dwarf.x + dx;
      const ny = dwarf.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const v = grid[ny][nx].foodValue;
      if (v > bestValue) {
        bestValue = v;
        best = { x: nx, y: ny };
      }
    }
  }
  return best;
}

function stepToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
  grid: Tile[][],
): { x: number; y: number } {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);

  // Try axis-aligned moves first, then diagonal
  const candidates = [
    dx !== 0 ? { x: from.x + dx, y: from.y } : null,
    dy !== 0 ? { x: from.x, y: from.y + dy } : null,
    dx !== 0 && dy !== 0 ? { x: from.x + dx, y: from.y + dy } : null,
  ].filter((p): p is { x: number; y: number } => p !== null && isWalkable(grid, p.x, p.y));

  return candidates[0] ?? from;
}

export function tickAgent(dwarf: Dwarf, grid: Tile[][]): void {
  if (!dwarf.alive) return;

  // Hunger increases every tick
  dwarf.hunger = Math.min(100, dwarf.hunger + dwarf.metabolism);

  // Eat from inventory if hungry
  if (dwarf.hunger > 50 && dwarf.inventory.food > 0) {
    const bite = Math.min(dwarf.inventory.food, 3);
    dwarf.inventory.food -= bite;
    dwarf.hunger = Math.max(0, dwarf.hunger - bite * 20);
    dwarf.task = 'eating';
  }

  // Starvation damage
  if (dwarf.hunger >= 100 && dwarf.inventory.food === 0) {
    dwarf.health -= 10;
    dwarf.morale  = Math.max(0, dwarf.morale - 5);
    dwarf.task    = 'starving!';
    if (dwarf.health <= 0) {
      dwarf.alive = false;
      dwarf.task  = 'dead';
      return;
    }
  }

  // Sugarscape movement: find richest visible food tile, move/harvest
  const target = bestVisibleFoodTile(dwarf, grid);
  if (target) {
    if (target.x === dwarf.x && target.y === dwarf.y) {
      const tile   = grid[dwarf.y][dwarf.x];
      const amount = Math.min(tile.foodValue, 3);
      tile.foodValue          = Math.max(0, tile.foodValue - amount);
      dwarf.inventory.food   += amount;
      dwarf.task = `harvesting (food: ${dwarf.inventory.food.toFixed(0)})`;
    } else {
      const next = stepToward({ x: dwarf.x, y: dwarf.y }, target, grid);
      dwarf.x    = next.x;
      dwarf.y    = next.y;
      dwarf.task = `foraging → (${target.x},${target.y})`;
    }
  } else {
    // No food visible — wander
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
}
