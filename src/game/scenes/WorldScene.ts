import * as Phaser from 'phaser';
// Note: import * as Phaser is required — Phaser's dist build has no default export
import { generateWorld, growback, isWalkable } from '../../simulation/world';
import { createWarmthField, createDangerField, computeWarmth, computeDanger, updateTraffic, findHearths } from '../../simulation/diffusion';
import { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY, roomWallSlots } from '../../simulation/agents';
import { tickAgentUtility } from '../../simulation/utilityAI';
import { maybeSpawnRaid, tickAdventurers, resetAdventurers, spawnInitialAdventurers } from '../../simulation/adventurers';
import { bus } from '../../shared/events';
import { GRID_SIZE, TILE_SIZE, TICK_RATE_MS } from '../../shared/constants';
import { TileType, type OverlayMode, type Tile, type Goblin, type Adventurer, type TileInfo, type MiniMapData, type ColonyGoal, type FoodStockpile, type OreStockpile, type WoodStockpile, type LogEntry, type Chapter, type Room, type RoomType } from '../../shared/types';
import { llmSystem, callSuccessionLLM } from '../../ai/crisis';
import { filterSignificantEvents, callStorytellerLLM, buildFallbackChapter } from '../../ai/storyteller';
import { tickWorldEvents, getNextEventTick, setNextEventTick, tickMushroomSprout } from '../../simulation/events';
import { tickFire, tickBurningGoblins } from '../../simulation/fire';
import { tickLightning } from '../../simulation/lightning';
import { tickPooling } from '../../simulation/pooling';
import { createWeather, tickWeather, growbackModifier, metabolismModifier, type Weather } from '../../simulation/weather';
import { rollWound, woundLabel } from '../../simulation/wounds';
import { TILE_CONFIG, SPRITE_CONFIG } from '../tileConfig';
import { saveGame, loadGame, type SaveData } from '../../shared/save';
import { isMobileViewport, isTabletViewport } from '../../shared/platform';
import { getActiveFaction, setActiveFaction } from '../../shared/factions';

// Frame assignments live in src/game/tileConfig.ts — edit them there
// or use the in-game tile picker (press T).
const GOBLIN_FRAME   = SPRITE_CONFIG.goblin;
const ADVENTURER_FRAME  = SPRITE_CONFIG.adventurer;    // editable via T-key tile picker
const CAM_PAN_SPEED  = 200; // world pixels per second for WASD pan

export class WorldScene extends Phaser.Scene {
  private grid: Tile[][] = [];
  private goblins: Goblin[] = [];
  private tick = 0;
  private selectedGoblinId: string | null = null;
  private terrainDirty = true;
  private lastTickTime = 0;
  private paused = false;
  private speedMultiplier = 1;
  private readonly SPEED_STEPS = [0.25, 0.5, 1, 2, 4];

  // Active player command tile (shown as flag)
  private commandTile: { x: number; y: number } | null = null;

  // Tilemap for terrain
  private map!: Phaser.Tilemaps.Tilemap;
  private terrainLayer!: Phaser.Tilemaps.TilemapLayer;

  // Graphics layers
  private selectionGfx!: Phaser.GameObjects.Graphics;
  private flagGfx!: Phaser.GameObjects.Graphics;
  private overlayGfx!: Phaser.GameObjects.Graphics;
  private overlayMode: OverlayMode = 'off';

  // One sprite per living goblin
  private goblinSprites = new Map<string, Phaser.GameObjects.Sprite>();
  // Persistent grave sprites for dead goblins (red, flipped upside-down)
  private goblinGhostSprites = new Map<string, Phaser.GameObjects.Sprite>();
  // Off-screen arrow indicator for selected goblin
  private offScreenGfx!: Phaser.GameObjects.Graphics;
  // Adventurer raid state
  private adventurers: Adventurer[] = [];
  private adventurerSprites = new Map<string, Phaser.GameObjects.Sprite>();

  // Succession state
  private spawnZone!: { x: number; y: number; w: number; h: number };
  private pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[] = [];

  // Weather system — affects growback rates and goblin metabolism
  private weather!: Weather;

  // Diffusion fields — recomputed every tick, never saved
  private warmthField = createWarmthField();
  private dangerField = createDangerField();
  private _dangerFieldPrev = createDangerField(); // double-buffer for decay

  // Event log noise reduction
  private combatHits = new Map<string, number>();  // goblin id → hit count this encounter

  // Colony goal + food/ore/wood stockpiles (expand as each fills up)
  private colonyGoal!: ColonyGoal;
  private goalStartTick = 0;
  private adventurerKillCount = 0;
  private foodStockpiles:        FoodStockpile[]  = [];
  private oreStockpiles:         OreStockpile[]   = [];
  private woodStockpiles:        WoodStockpile[]  = [];
  private foodStockpileGfxList:  Phaser.GameObjects.Graphics[] = [];
  private foodStockpileImgList:  Phaser.GameObjects.Image[]    = [];
  private oreStockpileGfxList:   Phaser.GameObjects.Graphics[] = [];
  private oreStockpileImgList:   Phaser.GameObjects.Image[]    = [];
  private woodStockpileGfxList:  Phaser.GameObjects.Graphics[] = [];
  private woodStockpileImgList:  Phaser.GameObjects.Image[]    = [];

  // Event log history (persisted to save, restored on load)
  private logHistory: LogEntry[] = [];
  // Chronicle chapters — generated by storyteller AI on goal completion
  private chapters: Chapter[] = [];
  private lastChapterTick = 0;
  // World seed — stored for save/load and display
  private worldSeed = '';

  // Player-placed rooms
  private rooms: Room[] = [];

  // Build mode state
  private buildMode: RoomType | null = null;
  private buildPreview: { x: number; y: number } | null = null;
  private buildPreviewGfx!: Phaser.GameObjects.Graphics;

  // WASD keys (null when keyboard unavailable on touch devices)
  private wasd: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  } | null = null;

  // Touch input state
  private isTouchDevice = false;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;
  private minZoom = 0.6;

  constructor() {
    super({ key: 'WorldScene' });
  }

  private static makeGoal(type: ColonyGoal['type'], generation: number): ColonyGoal {
    const scale = 1 + generation * 0.6;
    const desc  = getActiveFaction().goalDescriptions;
    switch (type) {
      case 'stockpile_food':
        return { type, description: desc.stockpile_food(Math.round(80 * scale)), progress: 0, target: Math.round(80 * scale), generation };
      case 'survive_ticks':
        return { type, description: desc.survive_ticks(Math.round(800 * scale)), progress: 0, target: Math.round(800 * scale), generation };
      case 'defeat_adventurers':
        return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
      case 'enclose_fort':
        return { type, description: desc.enclose_fort(), progress: 0, target: 1, generation };
    }
  }

  create() {
    // ── Branch: load saved game or start a new one ──────────────────────
    const mode = (this.game.registry.get('startMode') as string) ?? 'new';
    const save = mode === 'load' ? loadGame() : null;

    if (save) {
      // Restore faction selection from save (backward compat: default to goblins)
      setActiveFaction(save.faction ?? 'goblins');
      bus.emit('restoreLog', save.logHistory ?? []);
      // Restore all simulation state from the save file
      this.grid               = save.grid;
      this.spawnZone          = save.spawnZone;
      this.goblins            = save.goblins;
      // Backward compat — default new needs fields for saves that predate them
      for (const d of this.goblins) {
        d.fatigue        ??= 0;
        d.social         ??= 0;
        d.lastSocialTick  ??= save.tick;
        d.lastLoggedTicks ??= {};
      }
      this.adventurers            = save.adventurers;
      this.tick               = save.tick;
      this.colonyGoal         = save.colonyGoal;
      this.goalStartTick      = save.goalStartTick ?? 0;
      this.foodStockpiles     = save.foodStockpiles;
      this.oreStockpiles      = save.oreStockpiles;
      this.woodStockpiles     = save.woodStockpiles ?? [];  // graceful fallback for old saves
      this.adventurerKillCount    = save.adventurerKillCount;
      this.pendingSuccessions = save.pendingSuccessions;
      this.commandTile        = save.commandTile;
      this.speedMultiplier    = save.speed;
      this.overlayMode        = save.overlayMode;
      resetAdventurers(); // reset raid timer to prevent an immediate raid on resume
      // Restore world-event schedule; fall back to a fresh window if save predates this field
      setNextEventTick(save.nextWorldEventTick ?? (save.tick + 300 + Math.floor(Math.random() * 300)));
      // Restore weather or initialize if save predates weather system
      this.weather = save.weather ?? createWeather(save.tick);
      this.worldSeed = save.worldSeed ?? '';
      // Restore chronicle chapters
      this.chapters = save.chapters ?? [];
      this.lastChapterTick = this.chapters.length > 0
        ? this.chapters[this.chapters.length - 1].tick : 0;
      if (this.chapters.length > 0) bus.emit('restoreChronicle', this.chapters);
      this.rooms = save.rooms ?? [];
    } else {
      bus.emit('clearLog', undefined);
      this.logHistory = [];
      this.chapters = [];
      this.lastChapterTick = 0;
      // New game — procedural world + fresh goblins
      const { grid, spawnZone, seed } = generateWorld();
      this.grid      = grid;
      this.spawnZone = spawnZone;
      this.worldSeed = seed;
      console.log('World seed:', seed);
      this.goblins   = spawnGoblins(this.grid, spawnZone);
      resetAdventurers();
      this.adventurers = spawnInitialAdventurers(this.grid, 3);

      const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
      const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);
      this.foodStockpiles  = [];
      this.oreStockpiles   = [];
      this.woodStockpiles  = [];
      this.rooms           = [];
      this.adventurerKillCount = 0;
      this.goalStartTick   = 0;
      this.colonyGoal      = WorldScene.makeGoal('stockpile_food', 0);
      this.weather         = createWeather(0);
      for (const d of this.goblins) {
        d.homeTile = { x: depotX, y: depotY };
      }
      // Distribute starting ore across goblins (replaces hardcoded ore stockpile)
      const orePerGoblin = Math.floor(150 / this.goblins.length);
      for (const d of this.goblins) d.inventory.ore = orePerGoblin;
    }

    // ── Reset graphics tracking arrays (always fresh per scene) ─────────
    this.foodStockpileGfxList = [];
    this.foodStockpileImgList = [];
    this.oreStockpileGfxList  = [];
    this.oreStockpileImgList  = [];
    this.woodStockpileGfxList = [];
    this.woodStockpileImgList = [];

    // ── Tilemap for terrain ─────────────────────────────────────────────
    this.map = this.make.tilemap({
      tileWidth:  TILE_SIZE,
      tileHeight: TILE_SIZE,
      width:      GRID_SIZE,
      height:     GRID_SIZE,
    });
    const tileset = this.map.addTilesetImage('kenney1bit', 'tiles', TILE_SIZE, TILE_SIZE, 0, 0)!;
    this.terrainLayer = this.map.createBlankLayer('terrain', tileset)!;

    // ── Graphics layers ─────────────────────────────────────────────────
    // All graphics are created AFTER the terrain layer so they render on top.
    this.overlayGfx   = this.add.graphics();
    this.flagGfx      = this.add.graphics();
    this.selectionGfx = this.add.graphics();

    // Add graphics for all stockpiles (may be >1 when loading a saved game)
    for (const sp of this.foodStockpiles) this.addFoodStockpileGraphics(sp);
    for (const sp of this.oreStockpiles)  this.addOreStockpileGraphics(sp);
    for (const sp of this.woodStockpiles) this.addWoodStockpileGraphics(sp);

    // Build-mode room preview overlay
    this.buildPreviewGfx = this.add.graphics().setDepth(50);

    // Fixed to screen (scroll factor 0) so coords are in screen-space pixels
    this.offScreenGfx = this.add.graphics().setScrollFactor(0).setDepth(100);

    // Pre-create tombstone sprites for goblins that were already dead when saved
    if (save) {
      const TOMBSTONE_FRAME = SPRITE_CONFIG.tombstone ?? GOBLIN_FRAME;
      for (const d of this.goblins.filter(dw => !dw.alive)) {
        const px = d.x * TILE_SIZE + TILE_SIZE / 2;
        const py = d.y * TILE_SIZE + TILE_SIZE / 2;
        const ghost = this.add.sprite(px, py, 'tiles', TOMBSTONE_FRAME);
        ghost.setTint(0xaaaaaa);
        this.goblinGhostSprites.set(d.id, ghost);
      }
      this.drawFlag(); // restore yellow flag if one was active
    }

    // ── Touch detection ──────────────────────────────────────────────────
    this.isTouchDevice = this.sys.game.device.input.touch;

    // ── Camera ──────────────────────────────────────────────────────────
    const worldPx = GRID_SIZE * TILE_SIZE;
    // Extend bounds so the player can pan far enough to bring map edges out from
    // behind the HUD/sidebar. On phone there's no sidebar so less offset needed.
    // Add 200 to width / 100 to height to compensate for the negative origin offsets
    // (-200 x, -100 y) so the full right/bottom edge of the map remains reachable.
    const sidebarOffset = isMobileViewport() ? 100 : isTabletViewport() ? 380 : 700;
    this.cameras.main.setBounds(-200, -100, worldPx + 200 + sidebarOffset, worldPx + 400);

    // Phone starts zoomed to show ~40% of world width; desktop starts at 1.2×
    const screenW = this.cameras.main.width;
    const screenH = this.cameras.main.height;
    const initialZoom = isMobileViewport()
      ? Math.min(0.8, (screenW / worldPx) * 2.5)
      : 1.2;
    this.cameras.main.setZoom(initialZoom);
    this.cameras.main.centerOn(
      (this.spawnZone.x + this.spawnZone.w / 2) * TILE_SIZE,
      (this.spawnZone.y + this.spawnZone.h / 2) * TILE_SIZE,
    );

    // Dynamic minimum zoom — allow zooming out to see the whole world
    this.minZoom = Math.max(0.15, Math.min(screenW / worldPx, screenH / worldPx));

    // Recalculate camera bounds and min zoom on viewport resize (device rotation, etc.)
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      const w = gameSize.width;
      const h = gameSize.height;
      this.minZoom = Math.max(0.15, Math.min(w / worldPx, h / worldPx));
      const offset = w < 768 ? 100 : w < 1200 ? 380 : 700;
      this.cameras.main.setBounds(-200, -100, worldPx + 200 + offset, worldPx + 400);
      // Clamp current zoom to new min
      if (this.cameras.main.zoom < this.minZoom) {
        this.cameras.main.zoom = this.minZoom;
      }
      this.emitGameState();
    });

    // ── Keyboard (only when available) ──────────────────────────────────
    if (this.input.keyboard) {
      this.wasd = {
        W: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        A: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        S: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        D: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      };

      // ── O key: cycle resource overlay
      this.input.keyboard
        .addKey(Phaser.Input.Keyboard.KeyCodes.O)
        .on('down', () => {
          const modes: OverlayMode[] = ['off', 'food', 'material', 'wood', 'warmth', 'danger', 'traffic'];
          const next = modes[(modes.indexOf(this.overlayMode) + 1) % modes.length];
          this.overlayMode = next;
          this.drawOverlay();
        });

      // ── [ / ] keys: cycle selected goblin
      this.input.keyboard
        .addKey(Phaser.Input.Keyboard.KeyCodes.OPEN_BRACKET)
        .on('down', () => this.cycleSelected(-1));
      this.input.keyboard
        .addKey(Phaser.Input.Keyboard.KeyCodes.CLOSED_BRACKET)
        .on('down', () => this.cycleSelected(1));

      // ── SPACE: pause / unpause
      this.input.keyboard
        .addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
        .on('down', () => this.togglePause());

      // ── Speed keys: = (187) and numpad + (107) for faster; - (189) and numpad - (109) for slower
      for (const code of [187, 107]) {
        this.input.keyboard.addKey(code).on('down', () => this.adjustSpeed(1));
      }
      for (const code of [189, 109]) {
        this.input.keyboard.addKey(code).on('down', () => this.adjustSpeed(-1));
      }
    }

    // Suppress browser right-click context menu over the canvas
    this.input.mouse?.disableContextMenu();

    // ── Settings / control bus ───────────────────────────────────────────
    // Store handler refs so they can be removed on scene shutdown (avoids stale
    // listeners firing on a destroyed scene when the player starts a new colony).
    const controlHandler = ({ action }: { action: 'pause' | 'speedUp' | 'speedDown' | 'newColony' }) => {
      if (action === 'pause')     this.togglePause();
      if (action === 'speedUp')   this.adjustSpeed(1);
      if (action === 'speedDown') this.adjustSpeed(-1);
      // 'newColony' is handled by App.tsx; WorldScene has nothing to do
    };
    const settingsHandler = (s: { llmEnabled?: boolean; llmProvider?: 'anthropic' | 'groq' }) => {
      if (s.llmEnabled !== undefined) llmSystem.enabled  = s.llmEnabled;
      if (s.llmProvider)              llmSystem.provider = s.llmProvider;
    };
    const logCaptureHandler = (entry: LogEntry) => {
      this.logHistory.push(entry);
      if (this.logHistory.length > 200) this.logHistory.shift();
    };
    // Mobile bus events: overlay cycle + goblin cycle (from MobileControls)
    const overlayHandler = ({ mode }: { mode: OverlayMode }) => {
      this.overlayMode = mode;
      this.drawOverlay();
    };
    const cycleHandler = ({ direction }: { direction: 1 | -1 }) => {
      this.cycleSelected(direction);
    };
    const buildModeHandler = (ev: { roomType: RoomType } | null) => {
      if (ev && this.buildMode === ev.roomType) {
        this.buildMode = null;
        this.buildPreview = null;
        this.buildPreviewGfx.clear();
      } else {
        this.buildMode = ev?.roomType ?? null;
        this.buildPreview = null;
        this.buildPreviewGfx.clear();
      }
    };
    bus.on('controlChange', controlHandler);
    bus.on('settingsChange', settingsHandler);
    bus.on('logEntry', logCaptureHandler);
    bus.on('overlayChange', overlayHandler);
    bus.on('cycleSelected', cycleHandler);
    bus.on('buildMode', buildModeHandler);

    // Remove bus listeners when this scene is destroyed (new-colony flow)
    this.events.once('destroy', () => {
      bus.off('controlChange', controlHandler);
      bus.off('settingsChange', settingsHandler);
      bus.off('logEntry', logCaptureHandler);
      bus.off('overlayChange', overlayHandler);
      bus.off('cycleSelected', cycleHandler);
      bus.off('buildMode', buildModeHandler);
    });

    this.setupInput();
  }

  /** Serialise the full simulation state into a plain object suitable for JSON. */
  private buildSaveData(): SaveData {
    return {
      version:            2,
      tick:               this.tick,
      grid:               this.grid,
      goblins:            this.goblins.map(d => ({ ...d })),
      adventurers:            this.adventurers.map(g => ({ ...g })),
      colonyGoal:         { ...this.colonyGoal },
      foodStockpiles:     this.foodStockpiles.map(s => ({ ...s })),
      oreStockpiles:      this.oreStockpiles.map(s => ({ ...s })),
      woodStockpiles:     this.woodStockpiles.map(s => ({ ...s })),
      adventurerKillCount:    this.adventurerKillCount,
      spawnZone:          { ...this.spawnZone },
      pendingSuccessions: this.pendingSuccessions.map(s => ({ ...s })),
      commandTile:        this.commandTile ? { ...this.commandTile } : null,
      speed:              this.speedMultiplier,
      overlayMode:        this.overlayMode,
      logHistory:         [...this.logHistory],
      nextWorldEventTick: getNextEventTick(),
      weather:            { ...this.weather },
      worldSeed:          this.worldSeed,
      chapters:           [...this.chapters],
      goalStartTick:      this.goalStartTick,
      faction:            getActiveFaction().id,
      rooms:              this.rooms.map(r => ({ ...r })),
    };
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private setupInput() {
    const cam = this.cameras.main;
    let dragStartX = 0, dragStartY = 0;
    let scrollAtDragX = 0, scrollAtDragY = 0;
    let didDrag = false;

    // Pinch-to-zoom state (touch devices)
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let isPinching = false;

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      // ── Right-click: issue a gather command ──────────────────────────
      if (p.rightButtonDown()) {
        const tx = Phaser.Math.Clamp(Math.floor(p.worldX / TILE_SIZE), 0, GRID_SIZE - 1);
        const ty = Phaser.Math.Clamp(Math.floor(p.worldY / TILE_SIZE), 0, GRID_SIZE - 1);

        if (isWalkable(this.grid, tx, ty)) {
          this.commandTile = { x: tx, y: ty };
          this.applyCommand(tx, ty);
          this.drawFlag();
        }
        return; // don't start drag on right-click
      }

      // ── Pinch start: second finger down ─────────────────────────────
      if (this.isTouchDevice && this.input.pointer1.isDown && this.input.pointer2.isDown) {
        isPinching = true;
        const dx = this.input.pointer1.x - this.input.pointer2.x;
        const dy = this.input.pointer1.y - this.input.pointer2.y;
        pinchStartDist = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoom = cam.zoom;
        return;
      }

      // ── Left-click drag start ────────────────────────────────────────
      dragStartX    = p.x;
      dragStartY    = p.y;
      scrollAtDragX = cam.scrollX;
      scrollAtDragY = cam.scrollY;
      didDrag       = false;

      // ── Long-press timer (touch: replaces right-click for commands) ──
      if (this.isTouchDevice) {
        this.longPressFired = false;
        const startX = p.x, startY = p.y;

        if (this.longPressTimer) clearTimeout(this.longPressTimer);
        this.longPressTimer = setTimeout(() => {
          const ptr = this.input.activePointer;
          const moved = Math.abs(ptr.x - startX) + Math.abs(ptr.y - startY);
          if (moved < 8 && ptr.isDown && !isPinching) {
            this.longPressFired = true;
            const tx = Phaser.Math.Clamp(Math.floor(ptr.worldX / TILE_SIZE), 0, GRID_SIZE - 1);
            const ty = Phaser.Math.Clamp(Math.floor(ptr.worldY / TILE_SIZE), 0, GRID_SIZE - 1);
            if (isWalkable(this.grid, tx, ty)) {
              this.commandTile = { x: tx, y: ty };
              this.applyCommand(tx, ty);
              this.drawFlag();
            }
          }
        }, 500);
      }
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      // ── Pinch-to-zoom ────────────────────────────────────────────────
      if (isPinching && this.input.pointer1.isDown && this.input.pointer2.isDown) {
        const dx = this.input.pointer1.x - this.input.pointer2.x;
        const dy = this.input.pointer1.y - this.input.pointer2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (pinchStartDist === 0) return;

        const scale = dist / pinchStartDist;
        const newZoom = Phaser.Math.Clamp(pinchStartZoom * scale, this.minZoom, 5);

        // Anchor zoom to midpoint between fingers
        const midX = (this.input.pointer1.x + this.input.pointer2.x) / 2;
        const midY = (this.input.pointer1.y + this.input.pointer2.y) / 2;
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
      const ht = this.grid[hy]?.[hx];
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
      if (this.buildMode) {
        const bx = Phaser.Math.Clamp(Math.floor(p.worldX / TILE_SIZE) - 2, 0, GRID_SIZE - 5);
        const by = Phaser.Math.Clamp(Math.floor(p.worldY / TILE_SIZE) - 2, 0, GRID_SIZE - 5);
        this.buildPreview = { x: bx, y: by };
        this.drawBuildPreview();
      }

      if (!p.isDown || p.rightButtonDown()) return;
      const panDx = (dragStartX - p.x) / cam.zoom;
      const panDy = (dragStartY - p.y) / cam.zoom;
      if (Math.abs(panDx) > 3 || Math.abs(panDy) > 3) didDrag = true;
      cam.scrollX = scrollAtDragX + panDx;
      cam.scrollY = scrollAtDragY + panDy;
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      // Cancel long-press timer
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }

      // End pinch when either finger lifts
      if (isPinching) {
        isPinching = false;
        pinchStartDist = 0;
        return;
      }

      if (didDrag || p.rightButtonReleased() || this.longPressFired) return;

      // Build mode: place room on click
      if (this.buildMode) {
        this.placeRoom();
        return;
      }

      const tx = Math.floor(p.worldX / TILE_SIZE);
      const ty = Math.floor(p.worldY / TILE_SIZE);

      // ── Snap-to-nearest helper for touch (2-tile Manhattan radius) ──
      const SNAP_RADIUS = this.isTouchDevice ? 2 : 0;

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

      const foodIdx = findStockpile(this.foodStockpiles);
      if (foodIdx >= 0) {
        this.selectedGoblinId = null;
        bus.emit('adventurerSelect', null);
        bus.emit('stockpileSelect', { kind: 'food', idx: foodIdx });
        return;
      }
      const oreIdx = findStockpile(this.oreStockpiles);
      if (oreIdx >= 0) {
        this.selectedGoblinId = null;
        bus.emit('adventurerSelect', null);
        bus.emit('stockpileSelect', { kind: 'ore', idx: oreIdx });
        return;
      }
      const woodIdx = findStockpile(this.woodStockpiles);
      if (woodIdx >= 0) {
        this.selectedGoblinId = null;
        bus.emit('adventurerSelect', null);
        bus.emit('stockpileSelect', { kind: 'wood', idx: woodIdx });
        return;
      }

      // Check for adventurer click (with snap on touch)
      const findNearest = <T extends { x: number; y: number }>(list: T[]) => {
        if (SNAP_RADIUS === 0) return list.find(e => e.x === tx && e.y === ty);
        let best: T | undefined, bestDist = Infinity;
        for (const e of list) {
          const d = Math.abs(e.x - tx) + Math.abs(e.y - ty);
          if (d <= SNAP_RADIUS && d < bestDist) { bestDist = d; best = e; }
        }
        return best;
      };

      const adventurer = findNearest(this.adventurers);
      if (adventurer) {
        this.selectedGoblinId = null;
        bus.emit('stockpileSelect', null);
        bus.emit('adventurerSelect', adventurer);
        return;
      }

      // Left tap: select goblin — prefer alive, fall back to dead ghost
      const aliveGoblins = this.goblins.filter(d => d.alive);
      const deadDwarves  = this.goblins.filter(d => !d.alive);
      const hitAlive = findNearest(aliveGoblins);
      const hitDead  = !hitAlive ? findNearest(deadDwarves) : undefined;
      this.selectedGoblinId = (hitAlive ?? hitDead)?.id ?? null;
      bus.emit('stockpileSelect', null);
      bus.emit('adventurerSelect', null);
      this.emitGameState(); // update panel immediately even when paused
    });

    this.input.on('wheel',
      (ptr: Phaser.Input.Pointer, _objs: unknown, _dx: number, deltaY: number) => {
        const oldZoom  = cam.zoom;

        // Clamp deltaY to ±100 so a single trackpad flick doesn't jump the full range.
        // Then use a small logarithmic step (3% per 100px of delta) so the zoom feels
        // proportional rather than jumping 10% per tick.
        const clampedDelta = Phaser.Math.Clamp(deltaY, -100, 100);
        const factor = 1 - clampedDelta * 0.0003;   // e.g. deltaY=100 → factor=0.97 (−3%)
        const newZoom  = Phaser.Math.Clamp(oldZoom * factor, this.minZoom, 5);
        if (newZoom === oldZoom) return;

        // Phaser 3 uses a viewport-centred transform — scrollX is NOT the world position
        // at the left edge, it's offset by halfWidth. The correct zoom-to-cursor formula
        // adjusts scroll by (cursor-from-viewport-centre) × (zoom-factor-delta).
        const f = 1 / oldZoom - 1 / newZoom;
        cam.zoom = newZoom;
        cam.scrollX += (ptr.x - cam.x - cam.width  / 2) * f;
        cam.scrollY += (ptr.y - cam.y - cam.height / 2) * f;
      },
    );
  }

  /** Send commandTarget to selected goblin (or all if none selected). */
  private applyCommand(tx: number, ty: number) {
    const targets = this.selectedGoblinId
      ? this.goblins.filter(d => d.alive && d.id === this.selectedGoblinId)
      : this.goblins.filter(d => d.alive);

    for (const d of targets) {
      d.commandTarget = { x: tx, y: ty };
    }

    const who = this.selectedGoblinId
      ? (this.goblins.find(d => d.id === this.selectedGoblinId)?.name ?? '?')
      : `${targets.length} goblins`;

    bus.emit('logEntry', {
      tick:       this.tick,
      goblinId:    this.selectedGoblinId ?? 'all',
      goblinName:  who,
      message:    `ordered to (${tx},${ty})`,
      level:      'info',
    });
  }

  /** Check if a room can be placed at (rx,ry) with size (w,h). */
  private canPlaceRoom(rx: number, ry: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tx = rx + dx, ty = ry + dy;
        if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) return false;
        const t = this.grid[ty][tx];
        if (t.type === TileType.Water || t.type === TileType.Wall
          || t.type === TileType.Stone || t.type === TileType.Ore) return false;
      }
    }
    // Check overlap with existing rooms
    for (const r of this.rooms) {
      if (rx < r.x + r.w && rx + w > r.x && ry < r.y + r.h && ry + h > r.y) return false;
    }
    return true;
  }

  /** Draw the build-mode preview overlay. */
  private drawBuildPreview() {
    this.buildPreviewGfx.clear();
    if (!this.buildMode || !this.buildPreview) return;
    const { x, y } = this.buildPreview;
    const w = 5, h = 5;
    const valid = this.canPlaceRoom(x, y, w, h);
    const color = valid ? 0x00ff00 : 0xff0000;
    const alpha = 0.3;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.buildPreviewGfx.fillStyle(color, alpha);
        this.buildPreviewGfx.fillRect((x + dx) * TILE_SIZE, (y + dy) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
    // Outline
    this.buildPreviewGfx.lineStyle(1, color, 0.7);
    this.buildPreviewGfx.strokeRect(x * TILE_SIZE, y * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE);
  }

  /** Place a room at the current build preview location. */
  private placeRoom() {
    if (!this.buildMode || !this.buildPreview) return;
    const { x, y } = this.buildPreview;
    const w = 5, h = 5;
    if (!this.canPlaceRoom(x, y, w, h)) return;

    const room: Room = {
      id: `room-${Date.now()}`,
      type: this.buildMode,
      x, y, w, h,
    };
    this.rooms.push(room);

    bus.emit('logEntry', {
      tick:       this.tick,
      goblinId:    'world',
      goblinName:  'COLONY',
      message:    `Storage zone designated at (${x},${y})!`,
      level:      'info',
    });

    this.buildMode = null;
    this.buildPreview = null;
    this.buildPreviewGfx.clear();
    this.terrainDirty = true;
  }

  /** Yellow flag marker on the active command tile. */
  private drawFlag() {
    this.flagGfx.clear();
    if (!this.commandTile) return;
    const px = this.commandTile.x * TILE_SIZE;
    const py = this.commandTile.y * TILE_SIZE;
    this.flagGfx.lineStyle(2, 0xffff00, 0.9);
    this.flagGfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    // Inner X
    this.flagGfx.lineStyle(1, 0xffff00, 0.5);
    this.flagGfx.lineBetween(px + 2, py + 2, px + TILE_SIZE - 2, py + TILE_SIZE - 2);
    this.flagGfx.lineBetween(px + TILE_SIZE - 2, py + 2, px + 2, py + TILE_SIZE - 2);
  }

  // ── Simulation tick ────────────────────────────────────────────────────

  private gameTick() {
    this.tick++;

    // ── Weather tick ─────────────────────────────────────────────────────
    const weatherMsg = tickWeather(this.weather, this.tick);
    if (weatherMsg) {
      bus.emit('logEntry', {
        tick:      this.tick,
        goblinId:   'system',
        goblinName: 'WEATHER',
        message:   weatherMsg,
        level:     'info',
      });
    }

    // ── Diffusion fields ─────────────────────────────────────────────────
    const hearths = findHearths(this.grid);
    computeWarmth(this.grid, hearths, this.foodStockpiles, this.weather.type, this.warmthField);
    computeDanger(this.grid, this.adventurers, this._dangerFieldPrev, this.dangerField);
    this._dangerFieldPrev.set(this.dangerField);
    updateTraffic(this.grid, this.goblins);
    // Cache warmth on each goblin — smoothed (90% old / 10% new) so the bar decays gradually
    // as goblins walk away from a hearth (~10 ticks to feel it) rather than snapping to 0
    // the moment they step outside the 8-tile warmth radius.
    for (const d of this.goblins) {
      if (d.alive) {
        const raw = this.warmthField[d.y * GRID_SIZE + d.x];
        d.warmth = (d.warmth ?? raw) * 0.95 + raw * 0.05;
      }
    }

    // PIANO step 6 — check pending outcome verifications, log surprises
    const surprises = llmSystem.checkVerifications(this.goblins, this.tick);
    for (const msg of surprises) {
      bus.emit('logEntry', {
        tick:      this.tick,
        goblinId:   'system',
        goblinName: 'VERIFY',
        message:   msg,
        level:     'warn',
      });
    }

    for (const d of this.goblins) {
      const wasAlive = d.alive;
      tickAgentUtility(d, this.grid, this.tick, this.goblins, (message, level) => {
        bus.emit('logEntry', {
          tick:      this.tick,
          goblinId:   d.id,
          goblinName: d.name,
          message,
          level,
        });
      }, this.foodStockpiles, this.adventurers, this.oreStockpiles, this.colonyGoal ?? undefined, this.woodStockpiles,
      metabolismModifier(this.weather), this.warmthField, this.dangerField, this.weather.type, this.rooms);
      if (wasAlive && !d.alive) {
        this.pendingSuccessions.push({ deadGoblinId: d.id, spawnAtTick: this.tick + SUCCESSION_DELAY });
      }

      // Fire async LLM crisis check — never blocks the game loop
      llmSystem.requestDecision(d, this.goblins, this.grid, this.tick, this.adventurers,
        (goblin, decision, situation) => {
          goblin.llmReasoning = decision.reasoning;
          goblin.task         = decision.action;  // show LLM action string as task label

          // Store structured intent with expiry (~7.5 s at 7 ticks/s)
          if (decision.intent && decision.intent !== 'none') {
            goblin.llmIntent       = decision.intent;
            goblin.llmIntentExpiry = this.tick + 50;
          }

          // Push to rolling memory (uncapped; last 5 entries used in LLM prompts)
          goblin.memory.push({ tick: this.tick, crisis: situation.type, action: decision.action, reasoning: decision.reasoning });

          bus.emit('logEntry', {
            tick:      this.tick,
            goblinId:   goblin.id,
            goblinName: goblin.name,
            message:   `[${situation.type}] ${decision.intent ?? 'none'} — "${decision.reasoning}"`,
            level:     'warn',
          });
        },
        this.colonyGoal,
      );
    }

    growback(this.grid, growbackModifier(this.weather), this.tick);
    tickBurningGoblins(this.grid, this.tick, this.goblins, (msg, level) => {
      bus.emit('logEntry', { tick: this.tick, goblinId: 'world', goblinName: 'FIRE', message: msg, level });
    });
    tickPooling(this.grid, this.tick, this.weather.type);
    tickLightning(this.grid, this.tick, this.weather.type, (msg, level) => {
      bus.emit('logEntry', { tick: this.tick, goblinId: 'world', goblinName: 'STORM', message: msg, level });
    });
    tickFire(this.grid, this.tick, this.goblins, this.weather.type, (msg, level) => {
      bus.emit('logEntry', { tick: this.tick, goblinId: 'world', goblinName: 'FIRE', message: msg, level });
    });

    // ── Adventurer raids ───────────────────────────────────────────────────────
    const raid = maybeSpawnRaid(this.grid, this.goblins, this.tick);
    if (raid) {
      this.adventurers.push(...raid.adventurers);
      bus.emit('logEntry', {
        tick:      this.tick,
        goblinId:   'adventurer',
        goblinName: 'RAID',
        message:   `⚔ ${raid.count} ${getActiveFaction().enemyNounPlural} storm from the ${raid.edge}! ${getActiveFaction().raidSuffix}`,
        level:     'error',
      });
    }

    if (this.adventurers.length > 0) {
      const gr = tickAdventurers(this.adventurers, this.goblins, this.grid, this.tick);

      // Apply damage to targeted goblins
      for (const { goblinId, damage } of gr.attacks) {
        const d = this.goblins.find(dw => dw.id === goblinId);
        if (d && d.alive) {
          d.health = Math.max(0, d.health - damage);
          d.morale = Math.max(0, d.morale - 5);
          const enemyNoun = getActiveFaction().enemyNounPlural;
          if (d.health <= 0) {
            d.alive        = false;
            d.task         = 'dead';
            d.causeOfDeath = `killed by ${enemyNoun}`;
            bus.emit('logEntry', {
              tick:      this.tick,
              goblinId:   d.id,
              goblinName: d.name,
              message:   `killed by ${enemyNoun}!`,
              level:     'error',
            });
            this.pendingSuccessions.push({ deadGoblinId: d.id, spawnAtTick: this.tick + SUCCESSION_DELAY });
          } else {
            const enemySing = enemyNoun.replace(/s$/, '');
            // Survived — batch hits to reduce log noise (log every 3rd hit)
            d.memory.push({ tick: this.tick, crisis: 'combat', action: `hit by ${enemySing}, ${d.health.toFixed(0)} hp remaining` });
            const hits = (this.combatHits.get(d.id) ?? 0) + 1;
            this.combatHits.set(d.id, hits);
            if (hits % 3 === 1) {  // log 1st hit, then every 3rd
              bus.emit('logEntry', {
                tick:      this.tick,
                goblinId:   d.id,
                goblinName: d.name,
                message:   hits === 1
                  ? `⚔ hit by ${enemySing}! (${d.health.toFixed(0)} hp)`
                  : `⚔ fighting ${enemySing} (${hits} hits taken, ${d.health.toFixed(0)} hp)`,
                level:     'warn',
              });
            }
            // Wound roll — 60% chance of injury per hit (if not already wounded)
            const w = rollWound(d, this.tick);
            if (w) {
              d.wound = w;
              bus.emit('logEntry', {
                tick:      this.tick,
                goblinId:   d.id,
                goblinName: d.name,
                message:   `🩹 suffered a ${woundLabel(w.type)}!`,
                level:     'warn',
              });
            }
          }
        }
      }

      // Emit adventurer action log entries
      for (const { message, level } of gr.logs) {
        bus.emit('logEntry', {
          tick:      this.tick,
          goblinId:   'adventurer',
          goblinName: 'GOBLIN',
          message,
          level,
        });
      }

      // Remove dead adventurers and their sprites
      if (gr.adventurerDeaths.length > 0) {
        const deadIds = new Set(gr.adventurerDeaths);
        this.adventurers  = this.adventurers.filter(g => !deadIds.has(g.id));
        this.adventurerKillCount += gr.adventurerDeaths.length;
        for (const id of gr.adventurerDeaths) {
          const spr = this.adventurerSprites.get(id);
          if (spr) { spr.destroy(); this.adventurerSprites.delete(id); }
        }
        // Add kill memory to the goblins that scored the kill
        for (const { goblinId } of gr.kills) {
          const killer = this.goblins.find(dw => dw.id === goblinId && dw.alive);
          if (killer) {
            killer.adventurerKills += 1;
            const factionCfg = getActiveFaction();
            const killVerb   = factionCfg.killVerb;
            const enemySing  = factionCfg.enemyNounPlural.replace(/s$/, '');
            const article    = /^[aeiou]/i.test(enemySing) ? 'an' : 'a';
            killer.memory.push({ tick: this.tick, crisis: 'combat', action: `${killVerb} ${article} ${enemySing} in battle` });
            const hitsTaken = this.combatHits.get(killer.id) ?? 0;
            this.combatHits.delete(killer.id);
            bus.emit('logEntry', {
              tick:      this.tick,
              goblinId:   killer.id,
              goblinName: killer.name,
              message:   hitsTaken > 0
                ? `⚔ ${killVerb} ${article} ${enemySing}! (took ${hitsTaken} hits, ${killer.health.toFixed(0)} hp)`
                : `⚔ ${killVerb} ${article} ${enemySing}!`,
              level:     'warn',
            });
          }
        }
      }
    }

    // World events — tension-aware storyteller biases event selection
    const ev = tickWorldEvents(this.grid, this.tick, this.goblins, this.adventurers);
    if (ev.fired) {
      bus.emit('logEntry', {
        tick:      this.tick,
        goblinId:   'world',
        goblinName: 'WORLD',
        message:   ev.message,
        level:     'warn',
      });
    }

    // Small steady mushroom sprouting — every 150 ticks, a fresh 1–4 tile patch
    // (no log — too routine, clutters the event feed)
    tickMushroomSprout(this.grid, this.tick);

    // ── Succession — spawn queued replacements ──────────────────────────────
    for (let i = this.pendingSuccessions.length - 1; i >= 0; i--) {
      const s = this.pendingSuccessions[i];
      if (this.tick < s.spawnAtTick) continue;
      this.pendingSuccessions.splice(i, 1);

      const dead = this.goblins.find(d => d.id === s.deadGoblinId);
      if (!dead) continue;

      const successor = spawnSuccessor(dead, this.grid, this.spawnZone, this.goblins, this.tick);
      const depotCenter = this.foodStockpiles[0]
        ?? { x: Math.floor(this.spawnZone.x + this.spawnZone.w / 2), y: Math.floor(this.spawnZone.y + this.spawnZone.h / 2) };
      successor.homeTile = { x: depotCenter.x, y: depotCenter.y };
      this.goblins.push(successor);

      bus.emit('logEntry', {
        tick:      this.tick,
        goblinId:   successor.id,
        goblinName: successor.name,
        message:   `arrives to take ${dead.name}'s place. [${successor.role.toUpperCase()}]`,
        level:     'info',
      });

      // LLM arrival thought — detached, never blocks the game loop
      if (llmSystem.enabled) {
        callSuccessionLLM(dead, successor).then(text => {
          const thought = text ?? `I heard what happened to ${dead.name}. I will not make the same mistakes.`;
          successor.llmReasoning = thought;
          successor.memory.push({ tick: this.tick, crisis: 'arrival', action: `arrived to replace ${dead.name}`, reasoning: thought });
        });
      } else {
        const thought = `I heard what happened to ${dead.name}. I will not make the same mistakes.`;
        successor.llmReasoning = thought;
        successor.memory.push({ tick: this.tick, crisis: 'arrival', action: `arrived to replace ${dead.name}`, reasoning: thought });
      }
    }

    // ── Sync stockpile graphics (actions may have added new stockpiles) ─────
    while (this.foodStockpileGfxList.length < this.foodStockpiles.length) {
      this.addFoodStockpileGraphics(this.foodStockpiles[this.foodStockpileGfxList.length]);
    }
    while (this.oreStockpileGfxList.length < this.oreStockpiles.length) {
      this.addOreStockpileGraphics(this.oreStockpiles[this.oreStockpileGfxList.length]);
    }
    while (this.woodStockpileGfxList.length < this.woodStockpiles.length) {
      this.addWoodStockpileGraphics(this.woodStockpiles[this.woodStockpileGfxList.length]);
    }

    // ── Storage expansion — new stockpile within owning room when last fills ──
    this.expandStockpilesInRooms();

    this.terrainDirty = true;

    // Clear flag once all commanded goblins have arrived
    if (this.commandTile) {
      const anyPending = this.goblins.some(d => d.alive && d.commandTarget !== null);
      if (!anyPending) {
        this.commandTile = null;
        this.flagGfx.clear();
      }
    }

    this.updateGoalProgress();

    if (this.tick % 5 === 0) this.emitMiniMap();
    this.emitGameState();

    // Auto-save every 300 ticks (~45 s at default speed)
    if (this.tick % 100 === 0) saveGame(this.buildSaveData());
  }

  private togglePause() {
    this.paused = !this.paused;
    this.emitGameState();
  }

  private adjustSpeed(dir: 1 | -1) {
    const i = this.SPEED_STEPS.indexOf(this.speedMultiplier);
    const next = i + dir;
    if (next >= 0 && next < this.SPEED_STEPS.length) {
      this.speedMultiplier = this.SPEED_STEPS[next];
      this.emitGameState();
    }
  }

  private cycleSelected(direction: 1 | -1) {
    const alive = this.goblins.filter(d => d.alive);
    if (alive.length === 0) return;
    const currentIdx = alive.findIndex(d => d.id === this.selectedGoblinId);
    const nextIdx = ((currentIdx + direction) + alive.length) % alive.length;
    this.selectedGoblinId = alive[nextIdx].id;
    this.emitGameState();
  }

  private emitMiniMap() {
    const cam    = this.cameras.main;
    const tpx    = TILE_SIZE;
    const view   = cam.worldView;
    const data: MiniMapData = {
      tiles: this.grid.map(row => row.map(t => ({
        type:      t.type,
        foodRatio: t.maxFood     > 0 ? t.foodValue     / t.maxFood     : 0,
        matRatio:  t.maxMaterial > 0 ? t.materialValue / t.maxMaterial : 0,
      }))),
      goblins: this.goblins
        .filter(d => d.alive)
        .map(d => ({ x: d.x, y: d.y, hunger: d.hunger })),
      adventurers: this.adventurers.map(g => ({ x: g.x, y: g.y })),
      viewport: {
        x: view.x / tpx,
        y: view.y / tpx,
        w: view.width  / tpx,
        h: view.height / tpx,
      },
    };
    bus.emit('miniMapUpdate', data);
  }

  private emitGameState() {
    const alive = this.goblins.filter(d => d.alive);
    bus.emit('gameState', {
      tick:            this.tick,
      goblins:         this.goblins.map(d => ({ ...d })),
      totalFood:       alive.reduce((s, d) => s + d.inventory.food, 0),
      totalOre:        alive.reduce((s, d) => s + d.inventory.ore, 0),
      totalWood:       alive.reduce((s, d) => s + d.inventory.wood, 0),
      selectedGoblinId: this.selectedGoblinId,
      overlayMode:     this.overlayMode,
      paused:          this.paused,
      speed:           this.speedMultiplier,
      colonyGoal:      { ...this.colonyGoal },
      foodStockpiles:  this.foodStockpiles.map(d => ({ ...d })),
      oreStockpiles:   this.oreStockpiles.map(s => ({ ...s })),
      woodStockpiles:  this.woodStockpiles.map(s => ({ ...s })),
      weatherSeason:   this.weather.season,
      weatherType:     this.weather.type,
      rooms:           this.rooms.map(r => ({ ...r })),
    });
  }

  // ── Colony goal ────────────────────────────────────────────────────────

  private updateGoalProgress() {
    const alive = this.goblins.filter(d => d.alive);
    switch (this.colonyGoal.type) {
      case 'stockpile_food':
        this.colonyGoal.progress = this.foodStockpiles.reduce((sum, d) => sum + d.food, 0);
        break;
      case 'survive_ticks':
        this.colonyGoal.progress = this.tick - this.goalStartTick;
        break;
      case 'defeat_adventurers':
        this.colonyGoal.progress = this.adventurerKillCount;
        break;
      case 'enclose_fort': {
        const remaining = roomWallSlots(this.rooms, this.grid, this.goblins, '', this.adventurers);
        this.colonyGoal.progress = (this.rooms.length > 0 && remaining.length === 0) ? 1 : 0;
        break;
      }
    }
    if (this.colonyGoal.progress >= this.colonyGoal.target) {
      this.completeGoal(alive);
    }
  }

  private completeGoal(alive: Goblin[]) {
    // Snapshot completed goal before cycling — needed for storyteller prompt
    const completedGoal = { ...this.colonyGoal };
    const gen = this.colonyGoal.generation + 1;
    for (const d of alive) {
      d.morale = Math.min(100, d.morale + 15);
    }
    bus.emit('logEntry', {
      tick:      this.tick,
      goblinId:   'world',
      goblinName: 'COLONY',
      message:   `✓ Goal complete: ${this.colonyGoal.description}! Morale boost for all!`,
      level:     'info',
    });
    const GOAL_TYPES: ColonyGoal['type'][] = ['stockpile_food', 'survive_ticks', 'defeat_adventurers', 'enclose_fort'];
    const curr = GOAL_TYPES.indexOf(this.colonyGoal.type);
    const next = GOAL_TYPES[(curr + 1) % GOAL_TYPES.length];
    // Reset relevant counters so the new goal tracks from zero
    // Note: food stockpile and ore stockpile totals are intentionally NOT cleared on goal completion
    if (next === 'defeat_adventurers') this.adventurerKillCount = 0;
    this.goalStartTick = this.tick;
    this.colonyGoal = WorldScene.makeGoal(next, gen);

    // Fire storyteller (detached — never blocks game loop)
    const significantEvents = filterSignificantEvents(this.logHistory, this.lastChapterTick);
    const chapterNum = this.chapters.length + 1;
    const snapshotTick = this.tick;
    callStorytellerLLM(completedGoal, this.goblins, this.adventurers, significantEvents, snapshotTick)
      .then(text => {
        const chapter: Chapter = {
          chapterNumber:  chapterNum,
          goalType:       completedGoal.type,
          goalGeneration: completedGoal.generation,
          text: text ?? buildFallbackChapter(completedGoal, alive, significantEvents),
          tick: snapshotTick,
        };
        this.chapters.push(chapter);
        this.lastChapterTick = snapshotTick;
        bus.emit('chronicleChapter', chapter);
      });
  }

  /** Find the next stockpile slot within a room, spiraling from center. */
  private findRoomStockpileSlot(
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
          if (this.grid[ty][tx].type === TileType.Water || this.grid[ty][tx].type === TileType.Wall) continue;
          return { x: tx, y: ty };
        }
      }
    }
    return null;
  }

  /** Expand stockpiles within their owning rooms when the last unit fills up. */
  private expandStockpilesInRooms() {
    const allOccupied = new Set([
      ...this.foodStockpiles.map(s => `${s.x},${s.y}`),
      ...this.oreStockpiles.map(s => `${s.x},${s.y}`),
      ...this.woodStockpiles.map(s => `${s.x},${s.y}`),
    ]);

    for (const room of this.rooms) {
      if (!room.specialization) continue;

      if (room.specialization === 'food') {
        const roomPiles = this.foodStockpiles.filter(s =>
          s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
        const last = roomPiles[roomPiles.length - 1];
        if (last && last.food >= last.maxFood) {
          const pos = this.findRoomStockpileSlot(room, allOccupied);
          if (pos) {
            const nd: FoodStockpile = { ...pos, food: 0, maxFood: 200 };
            this.foodStockpiles.push(nd);
            this.addFoodStockpileGraphics(nd);
            allOccupied.add(`${pos.x},${pos.y}`);
          }
        }
      } else if (room.specialization === 'ore') {
        const roomPiles = this.oreStockpiles.filter(s =>
          s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
        const last = roomPiles[roomPiles.length - 1];
        if (last && last.ore >= last.maxOre) {
          const pos = this.findRoomStockpileSlot(room, allOccupied);
          if (pos) {
            const ns: OreStockpile = { ...pos, ore: 0, maxOre: 200 };
            this.oreStockpiles.push(ns);
            this.addOreStockpileGraphics(ns);
            allOccupied.add(`${pos.x},${pos.y}`);
          }
        }
      } else if (room.specialization === 'wood') {
        const roomPiles = this.woodStockpiles.filter(s =>
          s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h);
        const last = roomPiles[roomPiles.length - 1];
        if (last && last.wood >= last.maxWood) {
          const pos = this.findRoomStockpileSlot(room, allOccupied);
          if (pos) {
            const nw: WoodStockpile = { ...pos, wood: 0, maxWood: 200 };
            this.woodStockpiles.push(nw);
            this.addWoodStockpileGraphics(nw);
            allOccupied.add(`${pos.x},${pos.y}`);
          }
        }
      }
    }
  }

  /** Create Phaser graphics + sprite objects for a newly added food stockpile. */
  private addFoodStockpileGraphics(stockpile: FoodStockpile): void {
    const cx  = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy  = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.foodStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.foodStockpile));
    this.foodStockpileGfxList.push(this.add.graphics());
  }

  /** Create Phaser graphics + sprite objects for a newly added ore stockpile. */
  private addOreStockpileGraphics(stockpile: OreStockpile): void {
    const cx  = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy  = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.oreStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.oreStockpile));
    this.oreStockpileGfxList.push(this.add.graphics());
  }

  private drawFoodStockpile() {
    for (let i = 0; i < this.foodStockpiles.length; i++) {
      const d   = this.foodStockpiles[i];
      const gfx = this.foodStockpileGfxList[i];
      if (!gfx) continue;
      const px = d.x * TILE_SIZE, py = d.y * TILE_SIZE;
      gfx.clear();
      gfx.lineStyle(2, 0xf0c040, 0.9);
      gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
  }

  private drawOreStockpile() {
    for (let i = 0; i < this.oreStockpiles.length; i++) {
      const s   = this.oreStockpiles[i];
      const gfx = this.oreStockpileGfxList[i];
      if (!gfx) continue;
      const px = s.x * TILE_SIZE, py = s.y * TILE_SIZE;
      gfx.clear();
      gfx.lineStyle(2, 0xff8800, 0.9);
      gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
  }

  /** Create Phaser graphics + sprite objects for a newly added wood stockpile. */
  private addWoodStockpileGraphics(stockpile: WoodStockpile): void {
    const cx  = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy  = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.woodStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.woodStockpile));
    this.woodStockpileGfxList.push(this.add.graphics());
  }

  private drawWoodStockpile() {
    for (let i = 0; i < this.woodStockpiles.length; i++) {
      const w   = this.woodStockpiles[i];
      const gfx = this.woodStockpileGfxList[i];
      if (!gfx) continue;
      const px = w.x * TILE_SIZE, py = w.y * TILE_SIZE;
      gfx.clear();
      gfx.lineStyle(2, 0x56d973, 0.9);  // green border — wood
      gfx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private drawTerrain() {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const tile = this.grid[y][x];
        // Look up frame(s) from tileConfig. Multiple frames = noise-selected variation.
        const frames = TILE_CONFIG[tile.type] ?? [0];
        const n      = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        const noise  = n - Math.floor(n);
        const frame  = frames.length === 1
          ? frames[0]
          : frames[Math.floor(noise * frames.length)];
        const t = this.terrainLayer.putTileAt(frame, x, y)!;

        // Tinting: food tiles dim as they deplete; player-built walls get a blue-gray
        // tint to distinguish them from natural Stone (both use frame 103).
        if (tile.maxFood > 0) {
          const ratio      = tile.foodValue / tile.maxFood;
          const brightness = Math.floor((0.5 + ratio * 0.5) * 255);
          t.tint = (brightness << 16) | (brightness << 8) | brightness;
        } else if (tile.type === TileType.Wall) {
          t.tint = 0x88aacc;  // blue-gray: player-built fort wall
        } else if (tile.type === TileType.Hearth) {
          t.tint = 0xff8844;  // warm orange: hearth fire
        } else if (tile.type === TileType.Fire) {
          const phase = (this.tick + x * 3 + y * 7) % 3;
          t.tint = phase === 0 ? 0xff2200 : phase === 1 ? 0xff6600 : 0xff4400;
        } else if (tile.type === TileType.Pool) {
          t.tint = 0x44bbaa;  // teal-green — murky shallow puddle, distinct from deep Water
        } else {
          t.tint = 0xffffff;
        }

        // Room tint overlay — blend a color based on specialization
        for (const room of this.rooms) {
          if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) {
            const roomTint = room.specialization === 'food' ? 0xccffcc
              : room.specialization === 'ore' ? 0xffddaa
              : room.specialization === 'wood' ? 0xddffcc
              : 0xccccff;
            // Multiply tint: ((t.tint_channel * roomTint_channel) >> 8) per channel
            const tr = (t.tint >> 16) & 0xff, tg = (t.tint >> 8) & 0xff, tb = t.tint & 0xff;
            const rr = (roomTint >> 16) & 0xff, rg = (roomTint >> 8) & 0xff, rb = roomTint & 0xff;
            t.tint = (((tr * rr) >> 8) << 16) | (((tg * rg) >> 8) << 8) | ((tb * rb) >> 8);
            break;
          }
        }
      }
    }
    this.terrainDirty = false;
  }

  /** Colored semi-transparent overlay showing food or material density. */
  private drawOverlay() {
    this.overlayGfx.clear();
    if (this.overlayMode === 'off') return;

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const tile = this.grid[y][x];
        let alpha = 0;
        let color = 0;

        if (this.overlayMode === 'food' && tile.maxFood > 0) {
          alpha = (tile.foodValue / tile.maxFood) * 0.65;
          color = 0x00dd44; // green
        } else if (this.overlayMode === 'material' && tile.maxMaterial > 0 && tile.type !== TileType.Forest) {
          alpha = (tile.materialValue / tile.maxMaterial) * 0.65;
          color = 0xff8800; // amber
        } else if (this.overlayMode === 'wood' && tile.type === TileType.Forest && tile.maxMaterial > 0) {
          alpha = (tile.materialValue / tile.maxMaterial) * 0.65;
          color = 0x56d973; // green
        } else if (this.overlayMode === 'warmth') {
          const w = this.warmthField[y * GRID_SIZE + x];
          if (w > 0) { alpha = (w / 100) * 0.6; color = 0xff6600; } // orange-red
        } else if (this.overlayMode === 'danger') {
          const d = this.dangerField[y * GRID_SIZE + x];
          if (d > 0) { alpha = (d / 100) * 0.6; color = 0xff2222; } // red
        } else if (this.overlayMode === 'traffic') {
          const tr = tile.trafficScore ?? 0;
          if (tr > 0) { alpha = (tr / 100) * 0.6; color = 0xffee00; } // yellow
        }

        if (alpha > 0.02) {
          this.overlayGfx.fillStyle(color, alpha);
          this.overlayGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }
    }
  }

  /** Arrow at viewport edge pointing toward the selected goblin when off-screen. */
  private drawOffScreenIndicator() {
    this.offScreenGfx.clear();
    if (!this.selectedGoblinId) return;

    const d = this.goblins.find(dw => dw.id === this.selectedGoblinId && dw.alive);
    if (!d) return;

    const cam  = this.cameras.main;
    const view = cam.worldView;

    // Screen position of goblin (world → screen)
    const sx = (d.x * TILE_SIZE + TILE_SIZE / 2 - view.x) * cam.zoom;
    const sy = (d.y * TILE_SIZE + TILE_SIZE / 2 - view.y) * cam.zoom;

    const margin = 24;
    const sw = cam.width;
    const sh = cam.height;

    if (sx >= margin && sx <= sw - margin && sy >= margin && sy <= sh - margin) return;

    // Clamp arrow tip to viewport edge with margin
    const cx  = sw / 2;
    const cy  = sh / 2;
    const dx  = sx - cx;
    const dy  = sy - cy;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx  = dx / len;
    const ny  = dy / len;

    // Clamp along the direction until we hit an edge
    const scaleX = Math.abs(nx) > 0.001 ? (nx > 0 ? (sw - margin - cx) : (cx - margin)) / Math.abs(dx) : Infinity;
    const scaleY = Math.abs(ny) > 0.001 ? (ny > 0 ? (sh - margin - cy) : (cy - margin)) / Math.abs(dy) : Infinity;
    const t = Math.min(scaleX, scaleY);
    const ax = cx + dx * t;
    const ay = cy + dy * t;

    // Draw filled triangle arrow pointing toward goblin
    const angle   = Math.atan2(ny, nx);
    const tipSize = 10;
    const baseHalf = 6;
    const tx0 = ax + Math.cos(angle) * tipSize;
    const ty0 = ay + Math.sin(angle) * tipSize;
    const tx1 = ax + Math.cos(angle + Math.PI * 0.7) * baseHalf;
    const ty1 = ay + Math.sin(angle + Math.PI * 0.7) * baseHalf;
    const tx2 = ax + Math.cos(angle - Math.PI * 0.7) * baseHalf;
    const ty2 = ay + Math.sin(angle - Math.PI * 0.7) * baseHalf;

    this.offScreenGfx.fillStyle(0xffff00, 0.85);
    this.offScreenGfx.fillTriangle(tx0, ty0, tx1, ty1, tx2, ty2);
    this.offScreenGfx.lineStyle(1, 0x888800, 0.5);
    this.offScreenGfx.strokeTriangle(tx0, ty0, tx1, ty1, tx2, ty2);
  }

  private drawAgents() {
    this.selectionGfx.clear();

    // Convert newly-dead goblins to tombstone sprites and remove their live sprite.
    // Ghost sprites are created once and stay until a new game.
    const TOMBSTONE_FRAME = SPRITE_CONFIG.tombstone ?? GOBLIN_FRAME;
    for (const [id, spr] of this.goblinSprites) {
      const d = this.goblins.find(dw => dw.id === id);
      if (!d || !d.alive) {
        if (!this.goblinGhostSprites.has(id)) {
          const ghost = this.add.sprite(spr.x, spr.y, 'tiles', TOMBSTONE_FRAME);
          ghost.setTint(0xaaaaaa); // gray tombstone
          this.goblinGhostSprites.set(id, ghost);
        }
        spr.destroy();
        this.goblinSprites.delete(id);
      }
    }

    // Red selection ring on ghost sprites of dead goblins
    for (const [id, spr] of this.goblinGhostSprites) {
      if (id === this.selectedGoblinId) {
        this.selectionGfx.lineStyle(2, 0xff4444, 0.85);
        this.selectionGfx.strokeCircle(spr.x, spr.y, TILE_SIZE / 2 + 3);
      }
    }

    for (const d of this.goblins) {
      if (!d.alive) continue;

      const px = d.x * TILE_SIZE + TILE_SIZE / 2;
      const py = d.y * TILE_SIZE + TILE_SIZE / 2;

      // Get or create sprite
      let spr = this.goblinSprites.get(d.id);
      if (!spr) {
        spr = this.add.sprite(px, py, 'tiles', GOBLIN_FRAME);
        this.goblinSprites.set(d.id, spr);
      } else {
        spr.setPosition(px, py);
      }

      // Burning goblins flicker fire colours; otherwise shift green → red with hunger
      if (d.onFire) {
        const phase = (this.tick + parseInt(d.id, 36)) % 3;
        spr.setTint(phase === 0 ? 0xff2200 : phase === 1 ? 0xff6600 : 0xff4400);
      } else {
        const hr = d.hunger / 100;
        const r  = Math.floor(60 + hr * 195);
        const g  = Math.floor(200 - hr * 150);
        spr.setTint((r << 16) | (g << 8) | 60);
      }

      // Yellow selection ring
      if (d.id === this.selectedGoblinId) {
        this.selectionGfx.lineStyle(2, 0xffff00, 1);
        this.selectionGfx.strokeCircle(px, py, TILE_SIZE / 2 + 3);
      }

      // Cyan ring when goblin has an active command
      if (d.commandTarget) {
        this.selectionGfx.lineStyle(1, 0x00ffff, 0.7);
        this.selectionGfx.strokeCircle(px, py, TILE_SIZE / 2 + 1);
      }
    }

    // ── Adventurer sprites ──────────────────────────────────────────────────────
    for (const g of this.adventurers) {
      const px = g.x * TILE_SIZE + TILE_SIZE / 2;
      const py = g.y * TILE_SIZE + TILE_SIZE / 2;
      let spr = this.adventurerSprites.get(g.id);
      if (!spr) {
        spr = this.add.sprite(px, py, 'tiles', ADVENTURER_FRAME);
        spr.setTint(0xff6600); // bright orange — clearly hostile
        this.adventurerSprites.set(g.id, spr);
      } else {
        spr.setPosition(px, py);
      }
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────

  update(time: number, delta: number) {
    // WASD camera pan (only when keyboard is available)
    const cam   = this.cameras.main;
    if (this.wasd) {
      const speed = CAM_PAN_SPEED * (delta / 1000) / cam.zoom;
      if (this.wasd.W.isDown) cam.scrollY -= speed;
      if (this.wasd.S.isDown) cam.scrollY += speed;
      if (this.wasd.A.isDown) cam.scrollX -= speed;
      if (this.wasd.D.isDown) cam.scrollX += speed;
    }

    // Simulation tick — skipped when paused; interval shrinks at higher speeds
    if (!this.paused && time - this.lastTickTime >= TICK_RATE_MS / this.speedMultiplier) {
      this.lastTickTime = time;
      this.gameTick();
    }

    if (this.terrainDirty) {
      this.drawTerrain();
      this.drawOverlay(); // refresh density whenever food values change
    }
    this.drawAgents();
    this.drawFoodStockpile();
    this.drawOreStockpile();
    this.drawWoodStockpile();
    this.drawOffScreenIndicator();
  }
}
