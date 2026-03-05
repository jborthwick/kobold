/**
 * Fort-building: wall-slot candidates for H-shaped fort and south enclosure bar.
 * See: fortWallSlots, fortEnclosureSlots.
 */

import { TileType, type Goblin, type Tile, type Adventurer } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';

export function fortWallSlots(
  foodStockpiles: Array<{ x: number; y: number }>,
  oreStockpiles:  Array<{ x: number; y: number }>,
  grid:           Tile[][],
  goblins:        Goblin[] | undefined,
  selfId:         string,
  adventurers?:  Adventurer[],
): Array<{ x: number; y: number }> {
  const MARGIN = 2;
  const slots: Array<{ x: number; y: number }> = [];

  const blocked = (x: number, y: number): boolean => {
    if (goblins?.some(d => d.alive && d.id !== selfId && d.x === x && d.y === y)) return true;
    if (adventurers?.some(g => g.x === x && g.y === y)) return true;
    return false;
  };

  const tryAdd = (x: number, y: number): void => {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    const t = grid[y][x];
    if (t.type === TileType.Wall || t.type === TileType.Water || t.type === TileType.Ore) return;
    if (!blocked(x, y)) slots.push({ x, y });
  };

  const anchorD = foodStockpiles[0];
  const anchorS = oreStockpiles[0];
  const COL_STEP = 1;
  const ROW_STEP = 1;
  const ROOM_COLS = 3;
  const ROOM_ROWS = 3;
  const foodLeft = anchorD.x < anchorS.x;
  const dExpDir = foodLeft ? -1 : 1;
  const sExpDir = foodLeft ? 1 : -1;

  const dMinX = Math.min(anchorD.x, anchorD.x + dExpDir * (ROOM_COLS - 1) * COL_STEP) - MARGIN;
  const dMaxX = Math.max(anchorD.x, anchorD.x + dExpDir * (ROOM_COLS - 1) * COL_STEP) + MARGIN;
  const dMinY = anchorD.y - MARGIN;
  const dMaxY = Math.max(
    anchorD.y + (ROOM_ROWS - 1) * ROW_STEP + MARGIN,
    Math.max(...foodStockpiles.map(d => d.y)) + MARGIN,
  );
  for (let y = dMinY; y <= dMaxY; y++) {
    for (let x = dMinX; x <= dMaxX; x++) {
      if (x !== dMinX && x !== dMaxX && y !== dMinY && y !== dMaxY) continue;
      if (y === dMaxY && x === anchorD.x) continue;
      if (foodStockpiles.some(d => d.x === x && d.y === y)) continue;
      tryAdd(x, y);
    }
  }

  const sMinX = Math.min(anchorS.x, anchorS.x + sExpDir * (ROOM_COLS - 1) * COL_STEP) - MARGIN;
  const sMaxX = Math.max(anchorS.x, anchorS.x + sExpDir * (ROOM_COLS - 1) * COL_STEP) + MARGIN;
  const sMinY = anchorS.y - MARGIN;
  const sMaxY = Math.max(
    anchorS.y + (ROOM_ROWS - 1) * ROW_STEP + MARGIN,
    Math.max(...oreStockpiles.map(s => s.y)) + MARGIN,
  );
  for (let y = sMinY; y <= sMaxY; y++) {
    for (let x = sMinX; x <= sMaxX; x++) {
      if (x !== sMinX && x !== sMaxX && y !== sMinY && y !== sMaxY) continue;
      if (y === sMaxY && x === anchorS.x) continue;
      if (oreStockpiles.some(s => s.x === x && s.y === y)) continue;
      tryAdd(x, y);
    }
  }

  const topY = Math.min(dMinY, sMinY);
  const barXmin = dMaxX + 1;
  const barXmax = sMinX - 1;
  for (let x = barXmin; x <= barXmax; x++) tryAdd(x, topY);

  return slots;
}

export function fortEnclosureSlots(
  foodStockpiles: Array<{ x: number; y: number }>,
  oreStockpiles:  Array<{ x: number; y: number }>,
  grid:           Tile[][],
  goblins:        Goblin[] | undefined,
  selfId:         string,
  adventurers?:  Adventurer[],
): Array<{ x: number; y: number }> {
  const MARGIN = 2;
  const dMaxX = Math.max(...foodStockpiles.map(d => d.x)) + MARGIN;
  const dMaxY = Math.max(...foodStockpiles.map(d => d.y)) + MARGIN;
  const sMinX = Math.min(...oreStockpiles.map(s => s.x)) - MARGIN;
  const sMaxY = Math.max(...oreStockpiles.map(s => s.y)) + MARGIN;
  const barXmin = dMaxX + 1;
  const barXmax = sMinX - 1;
  if (barXmin > barXmax) return [];

  const southY = Math.max(dMaxY, sMaxY);
  const doorX = Math.floor((barXmin + barXmax) / 2);

  const blocked = (x: number, y: number): boolean => {
    if (goblins?.some(d => d.alive && d.id !== selfId && d.x === x && d.y === y)) return true;
    if (adventurers?.some(g => g.x === x && g.y === y)) return true;
    return false;
  };

  const slots: Array<{ x: number; y: number }> = [];
  for (let x = barXmin; x <= barXmax; x++) {
    if (x === doorX) continue;
    if (x < 0 || x >= GRID_SIZE || southY < 0 || southY >= GRID_SIZE) continue;
    const t = grid[southY][x];
    if (t.type === TileType.Wall || t.type === TileType.Water || t.type === TileType.Ore) continue;
    if (!blocked(x, southY)) slots.push({ x, y: southY });
  }
  return slots;
}
