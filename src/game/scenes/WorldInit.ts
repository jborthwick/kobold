
import { WorldScene } from './WorldScene';
import { generateWorld } from '../../simulation/world';
import { spawnGoblins } from '../../simulation/agents';
import { resetAdventurers, spawnInitialAdventurers } from '../../simulation/adventurers';
import { resetChickens, spawnInitialChickens, syncChickenIdCounter } from '../../simulation/chickens';
import { createWeather } from '../../simulation/weather';
import { setStorytellerEnabled, setStorytellerProvider } from '../../ai/storyteller';
import { loadGame } from '../../shared/save';
import { bus } from '../../shared/events';
import { setNextEventTick } from '../../simulation/events';
import * as WorldGoals from './WorldGoals';
import { GRID_SIZE, TILE_SIZE } from '../../shared/constants';
import { type Chapter, type OverlayMode, type LogEntry, type RoomType, type Room } from '../../shared/types';
import { canPlaceRoom, clearRoomGroundToDirt } from '../../simulation/rooms';
import { WORK_CATEGORIES, type WorkCategoryId, type WorkerTargets } from '../../simulation/workerTargets';
import { SPRITE_CONFIG } from '../tileConfig';
import { drawFlag } from './WorldOverlays';
import { drawOverlay } from './WorldRender';
import { setupInput } from './WorldInput';
import { emitGameState } from './WorldState';
import { setupCamera } from './WorldCamera';
import { initWeatherFX } from './WeatherFX';

export function initializeWorld(scene: WorldScene) {
  const mode = (scene.game.registry.get('startMode') as string) ?? 'new';
  const save = mode === 'load' ? loadGame() : null;

  if (save) {
    bus.emit('restoreLog', save.logHistory ?? []);
    scene.grid = save.grid;
    scene.spawnZone = save.spawnZone;
    scene.goblins = save.goblins;
    for (const d of scene.goblins) {
      d.fatigue ??= 0;
      d.social ??= 0;
      d.lastSocialTick ??= save.tick;
      d.lastLoggedTicks ??= {};
    }
    scene.adventurers = save.adventurers;
    scene.chickens = save.chickens ?? [];
    syncChickenIdCounter(scene.chickens);
    scene.tick = save.tick;
    scene.colonyGoal = save.colonyGoal;
    scene.goalStartTick = save.goalStartTick ?? 0;
    scene.foodStockpiles = save.foodStockpiles;
    scene.mealStockpiles = save.mealStockpiles ?? [];
    scene.plankStockpiles = save.plankStockpiles ?? [];
    scene.barStockpiles = save.barStockpiles ?? [];
    scene.oreStockpiles = save.oreStockpiles;
    scene.woodStockpiles = save.woodStockpiles ?? [];
    scene.adventurerKillCount = save.adventurerKillCount;
    scene.mealsCooked = save.mealsCooked ?? 0;
    scene.pendingSuccessions = save.pendingSuccessions;
    scene.commandTile = save.commandTile;
    scene.speedMultiplier = save.speed;
    scene.overlayMode = save.overlayMode;
    resetAdventurers();
    resetChickens();
    setNextEventTick(save.nextWorldEventTick ?? (save.tick + 300 + Math.floor(Math.random() * 300)));
    scene.weather = save.weather ?? createWeather(save.tick);
    scene.worldSeed = save.worldSeed ?? '';
    scene.chapters = save.chapters ?? [];
    scene.lastChapterTick = scene.chapters.length > 0
      ? scene.chapters[scene.chapters.length - 1].tick : 0;
    if (scene.chapters.length > 0) bus.emit('restoreChronicle', scene.chapters);
    scene.rooms = save.rooms ?? [];
    const validCategoryIds = new Set<string>(WORK_CATEGORIES.map(c => c.id));
    const rawTargets = save.workerTargets ?? {};
    scene.workerTargets = Object.fromEntries(
      Object.entries(rawTargets).filter(([k]) => validCategoryIds.has(k))
    ) as WorkerTargets;
  } else {
    bus.emit('clearLog', undefined);
    scene.logHistory = [];
    scene.chapters = [];
    scene.lastChapterTick = 0;
    const { grid, spawnZone, seed } = generateWorld();
    scene.grid = grid;
    scene.spawnZone = spawnZone;
    scene.worldSeed = seed;
    console.log('World seed:', seed);
    scene.goblins = spawnGoblins(scene.grid, spawnZone);
    resetAdventurers();
    resetChickens();
    scene.adventurers = spawnInitialAdventurers(scene.grid, 3);
    scene.chickens = spawnInitialChickens(scene.grid, 8);

    const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
    const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);
    scene.foodStockpiles = [];
    scene.mealStockpiles = [];
    scene.plankStockpiles = [];
    scene.barStockpiles = [];
    scene.oreStockpiles = [];
    scene.woodStockpiles = [];
    scene.rooms = [];

    // Starter storage room near spawn so goblins can deposit/withdraw from tick 1 (matches headless behaviour)
    const roomW = 5;
    const roomH = 5;
    const storageOffsets = [{ dx: -2, dy: -2 }, { dx: 6, dy: -2 }, { dx: -2, dy: 6 }, { dx: 6, dy: 6 }];
    for (const { dx, dy } of storageOffsets) {
      const rx = depotX + dx;
      const ry = depotY + dy;
      if (canPlaceRoom(scene.grid, scene.rooms, rx, ry, roomW, roomH)) {
        clearRoomGroundToDirt(scene.grid, rx, ry, roomW, roomH);
        const storageRoom: Room = {
          id: `room-storage-0`,
          type: 'storage',
          x: rx,
          y: ry,
          w: roomW,
          h: roomH,
        };
        scene.rooms.push(storageRoom);
        scene.foodStockpiles.push({
          x: rx + 1,
          y: ry + 1,
          food: 0,
          maxFood: 200,
        });
        break;
      }
    }
    scene.adventurerKillCount = 0;
    scene.mealsCooked = 0;
    scene.goalStartTick = 0;
    scene.colonyGoal = WorldGoals.makeGoal('build_rooms', 0);
    scene.weather = createWeather(0);
    for (const d of scene.goblins) {
      d.homeTile = { x: depotX, y: depotY };
    }
  }

  scene.foodStockpileGfxList = [];
  scene.foodStockpileImgList = [];
  scene.oreStockpileGfxList = [];
  scene.oreStockpileImgList = [];
  scene.woodStockpileGfxList = [];
  scene.woodStockpileImgList = [];
  scene.plankStockpileGfxList = [];
  scene.plankStockpileImgList = [];
  scene.barStockpileGfxList = [];
  scene.barStockpileImgList = [];

  scene.map = scene.make.tilemap({
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    width: GRID_SIZE,
    height: GRID_SIZE,
  });
  const tileset = scene.map.addTilesetImage('kenney1bit', 'tiles', TILE_SIZE, TILE_SIZE, 0, 0)!;
  scene.floorLayer = scene.map.createBlankLayer('floor', tileset)!.setDepth(0);
  scene.objectLayer = scene.map.createBlankLayer('objects', tileset)!.setDepth(2);

  // Warmth/danger tint: between floor (0) and objects (2) so hearths, fire, trees draw on top;
  // goblins/sprites stay above at depth 4+.
  scene.ambientGfx = scene.add.graphics().setDepth(1);
  scene.overlayGfx = scene.add.graphics().setDepth(10);
  scene.flagGfx = scene.add.graphics().setDepth(11);
  scene.selectionGfx = scene.add.graphics().setDepth(12);

  scene.syncAllStockpileGraphics();

  scene.buildPreviewGfx = scene.add.graphics().setDepth(50);
  scene.offScreenGfx = scene.add.graphics().setScrollFactor(0).setDepth(100);

  if (save) {
    const TOMBSTONE_FRAME = SPRITE_CONFIG.tombstone ?? SPRITE_CONFIG.goblin;
    for (const d of scene.goblins.filter(dw => !dw.alive)) {
      const px = d.x * TILE_SIZE + TILE_SIZE / 2;
      const py = d.y * TILE_SIZE + TILE_SIZE / 2;
      const ghost = scene.add.sprite(px, py, 'tiles', TOMBSTONE_FRAME).setDepth(4);
      ghost.setTint(0xaaaaaa);
      scene.goblinGhostSprites.set(d.id, ghost);
    }
    if (save?.commandTile) {
      scene.commandTile = save.commandTile;
      drawFlag(scene.flagGfx, scene.commandTile);
    }
  }

  // ── Settings / control bus ───────────────────────────────────────────
  // Store handler refs so they can be removed on scene shutdown (avoids stale
  // listeners firing on a destroyed scene when the player starts a new colony).
  const controlHandler = ({ action }: { action: 'pause' | 'speedUp' | 'speedDown' | 'newColony' }) => {
    if (action === 'pause') scene.togglePause();
    if (action === 'speedUp') scene.adjustSpeed(1);
    if (action === 'speedDown') scene.adjustSpeed(-1);
    // 'newColony' is handled by App.tsx; WorldScene has nothing to do
  };
  // HUD emits llmEnabled / llmProvider in dev; prod builds clamp inside storyteller.ts.
  const settingsHandler = (s: { llmEnabled?: boolean; llmProvider?: 'anthropic' | 'groq' }) => {
    if (s.llmEnabled !== undefined) setStorytellerEnabled(s.llmEnabled);
    if (s.llmProvider) setStorytellerProvider(s.llmProvider);
  };
  const logCaptureHandler = (entry: LogEntry) => {
    scene.logHistory.push(entry);
    if (scene.logHistory.length > 200) scene.logHistory.shift();
  };
  // Mobile bus events: overlay cycle + goblin cycle (from MobileControls)
  const overlayHandler = ({ mode }: { mode: OverlayMode }) => {
    scene.overlayMode = mode;
    drawOverlay(scene);
  };
  const cycleHandler = ({ direction }: { direction: 1 | -1 }) => {
    scene.cycleSelected(direction);
  };
  const buildModeHandler = (ev: { roomType: RoomType } | null) => {
    if (ev && scene.buildMode === ev.roomType) {
      scene.buildMode = null;
      scene.buildPreview = null;
      scene.buildPreviewGfx.clear();
    } else {
      scene.buildMode = ev?.roomType ?? null;
      scene.buildPreview = null;
      scene.buildPreviewGfx.clear();
    }
  };
  const chronicleModalHandler = (payload: { open: boolean; chapter: Chapter; allChapters: Chapter[] }) => {
    if (payload.open) scene.paused = true;
  };
  const chronicleModalClosedHandler = () => {
    scene.paused = false;
  };
  const workerTargetChangeHandler = (payload: { category: WorkCategoryId; value: number }) => {
    if (payload.value <= 0) {
      const next = { ...scene.workerTargets };
      delete next[payload.category];
      scene.workerTargets = next;
    } else {
      scene.workerTargets = { ...scene.workerTargets, [payload.category]: payload.value };
    }
  };
  const goblinAssignedJobHandler = (payload: { goblinId: string; job: WorkCategoryId | null }) => {
    const goblin = scene.goblins.find(g => g.id === payload.goblinId);
    if (goblin) {
      goblin.assignedJob = payload.job;
      emitGameState(scene); // update panel immediately (e.g. when paused)
    }
  };
  bus.on('controlChange', controlHandler);
  bus.on('settingsChange', settingsHandler);
  bus.on('logEntry', logCaptureHandler);
  bus.on('overlayChange', overlayHandler);
  bus.on('cycleSelected', cycleHandler);
  bus.on('buildMode', buildModeHandler);
  bus.on('mealsCooked', (n: number) => { scene.mealsCooked += n; });
  bus.on('chronicleModal', chronicleModalHandler);
  bus.on('chronicleModalClosed', chronicleModalClosedHandler);
  bus.on('workerTargetChange', workerTargetChangeHandler);
  bus.on('goblinAssignedJob', goblinAssignedJobHandler);

  // Remove bus listeners when this scene is destroyed (new-colony flow)
  scene.events.once('destroy', () => {
    bus.off('controlChange', controlHandler);
    bus.off('settingsChange', settingsHandler);
    bus.off('logEntry', logCaptureHandler);
    bus.off('overlayChange', overlayHandler);
    bus.off('cycleSelected', cycleHandler);
    bus.off('buildMode', buildModeHandler);
    bus.off('mealsCooked', () => {});
    bus.off('chronicleModal', chronicleModalHandler);
    bus.off('chronicleModalClosed', chronicleModalClosedHandler);
    bus.off('workerTargetChange', workerTargetChangeHandler);
    bus.off('goblinAssignedJob', goblinAssignedJobHandler);
  });

  setupCamera(scene);
  setupInput(scene);
  initWeatherFX(scene);
}
