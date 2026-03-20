import * as Phaser from 'phaser';
import { GRID_SIZE, TILE_SIZE } from '../../shared/constants';
import { isWalkable } from '../../simulation/world';
import { bus } from '../../shared/events';
import type { TileInfo, OverlayMode } from '../../shared/types';
import { TileType } from '../../shared/types';
import { getRoomDims } from '../../shared/roomConfig';
import type { WorldScene } from './WorldScene';
import { drawFlag, drawBuildPreview } from './WorldOverlays';
import { emitGameState } from './WorldState';
import { getDanger, getWarmth } from '../../simulation/diffusion';
import { getTerrainMoveCost } from '../../simulation/movementCost';

const OVERLAY_MODES: OverlayMode[] = ['off', 'food', 'material', 'wood', 'warmth', 'danger', 'traffic'];
const MAX_ZOOM = 5;
const SPEED_UP_KEY_CODES = [187, 107];
const SPEED_DOWN_KEY_CODES = [189, 109];

type SelectablePoint = { x: number; y: number };

function clearBuildMode(scene: WorldScene) {
    if (!scene.buildMode) return;
    scene.buildMode = null;
    scene.buildPreview = null;
    scene.buildPreviewGfx.clear();
    bus.emit('buildMode', null);
}

function bindKeyboardControls(scene: WorldScene) {
    const keyboard = scene.input.keyboard;
    if (!keyboard) return;

    scene.wasd = {
        W: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        A: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        S: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        D: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.O).on('down', () => {
        const next = OVERLAY_MODES[(OVERLAY_MODES.indexOf(scene.overlayMode) + 1) % OVERLAY_MODES.length];
        scene.overlayMode = next;
    });
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.OPEN_BRACKET).on('down', () => scene.cycleSelected(-1));
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.CLOSED_BRACKET).on('down', () => scene.cycleSelected(1));
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE).on('down', () => scene.togglePause());
    for (const code of SPEED_UP_KEY_CODES) keyboard.addKey(code).on('down', () => scene.adjustSpeed(1));
    for (const code of SPEED_DOWN_KEY_CODES) keyboard.addKey(code).on('down', () => scene.adjustSpeed(-1));
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC).on('down', () => clearBuildMode(scene));
    keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T, false);
}

function findNearestPoint<T extends SelectablePoint>(
    list: T[],
    tx: number,
    ty: number,
    snapRadius: number,
): T | undefined {
    if (snapRadius === 0) return list.find(e => e.x === tx && e.y === ty);
    let best: T | undefined;
    let bestDist = Infinity;
    for (const e of list) {
        const d = Math.abs(e.x - tx) + Math.abs(e.y - ty);
        if (d <= snapRadius && d < bestDist) {
            bestDist = d;
            best = e;
        }
    }
    return best;
}

function findNearestIndex<T extends SelectablePoint>(
    list: T[],
    tx: number,
    ty: number,
    snapRadius: number,
): number {
    if (snapRadius === 0) return list.findIndex(s => s.x === tx && s.y === ty);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
        const d = Math.abs(list[i].x - tx) + Math.abs(list[i].y - ty);
        if (d <= snapRadius && d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

function clearSelections(scene: WorldScene, emitState: boolean) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = null;
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = null;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', null);
    if (emitState) emitGameState(scene);
}

function selectAdventurer(scene: WorldScene, adventurer: { id: string }) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = null;
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = adventurer.id;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', adventurer);
}

function selectGoblin(scene: WorldScene, goblinId: string) {
    scene.selectedGoblinId = goblinId;
    scene.selectedHearth = null;
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = null;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', null);
    emitGameState(scene);
}

function selectStockpile(
    scene: WorldScene,
    selection: { kind: 'food' | 'ore' | 'wood' | 'meal' | 'plank' | 'bar'; idx: number },
) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = null;
    scene.selectedAdventurerId = null;
    scene.selectedStockpile = selection;
    bus.emit('adventurerSelect', null);
    bus.emit('stockpileSelect', selection);
    bus.emit('hearthSelect', null);
}

function selectHearth(scene: WorldScene, x: number, y: number) {
    scene.selectedGoblinId = null;
    scene.selectedHearth = { x, y };
    scene.selectedStockpile = null;
    scene.selectedAdventurerId = null;
    bus.emit('adventurerSelect', null);
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', { x, y });
}

export function setupInput(scene: WorldScene) {
    const cam = scene.cameras.main;
    let dragStartX = 0, dragStartY = 0;
    let scrollAtDragX = 0, scrollAtDragY = 0;
    let didDrag = false;
    /** True after pointerdown on canvas; cleared on pointerup. Prevents panning when pointerup was consumed by another element (e.g. native select). */
    let dragIntent = false;

    // Pinch-to-zoom state (touch devices)
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let isPinching = false;

    // ── Touch detection ──────────────────────────────────────────────────
    scene.isTouchDevice = scene.sys.game.device.input.touch;

    // ── Keyboard (only when available) ──────────────────────────────────
    bindKeyboardControls(scene);

    // Suppress browser right-click context menu over the canvas
    scene.input.mouse?.disableContextMenu();

    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
        // ── Right-click: issue a gather command ──────────────────────────
        if (p.rightButtonDown()) {
            const tx = Phaser.Math.Clamp(Math.floor(p.worldX / TILE_SIZE), 0, GRID_SIZE - 1);
            const ty = Phaser.Math.Clamp(Math.floor(p.worldY / TILE_SIZE), 0, GRID_SIZE - 1);

            if (isWalkable(scene.grid, tx, ty)) {
                scene.commandTile = { x: tx, y: ty };
                scene.applyCommand(tx, ty);
                drawFlag(scene.flagGfx, scene.commandTile);
            }
            return; // don't start drag on right-click
        }

        // ── Pinch start: second finger down ─────────────────────────────
        if (scene.isTouchDevice && scene.input.pointer1.isDown && scene.input.pointer2.isDown) {
            isPinching = true;
            const dx = scene.input.pointer1.x - scene.input.pointer2.x;
            const dy = scene.input.pointer1.y - scene.input.pointer2.y;
            pinchStartDist = Math.sqrt(dx * dx + dy * dy);
            pinchStartZoom = cam.zoom;
            return;
        }

        // ── Left-click drag start ────────────────────────────────────────
        dragIntent = true;
        dragStartX = p.x;
        dragStartY = p.y;
        scrollAtDragX = cam.scrollX;
        scrollAtDragY = cam.scrollY;
        didDrag = false;

        // ── Long-press timer (touch: replaces right-click for commands) ──
        if (scene.isTouchDevice) {
            scene.longPressFired = false;
            const startX = p.x, startY = p.y;

            if (scene.longPressTimer) clearTimeout(scene.longPressTimer);
            scene.longPressTimer = setTimeout(() => {
                const ptr = scene.input.activePointer;
                const moved = Math.abs(ptr.x - startX) + Math.abs(ptr.y - startY);
                if (moved < 8 && ptr.isDown && !isPinching) {
                    scene.longPressFired = true;
                    const tx = Phaser.Math.Clamp(Math.floor(ptr.worldX / TILE_SIZE), 0, GRID_SIZE - 1);
                    const ty = Phaser.Math.Clamp(Math.floor(ptr.worldY / TILE_SIZE), 0, GRID_SIZE - 1);
                    if (isWalkable(scene.grid, tx, ty)) {
                        scene.commandTile = { x: tx, y: ty };
                        scene.applyCommand(tx, ty);
                        drawFlag(scene.flagGfx, scene.commandTile);
                    }
                }
            }, 500);
        }
    });

    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
        // ── Pinch-to-zoom ────────────────────────────────────────────────
        if (isPinching && scene.input.pointer1.isDown && scene.input.pointer2.isDown) {
            const dx = scene.input.pointer1.x - scene.input.pointer2.x;
            const dy = scene.input.pointer1.y - scene.input.pointer2.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (pinchStartDist === 0) return;

            const scale = dist / pinchStartDist;
            const newZoom = Phaser.Math.Clamp(pinchStartZoom * scale, scene.minZoom, MAX_ZOOM);

            // Anchor zoom to midpoint between fingers
            const midX = (scene.input.pointer1.x + scene.input.pointer2.x) / 2;
            const midY = (scene.input.pointer1.y + scene.input.pointer2.y) / 2;
            const oldZoom = cam.zoom;
            if (newZoom !== oldZoom) {
                const f = 1 / oldZoom - 1 / newZoom;
                cam.zoom = newZoom;
                cam.scrollX += (midX - cam.x - cam.width / 2) * f;
                cam.scrollY += (midY - cam.y - cam.height / 2) * f;
            }
            return; // don't pan while pinching
        }

        // Tile hover — emit info for the tooltip regardless of drag state
        const hx = Phaser.Math.Clamp(Math.floor(p.worldX / TILE_SIZE), 0, GRID_SIZE - 1);
        const hy = Phaser.Math.Clamp(Math.floor(p.worldY / TILE_SIZE), 0, GRID_SIZE - 1);
        const ht = scene.grid[hy]?.[hx];
        if (ht) {
            const info: TileInfo = {
                x: hx, y: hy,
                type: ht.type,
                foodValue: ht.foodValue, maxFood: ht.maxFood,
                materialValue: ht.materialValue, maxMaterial: ht.maxMaterial,
                danger: getDanger(scene.dangerField, hx, hy),
                warmth: getWarmth(scene.warmthField, hx, hy),
                trafficScore: ht.trafficScore ?? 0,
                moveCost: getTerrainMoveCost(ht.type),
                foodPriority: scene.resourceBalanceSnapshot.foodPriority,
                materialPriority: scene.resourceBalanceSnapshot.materialPriority,
                consumablesPressure: scene.resourceBalanceSnapshot.consumablesPressure,
                orePressure: scene.resourceBalanceSnapshot.orePressure,
                woodPressure: scene.resourceBalanceSnapshot.woodPressure,
                upgradesPressure: scene.resourceBalanceSnapshot.upgradesPressure,
            };
            bus.emit('tileHover', info);
        }

        // Update build preview when in build mode
        if (scene.buildMode) {
            const { w, h } = getRoomDims(scene.buildMode);
            const bx = Phaser.Math.Clamp(Math.floor(p.worldX / TILE_SIZE) - Math.floor(w / 2), 0, GRID_SIZE - w);
            const by = Phaser.Math.Clamp(Math.floor(p.worldY / TILE_SIZE) - Math.floor(h / 2), 0, GRID_SIZE - h);
            scene.buildPreview = { x: bx, y: by };
            drawBuildPreview(scene.buildPreviewGfx, scene.buildMode, scene.buildPreview, scene.grid, scene.rooms);
        }

        if (!dragIntent || !p.isDown || p.rightButtonDown()) return;
        const panDx = (dragStartX - p.x) / cam.zoom;
        const panDy = (dragStartY - p.y) / cam.zoom;
        if (Math.abs(panDx) > 3 || Math.abs(panDy) > 3) didDrag = true;
        cam.scrollX = scrollAtDragX + panDx;
        cam.scrollY = scrollAtDragY + panDy;
    });

    const clearDragIntent = () => {
        dragIntent = false;
    };

    scene.input.on('pointerup', (p: Phaser.Input.Pointer) => {
        clearDragIntent();
        // Cancel long-press timer
        if (scene.longPressTimer) {
            clearTimeout(scene.longPressTimer);
            scene.longPressTimer = null;
        }

        // End pinch when either finger lifts
        if (isPinching) {
            isPinching = false;
            pinchStartDist = 0;
            return;
        }

        if (didDrag || p.rightButtonReleased() || scene.longPressFired) return;

        // Build mode: place room on click
        if (scene.buildMode) {
            scene.placeRoom();
            return;
        }

        const tx = Math.floor(p.worldX / TILE_SIZE);
        const ty = Math.floor(p.worldY / TILE_SIZE);

        // ── Snap-to-nearest helper for touch (2-tile Manhattan radius) ──
        const snapRadius = scene.isTouchDevice ? 2 : 0;

        // Prefer agents over stockpiles/hearth so goblins on stockpile tiles are clickable
        const adventurer = findNearestPoint(scene.adventurers, tx, ty, snapRadius);
        if (adventurer) {
            selectAdventurer(scene, adventurer);
            return;
        }
        const aliveGoblins = scene.goblins.filter(d => d.alive);
        const deadGoblins = scene.goblins.filter(d => !d.alive);
        const hitAlive = findNearestPoint(aliveGoblins, tx, ty, snapRadius);
        const hitDead = !hitAlive ? findNearestPoint(deadGoblins, tx, ty, snapRadius) : undefined;
        const hitGoblin = hitAlive ?? hitDead;
        if (hitGoblin) {
            selectGoblin(scene, hitGoblin.id);
            return;
        }

        // Check for stockpile click (with snap on touch)
        const foodIdx = findNearestIndex(scene.foodStockpiles, tx, ty, snapRadius);
        if (foodIdx >= 0) {
            selectStockpile(scene, { kind: 'food', idx: foodIdx });
            return;
        }
        const oreIdx = findNearestIndex(scene.oreStockpiles, tx, ty, snapRadius);
        if (oreIdx >= 0) {
            selectStockpile(scene, { kind: 'ore', idx: oreIdx });
            return;
        }
        const woodIdx = findNearestIndex(scene.woodStockpiles, tx, ty, snapRadius);
        if (woodIdx >= 0) {
            selectStockpile(scene, { kind: 'wood', idx: woodIdx });
            return;
        }
        const mealIdx = findNearestIndex(scene.mealStockpiles, tx, ty, snapRadius);
        if (mealIdx >= 0) {
            selectStockpile(scene, { kind: 'meal', idx: mealIdx });
            return;
        }
        const plankIdx = findNearestIndex(scene.plankStockpiles, tx, ty, snapRadius);
        if (plankIdx >= 0) {
            selectStockpile(scene, { kind: 'plank', idx: plankIdx });
            return;
        }
        const barIdx = findNearestIndex(scene.barStockpiles, tx, ty, snapRadius);
        if (barIdx >= 0) {
            selectStockpile(scene, { kind: 'bar', idx: barIdx });
            return;
        }

        // Check for hearth click (tile-based)
        const tile = scene.grid[ty]?.[tx];
        if (tile?.type === TileType.Hearth) {
            selectHearth(scene, tx, ty);
            return;
        }

        // Nothing hit: clear selections
        clearSelections(scene, true);
    });

    // When pointer is released outside the canvas (e.g. on a native <select> option), Phaser
    // never gets pointerup, so dragIntent would stay true and the map would pan on move. Clear
    // drag intent on any window-level pointerup/pointercancel so we don't keep panning.
    const onWindowPointerRelease = () => clearDragIntent();
    window.addEventListener('pointerup', onWindowPointerRelease, true);
    window.addEventListener('pointercancel', onWindowPointerRelease, true);
    scene.events.once('destroy', () => {
        window.removeEventListener('pointerup', onWindowPointerRelease, true);
        window.removeEventListener('pointercancel', onWindowPointerRelease, true);
    });

    scene.input.on('wheel',
        (ptr: Phaser.Input.Pointer, _objs: unknown, _dx: number, deltaY: number) => {
            const oldZoom = cam.zoom;

            // Clamp deltaY to ±100 so a single trackpad flick doesn't jump the full range.
            // Then use a small logarithmic step (3% per 100px of delta) so the zoom feels
            // proportional rather than jumping 10% per tick.
            const clampedDelta = Phaser.Math.Clamp(deltaY, -300, 300);
            const factor = 1 - clampedDelta * 0.003;   // e.g. deltaY=100 → factor=0.7 (−30%)
            const newZoom = Phaser.Math.Clamp(oldZoom * factor, scene.minZoom, MAX_ZOOM);
            if (newZoom === oldZoom) return;

            // Phaser 3 uses a viewport-centred transform — scrollX is NOT the world position
            // at the left edge, it's offset by halfWidth. The correct zoom-to-cursor formula
            // adjusts scroll by (cursor-from-viewport-centre) × (zoom-factor-delta).
            const f = 1 / oldZoom - 1 / newZoom;
            cam.zoom = newZoom;
            cam.scrollX += (ptr.x - cam.x - cam.width / 2) * f;
            cam.scrollY += (ptr.y - cam.y - cam.height / 2) * f;
        },
    );
}
