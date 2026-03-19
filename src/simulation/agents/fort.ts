/**
 * Room-based wall building: generates wall positions on the perimeter ring
 * around player-placed rooms. Leaves doorway gaps at center of each side.
 *
 * Legacy fortWallSlots/fortEnclosureSlots replaced by roomWallSlots.
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

/**
 * Generate wall positions for all rooms. Walls go on the perimeter ring around each room interior.
 * 4 doorways (center of each side) are excluded. Only tiles in WALLABLE_TILES are valid slots.
 */
export function roomWallSlots(
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
    if (isOutdoorRoomType(room.type)) continue;
    // Doorway positions (center of each side, in perimeter ring)
    const doorTop = { x: room.x + 2, y: room.y - 1 };
    const doorBottom = { x: room.x + 2, y: room.y + room.h };
    const doorLeft = { x: room.x - 1, y: room.y + 2 };
    const doorRight = { x: room.x + room.w, y: room.y + 2 };
    const isDoor = (x: number, y: number): boolean =>
      (x === doorTop.x && y === doorTop.y) ||
      (x === doorBottom.x && y === doorBottom.y) ||
      (x === doorLeft.x && y === doorLeft.y) ||
      (x === doorRight.x && y === doorRight.y);

    // Top row: y = room.y - 1, x from room.x - 1 to room.x + room.w
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!isDoor(x, room.y - 1)) tryAdd(x, room.y - 1);
    }
    // Bottom row: y = room.y + room.h
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      if (!isDoor(x, room.y + room.h)) tryAdd(x, room.y + room.h);
    }
    // Left column: x = room.x - 1 (excluding corners already done)
    for (let y = room.y; y < room.y + room.h; y++) {
      if (!isDoor(room.x - 1, y)) tryAdd(room.x - 1, y);
    }
    // Right column: x = room.x + room.w
    for (let y = room.y; y < room.y + room.h; y++) {
      if (!isDoor(room.x + room.w, y)) tryAdd(room.x + room.w, y);
    }
  }

  return slots;
}

// Keep old exports as aliases for backward compat (headless sim, goal progress)
export function fortWallSlots(): Array<{ x: number; y: number }> {
  return [];
}

export function fortEnclosureSlots(): Array<{ x: number; y: number }> {
  return [];
}
