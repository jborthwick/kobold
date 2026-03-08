import { GRID_SIZE } from '../shared/constants';
import type { Room, Tile, FoodStockpile, OreStockpile, WoodStockpile } from '../shared/types';
import { TileType } from '../shared/types';

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

export function findRoomStockpileSlot(
    grid: Tile[][],
    room: Room,
    occupied: Set<string>,
): { x: number; y: number } | null {
    const cx = room.x + 2, cy = room.y + 2;
    // Spiral outward from center within room bounds
    for (let r = 0; r < 3; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // perimeter only
                const tx = cx + dx, ty = cy + dy;
                if (tx < room.x || tx >= room.x + room.w) continue;
                if (ty < room.y || ty >= room.y + room.h) continue;
                const key = `${tx},${ty}`;
                if (occupied.has(key)) continue;
                if (grid[ty][tx].type === TileType.Water || grid[ty][tx].type === TileType.Wall) continue;
                return { x: tx, y: ty };
            }
        }
    }
    return null;
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
        if (!room.specialization) continue;

        if (room.specialization === 'food') {
            const roomPiles = foodStockpiles.filter(s =>
                s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
            const last = roomPiles[roomPiles.length - 1];
            if (last && last.food >= last.maxFood) {
                const pos = findRoomStockpileSlot(grid, room, allOccupied);
                if (pos) {
                    const nd: FoodStockpile = { ...pos, food: 0, maxFood: 200 };
                    foodStockpiles.push(nd);
                    onAddFood(nd);
                    allOccupied.add(`${pos.x},${pos.y}`);
                }
            }
        } else if (room.specialization === 'ore') {
            const roomPiles = oreStockpiles.filter(s =>
                s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
            const last = roomPiles[roomPiles.length - 1];
            if (last && last.ore >= last.maxOre) {
                const pos = findRoomStockpileSlot(grid, room, allOccupied);
                if (pos) {
                    const ns: OreStockpile = { ...pos, ore: 0, maxOre: 200 };
                    oreStockpiles.push(ns);
                    onAddOre(ns);
                    allOccupied.add(`${pos.x},${pos.y}`);
                }
            }
        } else if (room.specialization === 'wood') {
            const roomPiles = woodStockpiles.filter(s =>
                s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
            const last = roomPiles[roomPiles.length - 1];
            if (last && last.wood >= last.maxWood) {
                const pos = findRoomStockpileSlot(grid, room, allOccupied);
                if (pos) {
                    const nw: WoodStockpile = { ...pos, wood: 0, maxWood: 200 };
                    woodStockpiles.push(nw);
                    onAddWood(nw);
                    allOccupied.add(`${pos.x},${pos.y}`);
                }
            }
        }
    }
}
