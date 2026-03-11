import { GRID_SIZE } from '../shared/constants';
import type { Room, Tile, FoodStockpile, OreStockpile, WoodStockpile } from '../shared/types';
import { TileType } from '../shared/types';

const MAX_STOCKPILES_PER_STORAGE_ROOM = 20;

/** Count total stockpiles (food + ore + wood) whose position is inside the given room. */
export function countStockpilesInRoom(
  room: Room,
  foodStockpiles: FoodStockpile[],
  oreStockpiles: OreStockpile[],
  woodStockpiles: WoodStockpile[],
): number {
  const inRoom = (x: number, y: number) =>
    x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
  const foodIn = foodStockpiles.filter(s => inRoom(s.x, s.y)).length;
  const oreIn = oreStockpiles.filter(s => inRoom(s.x, s.y)).length;
  const woodIn = woodStockpiles.filter(s => inRoom(s.x, s.y)).length;
  return foodIn + oreIn + woodIn;
}

export function canPlaceRoom(grid: Tile[][], rooms: Room[], rx: number, ry: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            const tx = rx + dx, ty = ry + dy;
            if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) return false;
            const t = grid[ty][tx];
            if (t.type === TileType.Water || t.type === TileType.Wall
                || t.type === TileType.Stone || t.type === TileType.Ore
                || t.type === TileType.Pool) return false;
        }
    }
    // Check overlap with existing rooms
    for (const r of rooms) {
        if (rx < r.x + r.w && rx + w > r.x && ry < r.y + r.h && ry + h > r.y) return false;
    }
    return true;
}

function isWalkableInRoom(grid: Tile[][], tx: number, ty: number): boolean {
    if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) return false;
    const t = grid[ty][tx];
    return t.type !== TileType.Water && t.type !== TileType.Wall;
}

export function findRoomStockpileSlot(
    grid: Tile[][],
    room: Room,
    occupied: Set<string>,
): { x: number; y: number } | null {
    return findRoomStockpileSlotPreferClustering(grid, room, occupied, []);
}

/** Prefer a tile adjacent to existing same-type piles; else fall back to spiral from center. */
export function findRoomStockpileSlotPreferClustering(
    grid: Tile[][],
    room: Room,
    occupied: Set<string>,
    sameTypeCoords: { x: number; y: number }[],
): { x: number; y: number } | null {
    const tryTile = (tx: number, ty: number): { x: number; y: number } | null => {
        if (tx < room.x || tx >= room.x + room.w || ty < room.y || ty >= room.y + room.h) return null;
        const key = `${tx},${ty}`;
        if (occupied.has(key)) return null;
        if (!isWalkableInRoom(grid, tx, ty)) return null;
        return { x: tx, y: ty };
    };

    // First: tiles adjacent to any same-type pile (within room)
    for (const p of sameTypeCoords) {
        for (const d of [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 }]) {
            const pos = tryTile(p.x + d.dx, p.y + d.dy);
            if (pos) return pos;
        }
    }

    // Fallback: spiral from center (original behavior)
    const cx = room.x + 2, cy = room.y + 2;
    for (let r = 0; r < 3; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                const pos = tryTile(cx + dx, cy + dy);
                if (pos) return pos;
            }
        }
    }
    return null;
}


function stockpilesInRoom<T extends { x: number; y: number }>(
  room: Room,
  piles: T[],
): T[] {
  return piles.filter(s =>
    s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
}

export function expandStockpilesInRooms(
    grid: Tile[][],
    rooms: Room[],
    foodStockpiles: FoodStockpile[],
    oreStockpiles: OreStockpile[],
    woodStockpiles: WoodStockpile[],
    onAddFood: (pile: FoodStockpile) => void,
    onAddOre: (pile: OreStockpile) => void,
    onAddWood: (pile: WoodStockpile) => void
) {
    const allOccupied = new Set([
        ...foodStockpiles.map(s => `${s.x},${s.y}`),
        ...oreStockpiles.map(s => `${s.x},${s.y}`),
        ...woodStockpiles.map(s => `${s.x},${s.y}`),
    ]);

    for (const room of rooms) {
        if (room.type !== 'storage') continue;
        const totalInRoom = countStockpilesInRoom(room, foodStockpiles, oreStockpiles, woodStockpiles);
        if (totalInRoom >= MAX_STOCKPILES_PER_STORAGE_ROOM) continue;

        // Food: if any food pile in room has last full, add one (clustered with existing food in room)
        const roomFood = stockpilesInRoom(room, foodStockpiles);
        const lastFood = roomFood[roomFood.length - 1];
        if (lastFood && lastFood.food >= lastFood.maxFood) {
            const sameTypeCoords = roomFood.map(s => ({ x: s.x, y: s.y }));
            const pos = findRoomStockpileSlotPreferClustering(grid, room, allOccupied, sameTypeCoords);
            if (pos) {
                const nd: FoodStockpile = { ...pos, food: 0, maxFood: 200 };
                foodStockpiles.push(nd);
                onAddFood(nd);
                allOccupied.add(`${pos.x},${pos.y}`);
                if (countStockpilesInRoom(room, foodStockpiles, oreStockpiles, woodStockpiles) >= MAX_STOCKPILES_PER_STORAGE_ROOM) continue;
            }
        }

        // Ore
        const roomOre = stockpilesInRoom(room, oreStockpiles);
        const lastOre = roomOre[roomOre.length - 1];
        if (lastOre && lastOre.ore >= lastOre.maxOre) {
            const sameTypeCoords = roomOre.map(s => ({ x: s.x, y: s.y }));
            const pos = findRoomStockpileSlotPreferClustering(grid, room, allOccupied, sameTypeCoords);
            if (pos) {
                const ns: OreStockpile = { ...pos, ore: 0, maxOre: 200 };
                oreStockpiles.push(ns);
                onAddOre(ns);
                allOccupied.add(`${pos.x},${pos.y}`);
                if (countStockpilesInRoom(room, foodStockpiles, oreStockpiles, woodStockpiles) >= MAX_STOCKPILES_PER_STORAGE_ROOM) continue;
            }
        }

        // Wood
        const roomWood = stockpilesInRoom(room, woodStockpiles);
        const lastWood = roomWood[roomWood.length - 1];
        if (lastWood && lastWood.wood >= lastWood.maxWood) {
            const sameTypeCoords = roomWood.map(s => ({ x: s.x, y: s.y }));
            const pos = findRoomStockpileSlotPreferClustering(grid, room, allOccupied, sameTypeCoords);
            if (pos) {
                const nw: WoodStockpile = { ...pos, wood: 0, maxWood: 200 };
                woodStockpiles.push(nw);
                onAddWood(nw);
                allOccupied.add(`${pos.x},${pos.y}`);
            }
        }
    }
}

const MAX_WOOD_IN_LUMBER_HUT = 3;
const MAX_ORE_IN_BLACKSMITH = 3;

export function expandLumberHutWoodStockpiles(
  grid: Tile[][],
  rooms: Room[],
  foodStockpiles: FoodStockpile[],
  oreStockpiles: OreStockpile[],
  woodStockpiles: WoodStockpile[],
  onAddWood: (pile: WoodStockpile) => void,
): void {
  const allOccupied = new Set([
    ...foodStockpiles.map(s => `${s.x},${s.y}`),
    ...oreStockpiles.map(s => `${s.x},${s.y}`),
    ...woodStockpiles.map(s => `${s.x},${s.y}`),
  ]);
  for (const room of rooms) {
    if (room.type !== 'lumber_hut') continue;
    const roomWood = stockpilesInRoom(room, woodStockpiles);
    if (roomWood.length >= MAX_WOOD_IN_LUMBER_HUT) continue;
    const last = roomWood[roomWood.length - 1];
    if (!last || last.wood < last.maxWood) continue;
    const sameTypeCoords = roomWood.map(s => ({ x: s.x, y: s.y }));
    const pos = findRoomStockpileSlotPreferClustering(grid, room, allOccupied, sameTypeCoords);
    if (pos) {
      const nw: WoodStockpile = { ...pos, wood: 0, maxWood: 200 };
      woodStockpiles.push(nw);
      onAddWood(nw);
      allOccupied.add(`${pos.x},${pos.y}`);
    }
  }
}

export function expandBlacksmithOreStockpiles(
  grid: Tile[][],
  rooms: Room[],
  foodStockpiles: FoodStockpile[],
  oreStockpiles: OreStockpile[],
  woodStockpiles: WoodStockpile[],
  onAddOre: (pile: OreStockpile) => void,
): void {
  const allOccupied = new Set([
    ...foodStockpiles.map(s => `${s.x},${s.y}`),
    ...oreStockpiles.map(s => `${s.x},${s.y}`),
    ...woodStockpiles.map(s => `${s.x},${s.y}`),
  ]);
  for (const room of rooms) {
    if (room.type !== 'blacksmith') continue;
    const roomOre = stockpilesInRoom(room, oreStockpiles);
    if (roomOre.length >= MAX_ORE_IN_BLACKSMITH) continue;
    const last = roomOre[roomOre.length - 1];
    if (!last || last.ore < last.maxOre) continue;
    const sameTypeCoords = roomOre.map(s => ({ x: s.x, y: s.y }));
    const pos = findRoomStockpileSlotPreferClustering(grid, room, allOccupied, sameTypeCoords);
    if (pos) {
      const ns: OreStockpile = { ...pos, ore: 0, maxOre: 200 };
      oreStockpiles.push(ns);
      onAddOre(ns);
    }
  }
}
