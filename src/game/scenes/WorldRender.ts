import { TILE_SIZE, GRID_SIZE } from '../../shared/constants';
import { TileType, isWall } from '../../shared/types';
import type { Season } from '../../shared/types';
import { TILE_CONFIG, SPRITE_CONFIG } from '../tileConfig';
import type { WorkCategoryId } from '../../simulation/workerTargets';
import type { WorldScene } from './WorldScene';
import { dayNightVisualStrength } from '../../simulation/weather';
import { ambientGlowDebug, computeAmbientGlowOverlayCompensation } from '../../debug/ambientGlowDebug';

const GOBLIN_JOB_SPRITE_KEYS: Record<WorkCategoryId, keyof typeof SPRITE_CONFIG> = {
  foraging: 'goblinForaging',
  cooking: 'goblinCooking',
  mining: 'goblinMining',
  woodcutting: 'goblinWoodcutting',
  sawing: 'goblinSawing',
  smithing: 'goblinSmithing',
};

function getGoblinFrame(assignedJob: WorkCategoryId | null | undefined): number {
  const key = assignedJob ? GOBLIN_JOB_SPRITE_KEYS[assignedJob] : 'goblin';
  return SPRITE_CONFIG[key] ?? GOBLIN_FRAME;
}

const SEASON_TINTS: Record<Season, number> = {
    spring: 0xddffcc,
    summer: 0xffffff,
    autumn: 0xffbb77,
    winter: 0xddddff,
};

const GOBLIN_FRAME = SPRITE_CONFIG.goblin;
const ADVENTURER_FRAME = SPRITE_CONFIG.adventurer;
const CHICKEN_FRAME = SPRITE_CONFIG.chicken;
/** Tiles drawn on the object layer (depth 2) with optional dirt underlay on floor. Forest stays on floor (depth 0) with stone/grass/dirt. */
const OBJECT_TILES = new Set([
    TileType.Mushroom, TileType.Wall, TileType.WoodWall, TileType.StoneWall, TileType.Hearth, TileType.Fire,
    TileType.CropGrowing, TileType.CropRipe, TileType.Egg,
]);

type StockpileCell = { x: number; y: number };

type OverlayColors = {
    ambientAlpha: number;
    ambientColor: number;
    tacticalAlpha: number;
    tacticalColor: number;
};

function multiplyTint(baseTint: number, overlayTint: number): number {
    const br = (baseTint >> 16) & 0xff;
    const bg = (baseTint >> 8) & 0xff;
    const bb = baseTint & 0xff;
    const or = (overlayTint >> 16) & 0xff;
    const og = (overlayTint >> 8) & 0xff;
    const ob = overlayTint & 0xff;
    return (((br * or) >> 8) << 16) | (((bg * og) >> 8) << 8) | ((bb * ob) >> 8);
}

function isVegetationTile(type: TileType): boolean {
    return (
        type === TileType.Dirt
        || type === TileType.Grass
        || type === TileType.Forest
        || type === TileType.Farmland
        || type === TileType.TreeStump
        || type === TileType.CropGrowing
        || type === TileType.CropRipe
    );
}

function getSeasonTint(scene: WorldScene): number {
    return scene.weather?.season ? SEASON_TINTS[scene.weather.season] : 0xffffff;
}

function getBaseTileTint(scene: WorldScene, tile: WorldScene['grid'][number][number], x: number, y: number): number {
    if (tile.maxFood > 0) {
        const ratio = tile.foodValue / tile.maxFood;
        const brightness = Math.floor((0.5 + ratio * 0.5) * 255);
        return (brightness << 16) | (brightness << 8) | brightness;
    }
    if (isWall(tile)) return 0x88aacc;
    if (tile.type === TileType.Hearth) return (tile.hearthFuel ?? 0) > 0 ? 0xff8844 : 0x555555;
    if (tile.type === TileType.Fire) {
        const phase = (scene.tick + x * 3 + y * 7) % 3;
        return phase === 0 ? 0xff2200 : phase === 1 ? 0xff6600 : 0xff4400;
    }
    if (tile.type === TileType.Pool) return 0x44bbaa;
    return 0xffffff;
}

function tintForRoom(scene: WorldScene, room: WorldScene['rooms'][number]): number {
    if (room.type === 'kitchen') return 0xffbb88;
    if (room.type === 'farm') return 0xccff99;
    if (room.type === 'nursery_pen') return 0xfff2aa;
    if (room.type === 'burrow') return 0xd6c0ff;
    if (room.type === 'lumber_hut') return 0xddffcc;
    if (room.type === 'blacksmith') return 0xffddaa;
    if (room.type !== 'storage') return 0xccccff;

    const inRoom = (px: number, py: number) =>
        px >= room.x && px < room.x + room.w && py >= room.y && py < room.y + room.h;
    const hasFood = scene.foodStockpiles.some(s => inRoom(s.x, s.y));
    const hasOre = scene.oreStockpiles.some(s => inRoom(s.x, s.y));
    const hasWood = scene.woodStockpiles.some(s => inRoom(s.x, s.y));
    if (hasFood && !hasOre && !hasWood) return 0xccffcc;
    if (hasOre && !hasFood && !hasWood) return 0xffddaa;
    if (hasWood && !hasFood && !hasOre) return 0xddffcc;
    if (hasFood || hasOre || hasWood) return 0xddddff;
    return 0xccccff;
}

function roomTintAt(scene: WorldScene, x: number, y: number): number | null {
    for (const room of scene.rooms) {
        if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) {
            return tintForRoom(scene, room);
        }
    }
    return null;
}

function drawStockpileBoxes(
    stockpiles: StockpileCell[],
    gfxList: Phaser.GameObjects.Graphics[],
    color: number,
) {
    for (let i = 0; i < stockpiles.length; i++) {
        const cell = stockpiles[i];
        const gfx = gfxList[i];
        if (!gfx) continue;
        const px = cell.x * TILE_SIZE;
        const py = cell.y * TILE_SIZE;
        gfx.clear();
        gfx.lineStyle(2, color, 0.9);
        gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
}

/** Hearth & fire tiles: ADD glow is drawn on top of the sprite — soften α on the source cell only. */
function warmthSourceTileGlowMult(tile: WorldScene['grid'][number][number], warmth: number): number {
    if (warmth <= 0) return 1;
    if (tile.type !== TileType.Hearth && tile.type !== TileType.Fire) return 1;
    return ambientGlowDebug.sourceWarmthTileMult;
}

function warmthSourceTileNightBoostMult(tile: WorldScene['grid'][number][number], warmth: number): number {
    if (warmth <= 0) return 1;
    if (tile.type !== TileType.Hearth && tile.type !== TileType.Fire) return 1;
    return ambientGlowDebug.sourceNightBoostTileMult;
}

function computeOverlayColors(
    scene: WorldScene,
    tile: WorldScene['grid'][number][number],
    warmth: number,
    danger: number,
): OverlayColors {
    let ambientAlpha = 0;
    let ambientColor = 0;
    // Alphas tuned for ambientGfx; default blend is ADD (reads brighter than same alpha in NORMAL).
    const g = ambientGlowDebug;
    if (warmth > 0) {
        ambientAlpha = Math.pow(warmth / 100, g.warmthPow) * g.warmthMult;
        ambientColor = 0xff6600;
    } else if (danger > 0) {
        ambientAlpha = Math.pow(danger / 100, g.dangerPow) * g.dangerMult;
        ambientColor = 0xff2222;
    }

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
        if (warmth > 0) {
            tacticalAlpha = (warmth / 100) * 0.5;
            tacticalColor = 0xff6600;
        }
    } else if (scene.overlayMode === 'danger') {
        if (danger > 0) {
            tacticalAlpha = (danger / 100) * 0.5;
            tacticalColor = 0xff2222;
        }
    } else if (scene.overlayMode === 'traffic') {
        const traffic = tile.trafficScore ?? 0;
        if (traffic > 0) {
            const normalized = Phaser.Math.Clamp(traffic / 100, 0, 1);
            tacticalAlpha = 0.05 + 0.7 * Math.pow(normalized, 0.6);
            tacticalColor = 0xffee00;
        }
    }

    return { ambientAlpha, ambientColor, tacticalAlpha, tacticalColor };
}

/** Same ring as living selected goblins — tile center, world space. */
function strokeYellowSelectionRing(gfx: Phaser.GameObjects.Graphics, tileX: number, tileY: number) {
    const cx = tileX * TILE_SIZE + TILE_SIZE / 2;
    const cy = tileY * TILE_SIZE + TILE_SIZE / 2;
    gfx.lineStyle(2, 0xffff00, 1);
    gfx.strokeCircle(cx, cy, TILE_SIZE / 2 + 3);
}

function selectedStockpileTile(scene: WorldScene): { x: number; y: number } | null {
    if (scene.selection.kind !== 'stockpile') return null;
    const { stockpileKind: kind, idx } = scene.selection;
    if (kind === 'food') return scene.foodStockpiles[idx] ?? null;
    if (kind === 'ore') return scene.oreStockpiles[idx] ?? null;
    if (kind === 'wood') return scene.woodStockpiles[idx] ?? null;
    if (kind === 'meal') return scene.mealStockpiles[idx] ?? null;
    if (kind === 'plank') return scene.plankStockpiles[idx] ?? null;
    return scene.barStockpiles[idx] ?? null;
}

export function drawFoodStockpile(scene: WorldScene) {
    drawStockpileBoxes(scene.foodStockpiles, scene.foodStockpileGfxList, 0xf0c040);
}

export function drawOreStockpile(scene: WorldScene) {
    drawStockpileBoxes(scene.oreStockpiles, scene.oreStockpileGfxList, 0xff8800);
}

export function drawWoodStockpile(scene: WorldScene) {
    drawStockpileBoxes(scene.woodStockpiles, scene.woodStockpileGfxList, 0x56d973);
}

export function drawMealStockpile(scene: WorldScene) {
    drawStockpileBoxes(scene.mealStockpiles, scene.mealStockpileGfxList, 0xff9900);
}

export function drawPlankStockpile(scene: WorldScene) {
    drawStockpileBoxes(scene.plankStockpiles, scene.plankStockpileGfxList, 0x8b7355);
}

export function drawBarStockpile(scene: WorldScene) {
    drawStockpileBoxes(scene.barStockpiles, scene.barStockpileGfxList, 0x888899);
}

export function drawTerrain(scene: WorldScene) {
    const seasonTint = getSeasonTint(scene);

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

            const baseTint = getBaseTileTint(scene, tile, x, y);
            t.tint = isVegetationTile(tile.type) && seasonTint !== 0xffffff
                ? multiplyTint(baseTint, seasonTint)
                : baseTint;

            if (isObject) {
                const dirtFrames = TILE_CONFIG[TileType.Dirt] ?? [0];
                const dt = scene.floorLayer.putTileAt(dirtFrames[0], x, y);
                if (dt && seasonTint !== 0xffffff) {
                    dt.tint = seasonTint;
                }
            }

            const roomTint = roomTintAt(scene, x, y);
            if (roomTint !== null) {
                t.tint = multiplyTint(t.tint, roomTint);
            }
        }
    }
}

export function drawOverlay(scene: WorldScene) {
    scene.overlayGfx.clear();
    scene.ambientGfx.clear();
    const dn = dayNightVisualStrength(scene.tick);
    const { nightStrength } = dn;
    /** ~1 with default tint depth; can rise if you tune overlay-comp sliders (legacy tint-above-glow). */
    const glowWashComp = computeAmbientGlowOverlayCompensation(dn);

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const tile = scene.grid[y][x];
            const w = scene.warmthField[y * GRID_SIZE + x];
            const d = scene.dangerField[y * GRID_SIZE + x];
            const {
                ambientAlpha,
                ambientColor,
                tacticalAlpha,
                tacticalColor,
            } = computeOverlayColors(scene, tile, w, d);

            if (ambientAlpha > 0.02) {
                const srcM = warmthSourceTileGlowMult(tile, w);
                scene.ambientGfx.fillStyle(ambientColor, ambientAlpha * glowWashComp * srcM);
                scene.ambientGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }

            // Night warmth punch (additive blend on ambientGfx — strong glow without opaque wash).
            const gd = ambientGlowDebug;
            if (nightStrength > gd.nightMinStrength && w > 0) {
                const boosted =
                    Math.pow(w / 100, gd.nightBoostPow) *
                    (gd.nightBoostBase + gd.nightBoostScale * nightStrength) *
                    glowWashComp *
                    warmthSourceTileNightBoostMult(tile, w);
                if (boosted > 0.02) {
                    scene.ambientGfx.fillStyle(0xffa547, boosted);
                    scene.ambientGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                }
            }

            if (scene.overlayMode === 'off') continue;

            if (tacticalAlpha > 0.02) {
                scene.overlayGfx.fillStyle(tacticalColor, tacticalAlpha);
                scene.overlayGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }
        }
    }
}

export function drawOffScreenIndicator(scene: WorldScene) {
    scene.offScreenGfx.clear();
    const selection = scene.selection;
    if (selection.kind !== 'goblin') return;

    const d = scene.goblins.find(dw => dw.id === selection.goblinId && dw.alive);
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
    const selection = scene.selection;

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
        if (scene.selection.kind === 'goblin' && id === scene.selection.goblinId) {
            scene.selectionGfx.lineStyle(2, 0xff4444, 0.85);
            scene.selectionGfx.strokeCircle(spr.x, spr.y, TILE_SIZE / 2 + 3);
        }
    }

    for (const d of scene.goblins) {
        if (!d.alive) continue;

        const px = d.x * TILE_SIZE + TILE_SIZE / 2;
        const py = d.y * TILE_SIZE + TILE_SIZE / 2;

        const frame = getGoblinFrame(d.assignedJob);
        let spr = scene.goblinSprites.get(d.id);
        if (!spr) {
            spr = scene.add.sprite(px, py, 'tiles', frame).setDepth(5);
            scene.goblinSprites.set(d.id, spr);
        } else {
            spr.setPosition(px, py);
            spr.setFrame(frame);
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

        if (scene.selection.kind === 'goblin' && d.id === scene.selection.goblinId) {
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
    const chickenIds = new Set(scene.chickens.map(c => c.id));
    for (const [id, spr] of scene.chickenSprites) {
        if (chickenIds.has(id)) continue;
        spr.destroy();
        scene.chickenSprites.delete(id);
    }
    for (const c of scene.chickens) {
        const px = c.x * TILE_SIZE + TILE_SIZE / 2;
        const py = c.y * TILE_SIZE + TILE_SIZE / 2;
        let spr = scene.chickenSprites.get(c.id);
        if (!spr) {
            spr = scene.add.sprite(px, py, 'tiles', CHICKEN_FRAME).setDepth(5);
            spr.setTint(0xffffcc);
            scene.chickenSprites.set(c.id, spr);
        } else {
            spr.setPosition(px, py);
        }
    }

    const pile = selectedStockpileTile(scene);
    if (pile) strokeYellowSelectionRing(scene.selectionGfx, pile.x, pile.y);
    if (scene.selection.kind === 'hearth') {
        strokeYellowSelectionRing(scene.selectionGfx, scene.selection.x, scene.selection.y);
    }
    if (selection.kind === 'adventurer') {
        const adv = scene.adventurers.find(a => a.id === selection.adventurerId);
        if (adv) strokeYellowSelectionRing(scene.selectionGfx, adv.x, adv.y);
    }
}
