/**
 * Player-placed rooms and stockpile expansion. Rooms let you define zones in Build mode; goblins
 * then expand stockpiles inside those bounds (see actions/stockpiling.ts, actions/building.ts).
 *
 * Placement: canPlaceRoom() validates a rectangle (no Water/Wall/Stone/Ore/Pool, no overlap).
 * Slots: findRoomStockpileSlot / findRoomStockpileSlotPreferClustering return a free walkable
 * tile in the room; clustering prefers tiles next to same-type piles so piles grow in blocks.
 * Expansion: when a pile in a room is full, another is added (clustered). Storage rooms have a
 * per-room cap; lumber hut and blacksmith have fixed caps (e.g. 3 wood / 3 ore). WorldTick
 * calls the expand functions each tick.
 */

import { GRID_SIZE } from '../shared/constants';
import type { Room, Tile, FoodStockpile, OreStockpile, WoodStockpile } from '../shared/types';
import { TileType, isWallType } from '../shared/types';

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

/** True if the rectangle (rx,ry,w,h) is in bounds, avoids Water/Wall/Stone/Ore/Pool, and does not overlap any existing room. */
export function canPlaceRoom(grid: Tile[][], rooms: Room[], rx: number, ry: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            const tx = rx + dx, ty = ry + dy;
            if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) return false;
            const t = grid[ty][tx];
            if (t.type === TileType.Water || isWallType(t.type)
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

/** Tile types we never clear (room furniture + tiles already blocked by canPlaceRoom). Everything else becomes Dirt so new ground types are cleared without listing them. */
function shouldNotClear(tileType: TileType): boolean {
    return tileType === TileType.Hearth
        || tileType === TileType.Water || tileType === TileType.Stone || tileType === TileType.Ore || tileType === TileType.Pool
        || isWallType(tileType);
}

/** Convert all ground tiles in the rectangle to Dirt, except those in shouldNotClear. Call before adding room-specific items (hearth, stockpiles). */
export function clearRoomGroundToDirt(grid: Tile[][], rx: number, ry: number, w: number, h: number): void {
    const cleanDirt: Tile = { type: TileType.Dirt, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0 };
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            const tx = rx + dx, ty = ry + dy;
            if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) continue;
            const t = grid[ty][tx];
            if (!shouldNotClear(t.type)) {
                grid[ty][tx] = { ...cleanDirt };
            }
        }
    }
}

function isWalkableInRoom(grid: Tile[][], tx: number, ty: number): boolean {
    if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) return false;
    const t = grid[ty][tx];
    return t.type !== TileType.Water && !isWallType(t.type);
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
    // Reserve room-center furniture tiles (saw/anvil) so stockpiles never overlap them.
    const blocked = new Set(occupied);
    if (room.type === 'lumber_hut' || room.type === 'blacksmith') {
        const fx = room.x + Math.floor(room.w / 2);
        const fy = room.y + Math.floor(room.h / 2);
        blocked.add(`${fx},${fy}`);
    }

    const tryTile = (tx: number, ty: number): { x: number; y: number } | null => {
        if (tx < room.x || tx >= room.x + room.w || ty < room.y || ty >= room.y + room.h) return null;
        const key = `${tx},${ty}`;
        if (blocked.has(key)) return null;
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
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);
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


/** Piles of any type whose position is inside the given room. Exported for use in stockpiling. */
export function pilesInRoom<T extends { x: number; y: number }>(
  room: Room,
  piles: T[],
): T[] {
  return piles.filter(s =>
    s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
}

/** For each storage room: if the last pile of a type in the room is full, add a new one (clustered). */
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
        const roomFood = pilesInRoom(room, foodStockpiles);
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
        const roomOre = pilesInRoom(room, oreStockpiles);
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
        const roomWood = pilesInRoom(room, woodStockpiles);
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

/** For each lumber_hut: if wood pile count < cap and last pile full, add one. */
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
    const roomWood = pilesInRoom(room, woodStockpiles);
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

/** For each blacksmith: if ore pile count < cap and last pile full, add one. */
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
    const roomOre = pilesInRoom(room, oreStockpiles);
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
