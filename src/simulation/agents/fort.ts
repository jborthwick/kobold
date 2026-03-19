/**
 * Room-based wall building: generates wall positions on the perimeter ring
 * around player-placed rooms. Leaves doorway gaps at center of each side.
 *
 * Outdoor rooms (e.g. farm) are never fortified — use fortifiableRoomWallSlots for wall intent.
 * roomWallSlots is an alias of fortifiableRoomWallSlots for backward compatibility.
 */

import { TileType, type Goblin, type Tile, type Adventurer, type Room } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { isOutdoorRoomType } from '../../shared/roomConfig';

/** Tile types that are valid for placing a wall (whitelist). */
const WALLABLE_TILES = new Set<TileType>([
  TileType.Dirt,
  TileType.Grass,
  TileType.Forest,
  TileType.Farmland,
  TileType.Mushroom,
  TileType.TreeStump,
]);

/** True if a tile type can accept a built wall segment (before it becomes WoodWall/StoneWall). */
export function isWallSlotTerrain(type: TileType): boolean {
  return WALLABLE_TILES.has(type);
}

/** Rooms that should get perimeter walls (excludes outdoor zones like farm). */
export function fortifiableRooms(rooms: Room[]): Room[] {
  return rooms.filter(r => !isOutdoorRoomType(r.type));
}

function collectPerimeterWallSlots(
  rooms: Room[],
  grid: Tile[][],
  goblins: Goblin[] | undefined,
  selfId: string,
  adventurers?: Adventurer[],
): Array<{ x: number; y: number }> {
  const slots: Array<{ x: number; y: number }> = [];
  const added = new Set<string>();

  const blocked = (x: number, y: number): boolean => {
    if (goblins?.some(d => d.alive && d.id !== selfId && d.x === x && d.y === y)) return true;
    if (adventurers?.some(g => g.x === x && g.y === y)) return true;
    return false;
  };

  const tryAdd = (x: number, y: number): void => {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    const key = `${x},${y}`;
    if (added.has(key)) return;
    const t = grid[y][x];
    if (!WALLABLE_TILES.has(t.type)) return;
    if (blocked(x, y)) return;
    added.add(key);
    slots.push({ x, y });
  };

  for (const room of rooms) {
    const doorTop = { x: room.x + 2, y: room.y - 1 };
    const doorBottom = { x: room.x + 2, y: room.y + room.h };
    const doorLeft = { x: room.x - 1, y: room.y + 2 };
    const doorRight = { x: room.x + room.w, y: room.y + 2 };
    const isDoor = (x: number, y: number): boolean =>
      (x === doorTop.x && y === doorTop.y) ||
      (x === doorBottom.x && y === doorBottom.y) ||
      (x === doorLeft.x && y === doorLeft.y) ||
      (x === doorRight.x && y === doorRight.y);

    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!isDoor(x, room.y - 1)) tryAdd(x, room.y - 1);
    }
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!isDoor(x, room.y + room.h)) tryAdd(x, room.y + room.h);
    }
    for (let y = room.y; y < room.y + room.h; y++) {
      if (!isDoor(room.x - 1, y)) tryAdd(room.x - 1, y);
    }
    for (let y = room.y; y < room.y + room.h; y++) {
      if (!isDoor(room.x + room.w, y)) tryAdd(room.x + room.w, y);
    }
  }

  return slots;
}

/**
 * Wall slots for fortifiable rooms only (kitchen, storage, lumber hut, blacksmith).
 * Outdoor rooms such as farm are excluded — no wall-building intent there.
 */
export function fortifiableRoomWallSlots(
  rooms: Room[],
  grid: Tile[][],
  goblins: Goblin[] | undefined,
  selfId: string,
  adventurers?: Adventurer[],
): Array<{ x: number; y: number }> {
  return collectPerimeterWallSlots(fortifiableRooms(rooms), grid, goblins, selfId, adventurers);
}

/**
 * Same as fortifiableRoomWallSlots. Kept for call sites that predate the explicit name.
 */
export function roomWallSlots(
  rooms: Room[],
  grid: Tile[][],
  goblins: Goblin[] | undefined,
  selfId: string,
  adventurers?: Adventurer[],
): Array<{ x: number; y: number }> {
  return fortifiableRoomWallSlots(rooms, grid, goblins, selfId, adventurers);
}

// Keep old exports as aliases for backward compat (headless sim, goal progress)
export function fortWallSlots(): Array<{ x: number; y: number }> {
  return [];
}

export function fortEnclosureSlots(): Array<{ x: number; y: number }> {
  return [];
}
