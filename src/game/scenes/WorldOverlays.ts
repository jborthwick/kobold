import * as Phaser from 'phaser';
import { canPlaceRoom } from '../../simulation/rooms';
import type { Tile, Room, RoomType } from '../../shared/types';
import { TILE_SIZE } from '../../shared/constants';
import { getRoomDims } from '../../shared/roomConfig';

export function drawBuildPreview(
    gfx: Phaser.GameObjects.Graphics,
    buildMode: RoomType | null,
    buildPreview: { x: number; y: number } | null,
    grid: Tile[][],
    rooms: Room[]
) {
    gfx.clear();
    if (!buildMode || !buildPreview) return;
    const { x, y } = buildPreview;
    const { w, h } = getRoomDims(buildMode);
    const valid = canPlaceRoom(grid, rooms, x, y, w, h);
    const color = valid ? 0x00ff00 : 0xff0000;
    const alpha = 0.3;
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            gfx.fillStyle(color, alpha);
            gfx.fillRect((x + dx) * TILE_SIZE, (y + dy) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
    }
    // Outline
    gfx.lineStyle(1, color, 0.7);
    gfx.strokeRect(x * TILE_SIZE, y * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE);
}

export function drawFlag(
    gfx: Phaser.GameObjects.Graphics,
    commandTile: { x: number; y: number } | null
) {
    gfx.clear();
    if (!commandTile) return;
    const px = commandTile.x * TILE_SIZE;
    const py = commandTile.y * TILE_SIZE;
    gfx.lineStyle(2, 0xffff00, 0.9);
    gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    // Inner X
    gfx.lineStyle(1, 0xffff00, 0.5);
    gfx.lineBetween(px + 2, py + 2, px + TILE_SIZE - 2, py + TILE_SIZE - 2);
    gfx.lineBetween(px + TILE_SIZE - 2, py + 2, px + 2, py + TILE_SIZE - 2);
}
