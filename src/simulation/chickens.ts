import type { Chicken, Goblin, Room, Tile } from '../shared/types';
import { TileType } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';
import { isWalkable } from './world';
import { getTerrainMoveCost } from './movementCost';

let nextChickenId = 0;

export function resetChickens(): void {
  nextChickenId = 0;
}

export function syncChickenIdCounter(chickens: Chicken[]): void {
  let maxId = -1;
  for (const chicken of chickens) {
    const match = chicken.id.match(/^chicken-(\d+)$/);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n);
  }
  nextChickenId = Math.max(nextChickenId, maxId + 1);
}

export function spawnInitialChickens(grid: Tile[][], count: number): Chicken[] {
  const chickens: Chicken[] = [];
  for (let i = 0; i < count; i++) {
    let x = 0;
    let y = 0;
    let attempts = 0;
    do {
      x = Math.floor(Math.random() * GRID_SIZE);
      y = Math.floor(Math.random() * GRID_SIZE);
      attempts++;
    } while (!isWalkable(grid, x, y) && attempts < 80);
    if (!isWalkable(grid, x, y)) continue;
    chickens.push({ id: `chicken-${nextChickenId++}`, x, y });
  }
  return chickens;
}

export function spawnChickensInRoom(grid: Tile[][], room: Room, count: number): Chicken[] {
  const chickens: Chicken[] = [];
  for (let i = 0; i < count; i++) {
    const candidates: Array<{ x: number; y: number }> = [];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (!isWalkable(grid, x, y)) continue;
        candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) break;
    const spot = candidates[Math.floor(Math.random() * candidates.length)];
    chickens.push({
      id: `chicken-${nextChickenId++}`,
      x: spot.x,
      y: spot.y,
      homePenId: room.id,
    });
  }
  return chickens;
}

export function tickChickens(chickens: Chicken[], grid: Tile[][], goblins: Goblin[], rooms?: Room[]): void {
  for (const chicken of chickens) {
    if (chicken.heldByGoblinId) {
      const carrier = goblins.find(g => g.alive && g.id === chicken.heldByGoblinId);
      if (carrier) {
        chicken.x = carrier.x;
        chicken.y = carrier.y;
        continue;
      }
      chicken.heldByGoblinId = undefined;
    }
    if ((chicken.moveCooldownTicks ?? 0) > 0) {
      chicken.moveCooldownTicks = (chicken.moveCooldownTicks ?? 0) - 1;
      continue;
    }
    if ((chicken.restTicks ?? 0) > 0) {
      chicken.restTicks = (chicken.restTicks ?? 0) - 1;
      continue;
    }

    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    const homePen = chicken.homePenId ? rooms?.find(r => r.id === chicken.homePenId && r.type === 'nursery_pen') : null;
    if (homePen && Math.random() < 0.005) {
      chicken.homePenId = undefined;
    }
    for (const dir of dirs) {
      const nx = chicken.x + dir.x;
      const ny = chicken.y + dir.y;
      if (homePen && chicken.homePenId && (nx < homePen.x || nx >= homePen.x + homePen.w || ny < homePen.y || ny >= homePen.y + homePen.h)) {
        continue;
      }
      if (!isWalkable(grid, nx, ny)) continue;
      chicken.x = nx;
      chicken.y = ny;
      chicken.moveCooldownTicks = Math.max(0, getTerrainMoveCost(grid[ny][nx].type) - 1);
      chicken.restTicks = 2 + Math.floor(Math.random() * 4);
      break;
    }
  }
}

export function countChickensInRoom(chickens: Chicken[], room: Room): number {
  if (room.type !== 'nursery_pen') return 0;
  let count = 0;
  for (const chicken of chickens) {
    if (chicken.heldByGoblinId) continue;
    if (chicken.x >= room.x && chicken.x < room.x + room.w && chicken.y >= room.y && chicken.y < room.y + room.h) {
      count++;
    }
  }
  return count;
}

const EGG_SPAWN_INTERVAL = 120;
const EGG_FOOD_VALUE = 24;
const MAX_EGGS_PER_PEN = 2;

function countEggsInPen(grid: Tile[][], room: Room): number {
  let n = 0;
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (grid[y]?.[x]?.type === TileType.Egg) n++;
    }
  }
  return n;
}

function collectEggSpawnCandidates(grid: Tile[][], room: Room): Array<{ x: number; y: number }> {
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      const tile = grid[y]?.[x];
      if (!tile || tile.type === TileType.Egg || !isWalkable(grid, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  return candidates;
}

function spawnEggAt(grid: Tile[][], x: number, y: number): void {
  const base = grid[y][x];
  grid[y][x] = {
    ...base,
    type: TileType.Egg,
    foodValue: EGG_FOOD_VALUE,
    maxFood: EGG_FOOD_VALUE,
    growbackRate: 0,
    materialValue: 0,
    maxMaterial: 0,
  };
}

export function tickNurseryPenEggs(chickens: Chicken[], rooms: Room[], grid: Tile[][], tick: number): void {
  if (tick % EGG_SPAWN_INTERVAL !== 0) return;
  for (const room of rooms) {
    if (room.type !== 'nursery_pen') continue;
    if (countChickensInRoom(chickens, room) < 2) continue;
    if (countEggsInPen(grid, room) >= MAX_EGGS_PER_PEN) continue;
    const candidates = collectEggSpawnCandidates(grid, room);
    if (candidates.length === 0) continue;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    spawnEggAt(grid, target.x, target.y);
  }
}
