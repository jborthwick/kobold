import * as Phaser from 'phaser';
import { GRID_SIZE, TILE_SIZE } from '../../shared/constants';
import { isWalkable } from '../../simulation/world';
import { bus } from '../../shared/events';
import type { TileInfo, OverlayMode } from '../../shared/types';
import { TileType } from '../../shared/types';
import type { WorldScene } from './WorldScene';
import { drawFlag, drawBuildPreview } from './WorldOverlays';
import { emitGameState } from './WorldState';

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
    if (scene.input.keyboard) {
        scene.wasd = {
            W: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
            A: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
            S: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
            D: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
        };

        // ── O key: cycle resource overlay
        scene.input.keyboard
            .addKey(Phaser.Input.Keyboard.KeyCodes.O)
            .on('down', () => {
                const modes: OverlayMode[] = ['off', 'food', 'material', 'wood', 'warmth', 'danger', 'traffic'];
                const next = modes[(modes.indexOf(scene.overlayMode) + 1) % modes.length];
                scene.overlayMode = next;
            });

        // ── [ / ] keys: cycle selected goblin
        scene.input.keyboard
            .addKey(Phaser.Input.Keyboard.KeyCodes.OPEN_BRACKET)
            .on('down', () => scene.cycleSelected(-1));
        scene.input.keyboard
            .addKey(Phaser.Input.Keyboard.KeyCodes.CLOSED_BRACKET)
            .on('down', () => scene.cycleSelected(1));

        // ── SPACE: pause / unpause
        scene.input.keyboard
            .addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
            .on('down', () => scene.togglePause());

        // ── Speed keys: = (187) and numpad + (107) for faster; - (189) and numpad - (109) for slower
        for (const code of [187, 107]) {
            scene.input.keyboard.addKey(code).on('down', () => scene.adjustSpeed(1));
        }
        for (const code of [189, 109]) {
            scene.input.keyboard.addKey(code).on('down', () => scene.adjustSpeed(-1));
        }

        // ── ESC: cancel build mode
        scene.input.keyboard
            .addKey(Phaser.Input.Keyboard.KeyCodes.ESC)
            .on('down', () => {
                if (scene.buildMode) {
                    scene.buildMode = null;
                    scene.buildPreview = null;
                    scene.buildPreviewGfx.clear();
                    bus.emit('buildMode', null);
                }
            });

        // ── T: tile picker
        // The TilePicker React component handles its own toggle via a window-level
        // keydown listener. We just need to make sure Phaser doesn't capture it.
        scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T, false);
    }

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
            const newZoom = Phaser.Math.Clamp(pinchStartZoom * scale, scene.minZoom, 5);

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
            };
            bus.emit('tileHover', info);
        }

        // Update build preview when in build mode
        if (scene.buildMode) {
            const bx = Phaser.Math.Clamp(Math.floor(p.worldX / TILE_SIZE) - 2, 0, GRID_SIZE - 5);
            const by = Phaser.Math.Clamp(Math.floor(p.worldY / TILE_SIZE) - 2, 0, GRID_SIZE - 5);
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
        const SNAP_RADIUS = scene.isTouchDevice ? 2 : 0;
        const findNearest = <T extends { x: number; y: number }>(list: T[]) => {
            if (SNAP_RADIUS === 0) return list.find(e => e.x === tx && e.y === ty);
            let best: T | undefined, bestDist = Infinity;
            for (const e of list) {
                const d = Math.abs(e.x - tx) + Math.abs(e.y - ty);
                if (d <= SNAP_RADIUS && d < bestDist) { bestDist = d; best = e; }
            }
            return best;
        };

        // Prefer agents over stockpiles/hearth so goblins on stockpile tiles are clickable
        const adventurer = findNearest(scene.adventurers);
        if (adventurer) {
            scene.selectedGoblinId = null;
            scene.selectedHearth = null;
            bus.emit('stockpileSelect', null);
            bus.emit('hearthSelect', null);
            bus.emit('adventurerSelect', adventurer);
            return;
        }
        const aliveGoblins = scene.goblins.filter(d => d.alive);
        const deadGoblins = scene.goblins.filter(d => !d.alive);
        const hitAlive = findNearest(aliveGoblins);
        const hitDead = !hitAlive ? findNearest(deadGoblins) : undefined;
        const hitGoblin = hitAlive ?? hitDead;
        if (hitGoblin) {
            scene.selectedGoblinId = hitGoblin.id;
            scene.selectedHearth = null;
            bus.emit('stockpileSelect', null);
            bus.emit('hearthSelect', null);
            bus.emit('adventurerSelect', null);
            emitGameState(scene);
            return;
        }

        // Check for stockpile click (with snap on touch)
        const findStockpile = <T extends { x: number; y: number }>(list: T[]) => {
            if (SNAP_RADIUS === 0) return list.findIndex(s => s.x === tx && s.y === ty);
            let bestIdx = -1, bestDist = Infinity;
            for (let i = 0; i < list.length; i++) {
                const d = Math.abs(list[i].x - tx) + Math.abs(list[i].y - ty);
                if (d <= SNAP_RADIUS && d < bestDist) { bestDist = d; bestIdx = i; }
            }
            return bestIdx;
        };
        const foodIdx = findStockpile(scene.foodStockpiles);
        if (foodIdx >= 0) {
            scene.selectedGoblinId = null;
            scene.selectedHearth = null;
            bus.emit('adventurerSelect', null);
            bus.emit('stockpileSelect', { kind: 'food', idx: foodIdx });
            bus.emit('hearthSelect', null);
            return;
        }
        const oreIdx = findStockpile(scene.oreStockpiles);
        if (oreIdx >= 0) {
            scene.selectedGoblinId = null;
            scene.selectedHearth = null;
            bus.emit('adventurerSelect', null);
            bus.emit('stockpileSelect', { kind: 'ore', idx: oreIdx });
            bus.emit('hearthSelect', null);
            return;
        }
        const woodIdx = findStockpile(scene.woodStockpiles);
        if (woodIdx >= 0) {
            scene.selectedGoblinId = null;
            scene.selectedHearth = null;
            bus.emit('adventurerSelect', null);
            bus.emit('stockpileSelect', { kind: 'wood', idx: woodIdx });
            bus.emit('hearthSelect', null);
            return;
        }
        const mealIdx = findStockpile(scene.mealStockpiles);
        if (mealIdx >= 0) {
            scene.selectedGoblinId = null;
            scene.selectedHearth = null;
            bus.emit('adventurerSelect', null);
            bus.emit('stockpileSelect', { kind: 'meal', idx: mealIdx });
            bus.emit('hearthSelect', null);
            return;
        }

        // Check for hearth click (tile-based)
        const tile = scene.grid[ty]?.[tx];
        if (tile?.type === TileType.Hearth) {
            scene.selectedGoblinId = null;
            scene.selectedHearth = { x: tx, y: ty };
            bus.emit('adventurerSelect', null);
            bus.emit('stockpileSelect', null);
            bus.emit('hearthSelect', { x: tx, y: ty });
            return;
        }

        // Nothing hit: clear selections
        scene.selectedGoblinId = null;
        scene.selectedHearth = null;
        bus.emit('stockpileSelect', null);
        bus.emit('hearthSelect', null);
        bus.emit('adventurerSelect', null);
        emitGameState(scene);
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
            const newZoom = Phaser.Math.Clamp(oldZoom * factor, scene.minZoom, 5);
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
