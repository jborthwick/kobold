
import { WorldScene } from './WorldScene';
import { generateWorld } from '../../simulation/world';
import { spawnGoblins } from '../../simulation/agents';
import { resetAdventurers, spawnInitialAdventurers } from '../../simulation/adventurers';
import { createWeather } from '../../simulation/weather';
import { llmSystem } from '../../ai/crisis';
import { loadGame } from '../../shared/save';
import { setActiveFaction } from '../../shared/factions';
import { bus } from '../../shared/events';
import { setNextEventTick } from '../../simulation/events';
import * as WorldGoals from './WorldGoals';
import { GRID_SIZE, TILE_SIZE } from '../../shared/constants';
import { type OverlayMode, type LogEntry, type RoomType } from '../../shared/types';
import { SPRITE_CONFIG } from '../tileConfig';
import { drawFlag } from './WorldOverlays';
import { drawOverlay } from './WorldRender';
import { setupInput } from './WorldInput';
import { setupCamera } from './WorldCamera';
import { initWeatherFX } from './WeatherFX';

export function initializeWorld(scene: WorldScene) {
  const mode = (scene.game.registry.get('startMode') as string) ?? 'new';
  const save = mode === 'load' ? loadGame() : null;

  if (save) {
    setActiveFaction(save.faction ?? 'goblins');
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
    scene.tick = save.tick;
    scene.colonyGoal = save.colonyGoal;
    scene.goalStartTick = save.goalStartTick ?? 0;
    scene.foodStockpiles = save.foodStockpiles;
    scene.oreStockpiles = save.oreStockpiles;
    scene.woodStockpiles = save.woodStockpiles ?? [];
    scene.adventurerKillCount = save.adventurerKillCount;
    scene.pendingSuccessions = save.pendingSuccessions;
    scene.commandTile = save.commandTile;
    scene.speedMultiplier = save.speed;
    scene.overlayMode = save.overlayMode;
    resetAdventurers();
    setNextEventTick(save.nextWorldEventTick ?? (save.tick + 300 + Math.floor(Math.random() * 300)));
    scene.weather = save.weather ?? createWeather(save.tick);
    scene.worldSeed = save.worldSeed ?? '';
    scene.chapters = save.chapters ?? [];
    scene.lastChapterTick = scene.chapters.length > 0
      ? scene.chapters[scene.chapters.length - 1].tick : 0;
    if (scene.chapters.length > 0) bus.emit('restoreChronicle', scene.chapters);
    scene.rooms = save.rooms ?? [];
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
    scene.adventurers = spawnInitialAdventurers(scene.grid, 3);

    const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
    const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);
    scene.foodStockpiles = [];
    scene.oreStockpiles = [];
    scene.woodStockpiles = [];
    scene.rooms = [];
    scene.adventurerKillCount = 0;
    scene.goalStartTick = 0;
    scene.colonyGoal = WorldGoals.makeGoal('stockpile_food', 0);
    scene.weather = createWeather(0);
    for (const d of scene.goblins) {
      d.homeTile = { x: depotX, y: depotY };
    }
    const orePerGoblin = Math.floor(150 / scene.goblins.length);
    for (const d of scene.goblins) d.inventory.ore = orePerGoblin;
  }

  scene.foodStockpileGfxList = [];
  scene.foodStockpileImgList = [];
  scene.oreStockpileGfxList = [];
  scene.oreStockpileImgList = [];
  scene.woodStockpileGfxList = [];
  scene.woodStockpileImgList = [];

  scene.map = scene.make.tilemap({
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    width: GRID_SIZE,
    height: GRID_SIZE,
  });
  const tileset = scene.map.addTilesetImage('kenney1bit', 'tiles', TILE_SIZE, TILE_SIZE, 0, 0)!;
  scene.floorLayer = scene.map.createBlankLayer('floor', tileset)!.setDepth(0);
  scene.objectLayer = scene.map.createBlankLayer('objects', tileset)!.setDepth(2);

  scene.ambientGfx = scene.add.graphics().setDepth(3);
  scene.overlayGfx = scene.add.graphics().setDepth(10);
  scene.flagGfx = scene.add.graphics().setDepth(11);
  scene.selectionGfx = scene.add.graphics().setDepth(12);

  for (const sp of scene.foodStockpiles) scene.addFoodStockpileGraphics(sp);
  for (const sp of scene.oreStockpiles) scene.addOreStockpileGraphics(sp);
  for (const sp of scene.woodStockpiles) scene.addWoodStockpileGraphics(sp);

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
  const settingsHandler = (s: { llmEnabled?: boolean; llmProvider?: 'anthropic' | 'groq' }) => {
    if (s.llmEnabled !== undefined) llmSystem.enabled = s.llmEnabled;
    if (s.llmProvider) llmSystem.provider = s.llmProvider;
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
  bus.on('controlChange', controlHandler);
  bus.on('settingsChange', settingsHandler);
  bus.on('logEntry', logCaptureHandler);
  bus.on('overlayChange', overlayHandler);
  bus.on('cycleSelected', cycleHandler);
  bus.on('buildMode', buildModeHandler);

  // Remove bus listeners when this scene is destroyed (new-colony flow)
  scene.events.once('destroy', () => {
    bus.off('controlChange', controlHandler);
    bus.off('settingsChange', settingsHandler);
    bus.off('logEntry', logCaptureHandler);
    bus.off('overlayChange', overlayHandler);
    bus.off('cycleSelected', cycleHandler);
    bus.off('buildMode', buildModeHandler);
  });

  setupCamera(scene);
  setupInput(scene);
  initWeatherFX(scene);
}
