import { GRID_SIZE, TILE_SIZE } from '../../shared/constants';
import { isMobileViewport, isTabletViewport } from '../../shared/platform';
import { emitGameState } from './WorldState';
import type { WorldScene } from './WorldScene';

const CAM_PAN_SPEED = 200; // world pixels per second for WASD pan

export function setupCamera(scene: WorldScene) {
    const worldPx = GRID_SIZE * TILE_SIZE;
    // Extend bounds so the player can pan far enough to bring map edges out from
    // behind the HUD/sidebar. On phone there's no sidebar so less offset needed.
    // Add 200 to width / 100 to height to compensate for the negative origin offsets
    // (-200 x, -100 y) so the full right/bottom edge of the map remains reachable.
    const sidebarOffset = isMobileViewport() ? 100 : isTabletViewport() ? 380 : 700;
    scene.cameras.main.setBounds(-200, -100, worldPx + 200 + sidebarOffset, worldPx + 400);

    // Phone starts zoomed to show ~40% of world width; desktop starts at 1.2×
    const screenW = scene.cameras.main.width;
    const screenH = scene.cameras.main.height;
    const initialZoom = isMobileViewport()
        ? Math.min(0.8, (screenW / worldPx) * 2.5)
        : 1.2;
    scene.cameras.main.setZoom(initialZoom);
    scene.cameras.main.centerOn(
        (scene.spawnZone.x + scene.spawnZone.w / 2) * TILE_SIZE,
        (scene.spawnZone.y + scene.spawnZone.h / 2) * TILE_SIZE,
    );

    // Dynamic minimum zoom — allow zooming out to see the whole world
    scene.minZoom = Math.max(0.15, Math.min(screenW / worldPx, screenH / worldPx));

    // Recalculate camera bounds and min zoom on viewport resize (device rotation, etc.)
    scene.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
        const w = gameSize.width;
        const h = gameSize.height;
        scene.minZoom = Math.max(0.15, Math.min(w / worldPx, h / worldPx));
        const offset = w < 768 ? 100 : w < 1200 ? 380 : 700;
        scene.cameras.main.setBounds(-200, -100, worldPx + 200 + offset, worldPx + 400);
        // Clamp current zoom to new min
        if (scene.cameras.main.zoom < scene.minZoom) {
            scene.cameras.main.zoom = scene.minZoom;
        }
        emitGameState(scene);
    });
}

export function updateCamera(scene: WorldScene, delta: number) {
    // WASD camera pan (only when keyboard is available)
    const cam = scene.cameras.main;
    if (scene.wasd) {
        const speed = CAM_PAN_SPEED * (delta / 1000) / cam.zoom;
        if (scene.wasd.W.isDown) cam.scrollY -= speed;
        if (scene.wasd.S.isDown) cam.scrollY += speed;
        if (scene.wasd.A.isDown) cam.scrollX -= speed;
        if (scene.wasd.D.isDown) cam.scrollX += speed;
    }
}
