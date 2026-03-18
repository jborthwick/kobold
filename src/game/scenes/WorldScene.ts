import * as Phaser from 'phaser';
// Note: import * as Phaser is required — Phaser's dist build has no default export
import { canPlaceRoom, clearRoomGroundToDirt } from '../../simulation/rooms';
import { drawFoodStockpile, drawOreStockpile, drawWoodStockpile, drawMealStockpile, drawPlankStockpile, drawBarStockpile, drawTerrain, drawOverlay, drawAgents, drawOffScreenIndicator } from './WorldRender';
import { gameTick } from './WorldTick';
import { createWarmthField, createDangerField } from '../../simulation/diffusion';
import { TICK_RATE_MS, TILE_SIZE, HEARTH_FUEL_MAX } from '../../shared/constants';
import { type OverlayMode, type Tile, type Goblin, type Adventurer, type ColonyGoal, type FoodStockpile, type MealStockpile, type OreStockpile, type WoodStockpile, type PlankStockpile, type BarStockpile, type LogEntry, type Chapter, type Room, type RoomType, TileType } from '../../shared/types';
import type { WorkerTargets } from '../../simulation/workerTargets';
import { updateCamera } from './WorldCamera';
import { emitGameState } from './WorldState';
import * as WorldGoals from './WorldGoals';
import { bus } from '../../shared/events';
import { type Weather } from '../../simulation/weather';
import { SPRITE_CONFIG, TILE_CONFIG } from '../tileConfig';

import { initializeWorld } from './WorldInit';
import { updateWeatherFX } from './WeatherFX';

export class WorldScene extends Phaser.Scene {
  public grid: Tile[][] = [];
  public goblins: Goblin[] = [];
  public tick = 0;
  public selectedGoblinId: string | null = null;
  /** Selected hearth tile (click-to-show fuel); cleared when selecting something else. */
  public selectedHearth: { x: number; y: number } | null = null;
  /** Matches UI stockpile panel; used to draw selection ring on the map. */
  public selectedStockpile: {
    kind: 'food' | 'ore' | 'wood' | 'meal' | 'plank' | 'bar';
    idx: number;
  } | null = null;
  public selectedAdventurerId: string | null = null;
  public terrainDirty = true;
  public lastTickTime = 0;
  public paused = false;
  public speedMultiplier = 1;
  public readonly SPEED_STEPS = [0.25, 0.5, 1, 2, 4];

  // Active player command tile (shown as flag)
  public commandTile: { x: number; y: number } | null = null;

  // Tilemap for terrain
  public map!: Phaser.Tilemaps.Tilemap;
  public floorLayer!: Phaser.Tilemaps.TilemapLayer;
  public objectLayer!: Phaser.Tilemaps.TilemapLayer;

  // Graphics layers
  public selectionGfx!: Phaser.GameObjects.Graphics;
  public flagGfx!: Phaser.GameObjects.Graphics;
  public ambientGfx!: Phaser.GameObjects.Graphics;
  public overlayGfx!: Phaser.GameObjects.Graphics;
  public overlayMode: OverlayMode = 'off';

  // One sprite per living goblin
  public goblinSprites = new Map<string, Phaser.GameObjects.Sprite>();
  // Persistent grave sprites for dead goblins (red, flipped upside-down)
  public goblinGhostSprites = new Map<string, Phaser.GameObjects.Sprite>();
  // Off-screen arrow indicator for selected goblin
  public offScreenGfx!: Phaser.GameObjects.Graphics;
  // Adventurer raid state
  public adventurers: Adventurer[] = [];
  public adventurerSprites = new Map<string, Phaser.GameObjects.Sprite>();

  // Succession state
  public spawnZone!: { x: number; y: number; w: number; h: number };
  public pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[] = [];

  // Weather system — affects growback rates and goblin metabolism
  public weather!: Weather;

  // Diffusion fields — recomputed every tick, never saved
  public warmthField = createWarmthField();
  public dangerField = createDangerField();
  public dangerFieldPrev = createDangerField(); // double-buffer for decay

  // Event log noise reduction
  public combatHits = new Map<string, number>();  // goblin id → hit count this encounter

  // Colony goal + food/ore/wood stockpiles (expand as each fills up)
  public colonyGoal!: ColonyGoal;
  public workerTargets: WorkerTargets = {};
  public goalStartTick = 0;
  public adventurerKillCount = 0;
  public mealsCooked = 0;
  public foodStockpiles: FoodStockpile[] = [];
  public mealStockpiles: MealStockpile[] = [];
  public oreStockpiles: OreStockpile[] = [];
  public woodStockpiles: WoodStockpile[] = [];
  public foodStockpileGfxList: Phaser.GameObjects.Graphics[] = [];
  public foodStockpileImgList: Phaser.GameObjects.Image[] = [];
  public mealStockpileGfxList: Phaser.GameObjects.Graphics[] = [];
  public mealStockpileImgList: Phaser.GameObjects.Image[] = [];
  public oreStockpileGfxList: Phaser.GameObjects.Graphics[] = [];
  public oreStockpileImgList: Phaser.GameObjects.Image[] = [];
  public woodStockpileGfxList: Phaser.GameObjects.Graphics[] = [];
  public woodStockpileImgList: Phaser.GameObjects.Image[] = [];
  public plankStockpiles: PlankStockpile[] = [];
  public barStockpiles: BarStockpile[] = [];
  public plankStockpileGfxList: Phaser.GameObjects.Graphics[] = [];
  public plankStockpileImgList: Phaser.GameObjects.Image[] = [];
  public barStockpileGfxList: Phaser.GameObjects.Graphics[] = [];
  public barStockpileImgList: Phaser.GameObjects.Image[] = [];

  // Furniture sprites at room centers (saw in lumber_hut, anvil in blacksmith)
  public sawSprites: Phaser.GameObjects.Image[] = [];
  public anvilSprites: Phaser.GameObjects.Image[] = [];

  // Event log history (persisted to save, restored on load)
  public logHistory: LogEntry[] = [];
  // Chronicle chapters — generated by storyteller AI on goal completion
  public chapters: Chapter[] = [];
  public lastChapterTick = 0;
  // World seed — stored for save/load and display
  public worldSeed = '';

  // Player-placed rooms
  public rooms: Room[] = [];

  // Build mode state
  public buildMode: RoomType | null = null;
  public buildPreview: { x: number; y: number } | null = null;
  public buildPreviewGfx!: Phaser.GameObjects.Graphics;

  // Weather visual effects (camera-fixed particle + tint layers)
  public weatherGfx!: Phaser.GameObjects.Graphics;
  public weatherTintGfx!: Phaser.GameObjects.Graphics;

  // WASD keys (null when keyboard unavailable on touch devices)
  public wasd: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  } | null = null;

  // Touch input state
  public isTouchDevice = false;
  public longPressTimer: ReturnType<typeof setTimeout> | null = null;
  public longPressFired = false;
  public minZoom = 0.6;

  constructor() {
    super({ key: 'WorldScene' });
  }

  public static makeGoal(type: ColonyGoal['type'], generation: number): ColonyGoal {
    return WorldGoals.makeGoal(type, generation);
  }

  create() {
    initializeWorld(this);
  }

  // ── Simulation tick ────────────────────────────────────────────────────


  /** Send commandTarget to selected goblin (or all if none selected). */
  public applyCommand(tx: number, ty: number) {
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
      tick: this.tick,
      goblinId: this.selectedGoblinId ?? 'all',
      goblinName: who,
      message: `ordered to(${tx}, ${ty})`,
      level: 'info',
    });
  }


  /** Place a room at the current build preview location. */
  public placeRoom() {
    if (!this.buildMode || !this.buildPreview) return;
    const { x, y } = this.buildPreview;
    const w = 5, h = 5;
    if (!canPlaceRoom(this.grid, this.rooms, x, y, w, h)) return;
    clearRoomGroundToDirt(this.grid, x, y, w, h);

    const room: Room = {
      id: `room - ${Date.now()} `,
      type: this.buildMode,
      x, y, w, h,
    };
    this.rooms.push(room);

    if (this.buildMode === 'lumber_hut') {
      const wx = x + 1, wy = y + 1;
      this.woodStockpiles.push({ x: wx, y: wy, wood: 0, maxWood: 200 });
      this.addWoodStockpileGraphics(this.woodStockpiles[this.woodStockpiles.length - 1]);
    } else if (this.buildMode === 'blacksmith') {
      const ox = x + 1, oy = y + 1;
      this.oreStockpiles.push({ x: ox, y: oy, ore: 0, maxOre: 200 });
      this.addOreStockpileGraphics(this.oreStockpiles[this.oreStockpiles.length - 1]);
    } else if (this.buildMode === 'kitchen') {
      // Auto-place Hearth at kitchen center so cooking is immediately eligible
      const cx = x + Math.floor(5 / 2);
      const cy = y + Math.floor(5 / 2);
      const t = this.grid[cy][cx];
      this.grid[cy][cx] = { ...t, type: TileType.Hearth, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, hearthFuel: HEARTH_FUEL_MAX };
      // Update tilemap visual for the hearth tile
      const hearthFrames = TILE_CONFIG[TileType.Hearth];
      const hearthFrame = hearthFrames ? hearthFrames[0] : 504;
      this.floorLayer?.putTileAt(hearthFrame, cx, cy);

      // Auto-create an empty MealStockpile so eating from kitchen works immediately
      this.mealStockpiles.push({ x: x + 1, y: y + 1, meals: 0, maxMeals: 50 });

      // Auto-create a FoodStockpile so depositFood targets the kitchen immediately
      const foodPile: FoodStockpile = { x: x + 3, y: y + 1, food: 0, maxFood: 200 };
      this.foodStockpiles.push(foodPile);
      this.addFoodStockpileGraphics(foodPile);
    } else if (this.buildMode === 'storage') {
      const foodPile: FoodStockpile = { x: x + 1, y: y + 1, food: 0, maxFood: 200 };
      this.foodStockpiles.push(foodPile);
      this.addFoodStockpileGraphics(foodPile);
    }

    const roomName = this.buildMode === 'storage' ? 'Storage zone'
      : this.buildMode === 'kitchen' ? 'Kitchen'
        : this.buildMode === 'lumber_hut' ? 'Lumber Hut'
          : 'Blacksmith';
    bus.emit('logEntry', {
      tick: this.tick,
      goblinId: 'world',
      goblinName: 'COLONY',
      message: `${roomName} designated at (${x}, ${y})!`,
      level: 'info',
    });

    this.terrainDirty = true;

    // Auto-exit build mode after placing a room
    this.buildMode = null;
    this.buildPreview = null;
    this.buildPreviewGfx.clear();
    bus.emit('buildMode', null);
  }

  // ── Simulation tick ────────────────────────────────────────────────────


  public togglePause() {
    this.paused = !this.paused;
    emitGameState(this);
  }

  public adjustSpeed(dir: 1 | -1) {
    const i = this.SPEED_STEPS.indexOf(this.speedMultiplier);
    const next = i + dir;
    if (next >= 0 && next < this.SPEED_STEPS.length) {
      this.speedMultiplier = this.SPEED_STEPS[next];
      emitGameState(this);
    }
  }

  public cycleSelected(direction: 1 | -1) {
    const alive = this.goblins.filter(d => d.alive);
    if (alive.length === 0) return;
    const currentIdx = alive.findIndex(d => d.id === this.selectedGoblinId);
    const nextIdx = ((currentIdx + direction) + alive.length) % alive.length;
    this.selectedGoblinId = alive[nextIdx].id;
    this.selectedHearth = null;
    this.selectedStockpile = null;
    this.selectedAdventurerId = null;
    bus.emit('stockpileSelect', null);
    bus.emit('hearthSelect', null);
    bus.emit('adventurerSelect', null);
    emitGameState(this);
  }

  // ── Colony goal ────────────────────────────────────────────────────────

  /** Create Phaser graphics + sprite objects for a newly added food stockpile. */
  public addFoodStockpileGraphics(stockpile: FoodStockpile): void {
    const cx = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.foodStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.foodStockpile).setDepth(3));
    this.foodStockpileGfxList.push(this.add.graphics().setDepth(3));
  }

  /** Create Phaser graphics + sprite objects for a newly added ore stockpile. */
  public addOreStockpileGraphics(stockpile: OreStockpile): void {
    const cx = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.oreStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.oreStockpile).setDepth(3));
    this.oreStockpileGfxList.push(this.add.graphics().setDepth(3));
  }

  /** Create Phaser graphics + sprite objects for a newly added wood stockpile. */
  public addWoodStockpileGraphics(stockpile: WoodStockpile): void {
    const cx = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.woodStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.woodStockpile).setDepth(3));
    this.woodStockpileGfxList.push(this.add.graphics().setDepth(3));
  }

  /** Create Phaser graphics + sprite objects for a newly added meal stockpile (inside kitchen). */
  public addMealStockpileGraphics(stockpile: MealStockpile): void {
    const cx = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.mealStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.foodStockpile).setDepth(3).setTint(0xff9900));
    this.mealStockpileGfxList.push(this.add.graphics().setDepth(3));
  }

  public addPlankStockpileGraphics(stockpile: PlankStockpile): void {
    const cx = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.plankStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.woodStockpile).setDepth(3).setTint(0x8b7355));
    this.plankStockpileGfxList.push(this.add.graphics().setDepth(3));
  }

  public addBarStockpileGraphics(stockpile: BarStockpile): void {
    const cx = stockpile.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = stockpile.y * TILE_SIZE + TILE_SIZE / 2;
    this.barStockpileImgList.push(this.add.image(cx, cy, 'tiles', SPRITE_CONFIG.oreStockpile).setDepth(3).setTint(0x888899));
    this.barStockpileGfxList.push(this.add.graphics().setDepth(3));
  }

  /** Sync saw sprites to lumber_hut room centers (one sprite per room). */
  public syncSawSprites(): void {
    const lumberHuts = this.rooms.filter(r => r.type === 'lumber_hut');
    while (this.sawSprites.length < lumberHuts.length) {
      const room = lumberHuts[this.sawSprites.length];
      const cx = (room.x + Math.floor(room.w / 2)) * TILE_SIZE + TILE_SIZE / 2;
      const cy = (room.y + Math.floor(room.h / 2)) * TILE_SIZE + TILE_SIZE / 2;
      const frame = SPRITE_CONFIG.saw ?? 0;
      this.sawSprites.push(this.add.image(cx, cy, 'tiles', frame).setDepth(3));
    }
    while (this.sawSprites.length > lumberHuts.length) {
      this.sawSprites.pop()?.destroy();
    }
    for (let i = 0; i < this.sawSprites.length; i++) {
      const room = lumberHuts[i];
      const cx = (room.x + Math.floor(room.w / 2)) * TILE_SIZE + TILE_SIZE / 2;
      const cy = (room.y + Math.floor(room.h / 2)) * TILE_SIZE + TILE_SIZE / 2;
      this.sawSprites[i].setPosition(cx, cy);
      this.sawSprites[i].setFrame(SPRITE_CONFIG.saw ?? 0);
    }
  }

  /** Sync anvil sprites to blacksmith room centers (one sprite per room). */
  public syncAnvilSprites(): void {
    const blacksmiths = this.rooms.filter(r => r.type === 'blacksmith');
    while (this.anvilSprites.length < blacksmiths.length) {
      const room = blacksmiths[this.anvilSprites.length];
      const cx = (room.x + Math.floor(room.w / 2)) * TILE_SIZE + TILE_SIZE / 2;
      const cy = (room.y + Math.floor(room.h / 2)) * TILE_SIZE + TILE_SIZE / 2;
      const frame = SPRITE_CONFIG.anvil ?? 0;
      this.anvilSprites.push(this.add.image(cx, cy, 'tiles', frame).setDepth(3));
    }
    while (this.anvilSprites.length > blacksmiths.length) {
      this.anvilSprites.pop()?.destroy();
    }
    for (let i = 0; i < this.anvilSprites.length; i++) {
      const room = blacksmiths[i];
      const cx = (room.x + Math.floor(room.w / 2)) * TILE_SIZE + TILE_SIZE / 2;
      const cy = (room.y + Math.floor(room.h / 2)) * TILE_SIZE + TILE_SIZE / 2;
      this.anvilSprites[i].setPosition(cx, cy);
      this.anvilSprites[i].setFrame(SPRITE_CONFIG.anvil ?? 0);
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────

  update(time: number, delta: number) {
    updateCamera(this, delta);

    // Simulation tick — skipped when paused; interval shrinks at higher speeds
    if (!this.paused && time - this.lastTickTime >= TICK_RATE_MS / this.speedMultiplier) {
      this.lastTickTime = time;
      gameTick(this);
    }

    if (this.terrainDirty || !this.paused) {
      if (this.terrainDirty) drawTerrain(this);
      drawOverlay(this); // refresh density + ambient glow
    }
    drawAgents(this);
    drawFoodStockpile(this);
    drawMealStockpile(this);
    drawOreStockpile(this);
    drawWoodStockpile(this);
    drawPlankStockpile(this);
    drawBarStockpile(this);
    drawOffScreenIndicator(this);
    updateWeatherFX(this, delta);
  }
}
