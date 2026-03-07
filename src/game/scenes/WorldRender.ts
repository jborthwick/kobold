import { TILE_SIZE, GRID_SIZE } from '../../shared/constants';
import { TileType } from '../../shared/types';
import type { Season } from '../../shared/types';
import { TILE_CONFIG, SPRITE_CONFIG } from '../tileConfig';
import type { WorldScene } from './WorldScene';

const SEASON_TINTS: Record<Season, number> = {
    spring: 0xddffcc,
    summer: 0xffffff,
    autumn: 0xffbb77,
    winter: 0xddddff,
};

const GOBLIN_FRAME = SPRITE_CONFIG.goblin;
const ADVENTURER_FRAME = SPRITE_CONFIG.adventurer;

export function drawFoodStockpile(scene: WorldScene) {
    for (let i = 0; i < scene.foodStockpiles.length; i++) {
        const d = scene.foodStockpiles[i];
        const gfx = scene.foodStockpileGfxList[i];
        if (!gfx) continue;
        const px = d.x * TILE_SIZE, py = d.y * TILE_SIZE;
        gfx.clear();
        gfx.lineStyle(2, 0xf0c040, 0.9);
        gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
}

export function drawOreStockpile(scene: WorldScene) {
    for (let i = 0; i < scene.oreStockpiles.length; i++) {
        const s = scene.oreStockpiles[i];
        const gfx = scene.oreStockpileGfxList[i];
        if (!gfx) continue;
        const px = s.x * TILE_SIZE, py = s.y * TILE_SIZE;
        gfx.clear();
        gfx.lineStyle(2, 0xff8800, 0.9);
        gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
}

export function drawWoodStockpile(scene: WorldScene) {
    for (let i = 0; i < scene.woodStockpiles.length; i++) {
        const w = scene.woodStockpiles[i];
        const gfx = scene.woodStockpileGfxList[i];
        if (!gfx) continue;
        const px = w.x * TILE_SIZE, py = w.y * TILE_SIZE;
        gfx.clear();
        gfx.lineStyle(2, 0x56d973, 0.9);  // green border — wood
        gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
}

export function drawMealStockpile(scene: WorldScene) {
    for (let i = 0; i < scene.mealStockpiles.length; i++) {
        const m = scene.mealStockpiles[i];
        const gfx = scene.mealStockpileGfxList[i];
        if (!gfx) continue;
        const px = m.x * TILE_SIZE, py = m.y * TILE_SIZE;
        gfx.clear();
        gfx.lineStyle(2, 0xff9900, 0.9);  // orange border — meals
        gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
}

export function drawTerrain(scene: WorldScene) {
    const OBJECT_TILES = new Set([
        TileType.Forest, TileType.Mushroom, TileType.Wall, TileType.Hearth, TileType.Fire,
    ]);

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const tile = scene.grid[y][x];
            const frames = TILE_CONFIG[tile.type] ?? [0];
            const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
            const noise = n - Math.floor(n);
            const frame = frames.length === 1
                ? frames[0]
                : frames[Math.floor(noise * frames.length)];

            const isObject = OBJECT_TILES.has(tile.type);
            const targetLayer = isObject ? scene.objectLayer : scene.floorLayer;
            const otherLayer = isObject ? scene.floorLayer : scene.objectLayer;

            const t = targetLayer.putTileAt(frame, x, y)!;
            otherLayer.removeTileAt(x, y);

            let baseTint = 0xffffff;
            if (tile.maxFood > 0) {
                const ratio = tile.foodValue / tile.maxFood;
                const brightness = Math.floor((0.5 + ratio * 0.5) * 255);
                baseTint = (brightness << 16) | (brightness << 8) | brightness;
            } else if (tile.type === TileType.Wall) {
                baseTint = 0x88aacc;
            } else if (tile.type === TileType.Hearth) {
                baseTint = 0xff8844;
            } else if (tile.type === TileType.Fire) {
                const phase = (scene.tick + x * 3 + y * 7) % 3;
                baseTint = phase === 0 ? 0xff2200 : phase === 1 ? 0xff6600 : 0xff4400;
            } else if (tile.type === TileType.Pool) {
                baseTint = 0x44bbaa;
            }

            const seasonTint = scene.weather?.season ? SEASON_TINTS[scene.weather.season] : 0xffffff;

            const isVegetation = tile.type === TileType.Dirt || tile.type === TileType.Grass || tile.type === TileType.Forest || tile.type === TileType.Farmland || tile.type === TileType.TreeStump;
            if (isVegetation && seasonTint !== 0xffffff) {
                const br = (baseTint >> 16) & 0xff, bg = (baseTint >> 8) & 0xff, bb = baseTint & 0xff;
                const sr = (seasonTint >> 16) & 0xff, sg = (seasonTint >> 8) & 0xff, sb = seasonTint & 0xff;
                t.tint = (((br * sr) >> 8) << 16) | (((bg * sg) >> 8) << 8) | ((bb * sb) >> 8);
            } else {
                t.tint = baseTint;
            }

            if (isObject) {
                const dirtFrames = TILE_CONFIG[TileType.Dirt] ?? [0];
                const dt = scene.floorLayer.putTileAt(dirtFrames[0], x, y);
                if (dt && seasonTint !== 0xffffff) {
                    dt.tint = seasonTint;
                }
            }

            for (const room of scene.rooms) {
                if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) {
                    const roomTint = room.type === 'kitchen' ? 0xffbb88
                        : room.specialization === 'food' ? 0xccffcc
                            : room.specialization === 'ore' ? 0xffddaa
                                : room.specialization === 'wood' ? 0xddffcc
                                    : 0xccccff;
                    const tr = (t.tint >> 16) & 0xff, tg = (t.tint >> 8) & 0xff, tb = t.tint & 0xff;
                    const rr = (roomTint >> 16) & 0xff, rg = (roomTint >> 8) & 0xff, rb = roomTint & 0xff;
                    t.tint = (((tr * rr) >> 8) << 16) | (((tg * rg) >> 8) << 8) | ((tb * rb) >> 8);
                    break;
                }
            }
        }
    }
}

export function drawOverlay(scene: WorldScene) {
    scene.overlayGfx.clear();
    scene.ambientGfx.clear();

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const tile = scene.grid[y][x];
            let ambientAlpha = 0;
            let ambientColor = 0;

            const w = scene.warmthField[y * GRID_SIZE + x];
            const d = scene.dangerField[y * GRID_SIZE + x];

            if (w > 0) {
                ambientAlpha = Math.pow(w / 100, 2) * 0.5;
                ambientColor = 0xff6600;
            } else if (d > 0) {
                ambientAlpha = Math.pow(d / 100, 2) * 0.5;
                ambientColor = 0xff2222;
            }

            if (ambientAlpha > 0.02) {
                scene.ambientGfx.fillStyle(ambientColor, ambientAlpha);
                scene.ambientGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }

            if (scene.overlayMode === 'off') continue;

            let tacticalAlpha = 0;
            let tacticalColor = 0;

            if (scene.overlayMode === 'food' && tile.maxFood > 0) {
                tacticalAlpha = (tile.foodValue / tile.maxFood) * 0.65;
                tacticalColor = 0x00dd44;
            } else if (scene.overlayMode === 'material' && tile.maxMaterial > 0 && tile.type !== TileType.Forest) {
                tacticalAlpha = (tile.materialValue / tile.maxMaterial) * 0.65;
                tacticalColor = 0xff8800;
            } else if (scene.overlayMode === 'wood' && tile.type === TileType.Forest && tile.maxMaterial > 0) {
                tacticalAlpha = (tile.materialValue / tile.maxMaterial) * 0.65;
                tacticalColor = 0x56d973;
            } else if (scene.overlayMode === 'warmth') {
                if (w > 0) { tacticalAlpha = (w / 100) * 0.5; tacticalColor = 0xff6600; }
            } else if (scene.overlayMode === 'danger') {
                if (d > 0) { tacticalAlpha = (d / 100) * 0.5; tacticalColor = 0xff2222; }
            } else if (scene.overlayMode === 'traffic') {
                const tr = tile.trafficScore ?? 0;
                if (tr > 0) { tacticalAlpha = (tr / 100) * 0.6; tacticalColor = 0xffee00; }
            }

            if (tacticalAlpha > 0.02) {
                scene.overlayGfx.fillStyle(tacticalColor, tacticalAlpha);
                scene.overlayGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }
        }
    }
}

export function drawOffScreenIndicator(scene: WorldScene) {
    scene.offScreenGfx.clear();
    if (!scene.selectedGoblinId) return;

    const d = scene.goblins.find(dw => dw.id === scene.selectedGoblinId && dw.alive);
    if (!d) return;

    const cam = scene.cameras.main;
    const view = cam.worldView;

    const sx = (d.x * TILE_SIZE + TILE_SIZE / 2 - view.x) * cam.zoom;
    const sy = (d.y * TILE_SIZE + TILE_SIZE / 2 - view.y) * cam.zoom;

    const margin = 24;
    const sw = cam.width;
    const sh = cam.height;

    if (sx >= margin && sx <= sw - margin && sy >= margin && sy <= sh - margin) return;

    const cx = sw / 2;
    const cy = sh / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = dx / len;
    const ny = dy / len;

    const scaleX = Math.abs(nx) > 0.001 ? (nx > 0 ? (sw - margin - cx) : (cx - margin)) / Math.abs(dx) : Infinity;
    const scaleY = Math.abs(ny) > 0.001 ? (ny > 0 ? (sh - margin - cy) : (cy - margin)) / Math.abs(dy) : Infinity;
    const t = Math.min(scaleX, scaleY);
    const ax = cx + dx * t;
    const ay = cy + dy * t;

    const angle = Math.atan2(ny, nx);
    const tipSize = 10;
    const baseHalf = 6;
    const tx0 = ax + Math.cos(angle) * tipSize;
    const ty0 = ay + Math.sin(angle) * tipSize;
    const tx1 = ax + Math.cos(angle + Math.PI * 0.7) * baseHalf;
    const ty1 = ay + Math.sin(angle + Math.PI * 0.7) * baseHalf;
    const tx2 = ax + Math.cos(angle - Math.PI * 0.7) * baseHalf;
    const ty2 = ay + Math.sin(angle - Math.PI * 0.7) * baseHalf;

    scene.offScreenGfx.fillStyle(0xffff00, 0.85);
    scene.offScreenGfx.fillTriangle(tx0, ty0, tx1, ty1, tx2, ty2);
    scene.offScreenGfx.lineStyle(1, 0x888800, 0.5);
    scene.offScreenGfx.strokeTriangle(tx0, ty0, tx1, ty1, tx2, ty2);
}

export function drawAgents(scene: WorldScene) {
    scene.selectionGfx.clear();

    const TOMBSTONE_FRAME = SPRITE_CONFIG.tombstone ?? GOBLIN_FRAME;
    for (const [id, spr] of scene.goblinSprites) {
        const d = scene.goblins.find(dw => dw.id === id);
        if (!d || !d.alive) {
            if (!scene.goblinGhostSprites.has(id)) {
                const ghost = scene.add.sprite(spr.x, spr.y, 'tiles', TOMBSTONE_FRAME).setDepth(4);
                ghost.setTint(0xaaaaaa);
                scene.goblinGhostSprites.set(id, ghost);
            }
            spr.destroy();
            scene.goblinSprites.delete(id);
        }
    }

    for (const [id, spr] of scene.goblinGhostSprites) {
        if (id === scene.selectedGoblinId) {
            scene.selectionGfx.lineStyle(2, 0xff4444, 0.85);
            scene.selectionGfx.strokeCircle(spr.x, spr.y, TILE_SIZE / 2 + 3);
        }
    }

    for (const d of scene.goblins) {
        if (!d.alive) continue;

        const px = d.x * TILE_SIZE + TILE_SIZE / 2;
        const py = d.y * TILE_SIZE + TILE_SIZE / 2;

        let spr = scene.goblinSprites.get(d.id);
        if (!spr) {
            spr = scene.add.sprite(px, py, 'tiles', GOBLIN_FRAME).setDepth(5);
            scene.goblinSprites.set(d.id, spr);
        } else {
            spr.setPosition(px, py);
        }

        if (d.onFire) {
            const phase = (scene.tick + parseInt(d.id, 36)) % 3;
            spr.setTint(phase === 0 ? 0xff2200 : phase === 1 ? 0xff6600 : 0xff4400);
        } else {
            const hr = d.hunger / 100;
            const r = Math.floor(60 + hr * 195);
            const g = Math.floor(200 - hr * 150);
            spr.setTint((r << 16) | (g << 8) | 60);
        }

        if (d.id === scene.selectedGoblinId) {
            scene.selectionGfx.lineStyle(2, 0xffff00, 1);
            scene.selectionGfx.strokeCircle(px, py, TILE_SIZE / 2 + 3);
        }

        if (d.commandTarget) {
            scene.selectionGfx.lineStyle(1, 0x00ffff, 0.7);
            scene.selectionGfx.strokeCircle(px, py, TILE_SIZE / 2 + 1);
        }
    }

    for (const g of scene.adventurers) {
        const px = g.x * TILE_SIZE + TILE_SIZE / 2;
        const py = g.y * TILE_SIZE + TILE_SIZE / 2;
        let spr = scene.adventurerSprites.get(g.id);
        if (!spr) {
            spr = scene.add.sprite(px, py, 'tiles', ADVENTURER_FRAME).setDepth(5);
            spr.setTint(0xff6600);
            scene.adventurerSprites.set(g.id, spr);
        } else {
            spr.setPosition(px, py);
        }
    }
}
