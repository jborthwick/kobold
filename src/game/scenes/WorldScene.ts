import * as Phaser from 'phaser';
// Note: import * as Phaser is required — Phaser's dist build has no default export
import { generateWorld, growback, isWalkable } from '../../simulation/world';
import { spawnDwarves, tickAgent, spawnSuccessor, SUCCESSION_DELAY } from '../../simulation/agents';
import { maybeSpawnRaid, tickGoblins, resetGoblins, spawnInitialGoblins } from '../../simulation/goblins';
import { bus } from '../../shared/events';
import { GRID_SIZE, TILE_SIZE, TICK_RATE_MS } from '../../shared/constants';
import { TileType, type OverlayMode, type Tile, type Dwarf, type Goblin, type GameState, type TileInfo, type MiniMapData, type ColonyGoal, type FoodStockpile, type OreStockpile, type LogEntry } from '../../shared/types';
import { llmSystem, callSuccessionLLM } from '../../ai/crisis';
import { tickWorldEvents, resetWorldEvents } from '../../simulation/events';
import { TILE_CONFIG, SPRITE_CONFIG } from '../tileConfig';
import { saveGame, loadGame, type SaveData } from '../../shared/save';

// Frame assignments live in src/game/tileConfig.ts — edit them there
// or use the in-game tile picker (press T).
const DWARF_FRAME   = SPRITE_CONFIG.dwarf;
const GOBLIN_FRAME  = SPRITE_CONFIG.goblin;    // editable via T-key tile picker
const CAM_PAN_SPEED  = 200; // world pixels per second for WASD pan

export class WorldScene extends Phaser.Scene {
  private grid: Tile[][] = [];
  private dwarves: Dwarf[] = [];
  private tick = 0;
  private selectedDwarfId: string | null = null;
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

  // One sprite per living dwarf
  private dwarfSprites = new Map<string, Phaser.GameObjects.Sprite>();
  // Persistent grave sprites for dead dwarves (red, flipped upside-down)
  private dwarfGhostSprites = new Map<string, Phaser.GameObjects.Sprite>();
  // Off-screen arrow indicator for selected dwarf
  private offScreenGfx!: Phaser.GameObjects.Graphics;
  // Goblin raid state
  private goblins: Goblin[] = [];
  private goblinSprites = new Map<string, Phaser.GameObjects.Sprite>();

  // Succession state
  private spawnZone!: { x: number; y: number; w: number; h: number };
  private pendingSuccessions: { deadDwarfId: string; spawnAtTick: number }[] = [];

  // Colony goal + food stockpiles + ore stockpiles (expand as each fills up)
  private colonyGoal!: ColonyGoal;
  private goblinKillCount = 0;
  private foodStockpiles:        FoodStockpile[]  = [];
  private oreStockpiles:         OreStockpile[]   = [];
  private foodStockpileGfxList:  Phaser.GameObjects.Graphics[] = [];
  private foodStockpileImgList:  Phaser.GameObjects.Image[]    = [];
  private oreStockpileGfxList:   Phaser.GameObjects.Graphics[] = [];
  private oreStockpileImgList:   Phaser.GameObjects.Image[]    = [];

  // Event log history (persisted to save, restored on load)
  private logHistory: LogEntry[] = [];

  // WASD keys
  private wasd!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super({ key: 'WorldScene' });
  }

  private static makeGoal(type: ColonyGoal['type'], generation: number): ColonyGoal {
    const scale = 1 + generation * 0.5;
    switch (type) {
      case 'stockpile_food':
        return { type, description: `Fill the food stockpile with ${Math.round(30 * scale)} food`, progress: 0, target: Math.round(30 * scale), generation };
      case 'survive_ticks':
        return { type, description: `Survive ${Math.round(500 * scale)} ticks together`, progress: 0, target: Math.round(500 * scale), generation };
      case 'defeat_goblins':
        return { type, description: `Defeat ${Math.round(3 * scale)} goblins`, progress: 0, target: Math.round(3 * scale), generation };
    }
  }

  create() {
    // ── Branch: load saved game or start a new one ──────────────────────
    const mode = (this.game.registry.get('startMode') as string) ?? 'new';
    const save = mode === 'load' ? loadGame() : null;

    if (save) {
      bus.emit('restoreLog', save.logHistory ?? []);
      // Restore all simulation state from the save file
      this.grid               = save.grid;
      this.spawnZone          = save.spawnZone;
      this.dwarves            = save.dwarves;
      this.goblins            = save.goblins;
      this.tick               = save.tick;
      this.colonyGoal         = save.colonyGoal;
      this.foodStockpiles     = save.foodStockpiles;
      this.oreStockpiles      = save.oreStockpiles;
      this.goblinKillCount    = save.goblinKillCount;
      this.pendingSuccessions = save.pendingSuccessions;
      this.commandTile        = save.commandTile;
      this.speedMultiplier    = save.speed;
      this.overlayMode        = save.overlayMode;
      resetGoblins();       // reset raid timer to prevent an immediate raid on resume
      resetWorldEvents(this.tick); // re-anchor event timer so no burst of back-to-back events
    } else {
      bus.emit('clearLog', undefined);
      this.logHistory = [];
      // New game — procedural world + fresh dwarves
      const { grid, spawnZone } = generateWorld();
      this.grid      = grid;
      this.spawnZone = spawnZone;
      this.dwarves   = spawnDwarves(this.grid, spawnZone);
      resetGoblins();
      this.goblins = spawnInitialGoblins(this.grid, 3);

      const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
      const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);
      this.foodStockpiles  = [{ x: depotX,     y: depotY, food: 0, maxFood: 200 }];
      this.oreStockpiles   = [{ x: depotX + 8, y: depotY, ore:  150, maxOre: 200 }];
      this.goblinKillCount = 0;
      this.colonyGoal      = WorldScene.makeGoal('stockpile_food', 0);
      for (const d of this.dwarves) d.homeTile = { x: depotX, y: depotY };
    }

    // ── Reset graphics tracking arrays (always fresh per scene) ─────────
    this.foodStockpileGfxList = [];
    this.foodStockpileImgList = [];
    this.oreStockpileGfxList  = [];
    this.oreStockpileImgList  = [];

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

    // Fixed to screen (scroll factor 0) so coords are in screen-space pixels
    this.offScreenGfx = this.add.graphics().setScrollFactor(0).setDepth(100);

    // Pre-create tombstone sprites for dwarves that were already dead when saved
    if (save) {
      const TOMBSTONE_FRAME = SPRITE_CONFIG.tombstone ?? DWARF_FRAME;
      for (const d of this.dwarves.filter(dw => !dw.alive)) {
        const px = d.x * TILE_SIZE + TILE_SIZE / 2;
        const py = d.y * TILE_SIZE + TILE_SIZE / 2;
        const ghost = this.add.sprite(px, py, 'tiles', TOMBSTONE_FRAME);
        ghost.setTint(0xaaaaaa);
        this.dwarfGhostSprites.set(d.id, ghost);
      }
      this.drawFlag(); // restore yellow flag if one was active
    }

    // ── Camera ──────────────────────────────────────────────────────────
    const worldPx = GRID_SIZE * TILE_SIZE;
    this.cameras.main.setBounds(0, 0, worldPx, worldPx);
    this.cameras.main.setZoom(1.2);
    this.cameras.main.centerOn(
      (this.spawnZone.x + this.spawnZone.w / 2) * TILE_SIZE,
      (this.spawnZone.y + this.spawnZone.h / 2) * TILE_SIZE,
    );

    // ── Keyboard ────────────────────────────────────────────────────────
    this.wasd = {
      W: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    // Suppress browser right-click context menu over the canvas
    this.input.mouse?.disableContextMenu();

    // ── O key: cycle resource overlay ───────────────────────────────────
    this.input.keyboard!
      .addKey(Phaser.Input.Keyboard.KeyCodes.O)
      .on('down', () => {
        const modes: OverlayMode[] = ['off', 'food', 'material'];
        const next = modes[(modes.indexOf(this.overlayMode) + 1) % modes.length];
        this.overlayMode = next;
        this.drawOverlay();
      });

    // ── [ / ] keys: cycle selected dwarf ────────────────────────────────
    const cycleSelected = (direction: 1 | -1) => {
      const alive = this.dwarves.filter(d => d.alive);
      if (alive.length === 0) return;
      const currentIdx = alive.findIndex(d => d.id === this.selectedDwarfId);
      const nextIdx = ((currentIdx + direction) + alive.length) % alive.length;
      this.selectedDwarfId = alive[nextIdx].id;
    };
    this.input.keyboard!
      .addKey(Phaser.Input.Keyboard.KeyCodes.OPEN_BRACKET)
      .on('down', () => cycleSelected(-1));
    this.input.keyboard!
      .addKey(Phaser.Input.Keyboard.KeyCodes.CLOSED_BRACKET)
      .on('down', () => cycleSelected(1));

    // ── SPACE: pause / unpause ───────────────────────────────────────────
    this.input.keyboard!
      .addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
      .on('down', () => this.togglePause());

    // ── Speed keys: = (187) and numpad + (107) for faster; - (189) and numpad - (109) for slower
    // Use raw keycodes — KeyCodes.EQUALS is unreliable across Phaser builds
    for (const code of [187, 107]) {
      this.input.keyboard!.addKey(code).on('down', () => this.adjustSpeed(1));
    }
    for (const code of [189, 109]) {
      this.input.keyboard!.addKey(code).on('down', () => this.adjustSpeed(-1));
    }

    // ── Settings / control bus ───────────────────────────────────────────
    // Store handler refs so they can be removed on scene shutdown (avoids stale
    // listeners firing on a destroyed scene when the player starts a new colony).
    const controlHandler = ({ action }: { action: 'pause' | 'speedUp' | 'speedDown' | 'newColony' }) => {
      if (action === 'pause')     this.togglePause();
      if (action === 'speedUp')   this.adjustSpeed(1);
      if (action === 'speedDown') this.adjustSpeed(-1);
      // 'newColony' is handled by App.tsx; WorldScene has nothing to do
    };
    const settingsHandler = ({ llmEnabled }: { llmEnabled: boolean }) => {
      llmSystem.enabled = llmEnabled;
    };
    const logCaptureHandler = (entry: LogEntry) => {
      this.logHistory.push(entry);
      if (this.logHistory.length > 200) this.logHistory.shift();
    };
    bus.on('controlChange', controlHandler);
    bus.on('settingsChange', settingsHandler);
    bus.on('logEntry', logCaptureHandler);

    // Remove bus listeners when this scene is destroyed (new-colony flow)
    this.events.once('destroy', () => {
      bus.off('controlChange', controlHandler);
      bus.off('settingsChange', settingsHandler);
      bus.off('logEntry', logCaptureHandler);
    });

    this.setupInput();
  }

  /** Serialise the full simulation state into a plain object suitable for JSON. */
  private buildSaveData(): SaveData {
    return {
      version:            1,
      tick:               this.tick,
      grid:               this.grid,
      dwarves:            this.dwarves.map(d => ({ ...d })),
      goblins:            this.goblins.map(g => ({ ...g })),
      colonyGoal:         { ...this.colonyGoal },
      foodStockpiles:     this.foodStockpiles.map(s => ({ ...s })),
      oreStockpiles:      this.oreStockpiles.map(s => ({ ...s })),
      goblinKillCount:    this.goblinKillCount,
      spawnZone:          { ...this.spawnZone },
      pendingSuccessions: this.pendingSuccessions.map(s => ({ ...s })),
      commandTile:        this.commandTile ? { ...this.commandTile } : null,
      speed:              this.speedMultiplier,
      overlayMode:        this.overlayMode,
      logHistory:         [...this.logHistory],
    };
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private setupInput() {
    const cam = this.cameras.main;
    let dragStartX = 0, dragStartY = 0;
    let scrollAtDragX = 0, scrollAtDragY = 0;
    let didDrag = false;

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

      // ── Left-click drag start ────────────────────────────────────────
      dragStartX    = p.x;
      dragStartY    = p.y;
      scrollAtDragX = cam.scrollX;
      scrollAtDragY = cam.scrollY;
      didDrag       = false;
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
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

      if (!p.isDown || p.rightButtonDown()) return;
      const dx = (dragStartX - p.x) / cam.zoom;
      const dy = (dragStartY - p.y) / cam.zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      cam.scrollX = scrollAtDragX + dx;
      cam.scrollY = scrollAtDragY + dy;
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (didDrag || p.rightButtonReleased()) return;
      const tx = Math.floor(p.worldX / TILE_SIZE);
      const ty = Math.floor(p.worldY / TILE_SIZE);

      // Check for stockpile click first (food, then ore)
      const foodIdx = this.foodStockpiles.findIndex(s => s.x === tx && s.y === ty);
      if (foodIdx >= 0) {
        this.selectedDwarfId = null;
        bus.emit('goblinSelect', null);
        bus.emit('stockpileSelect', { kind: 'food', idx: foodIdx });
        return;
      }
      const oreIdx = this.oreStockpiles.findIndex(s => s.x === tx && s.y === ty);
      if (oreIdx >= 0) {
        this.selectedDwarfId = null;
        bus.emit('goblinSelect', null);
        bus.emit('stockpileSelect', { kind: 'ore', idx: oreIdx });
        return;
      }

      // Check for goblin click
      const goblin = this.goblins.find(g => g.x === tx && g.y === ty);
      if (goblin) {
        this.selectedDwarfId = null;
        bus.emit('stockpileSelect', null);
        bus.emit('goblinSelect', goblin);
        return;
      }

      // Left tap: select dwarf at tile — prefer alive, fall back to dead ghost
      const hit = this.dwarves.find(d =>  d.alive && d.x === tx && d.y === ty)
               ?? this.dwarves.find(d => !d.alive && d.x === tx && d.y === ty);
      this.selectedDwarfId = hit?.id ?? null;
      bus.emit('stockpileSelect', null);
      bus.emit('goblinSelect', null);
    });

    this.input.on('wheel',
      (ptr: Phaser.Input.Pointer, _objs: unknown, _dx: number, deltaY: number) => {
        const worldPx  = GRID_SIZE * TILE_SIZE;
        // Minimum zoom: 0.6 = world renders at ~614px, roughly filling the canvas
        // left of the event log without too much dead space around the map edges
        const minZoom  = 0.6;
        const oldZoom  = cam.zoom;
        const newZoom  = Phaser.Math.Clamp(oldZoom * (deltaY > 0 ? 0.9 : 1.1), minZoom, 5);
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

  /** Send commandTarget to selected dwarf (or all if none selected). */
  private applyCommand(tx: number, ty: number) {
    const targets = this.selectedDwarfId
      ? this.dwarves.filter(d => d.alive && d.id === this.selectedDwarfId)
      : this.dwarves.filter(d => d.alive);

    for (const d of targets) {
      d.commandTarget = { x: tx, y: ty };
    }

    const who = this.selectedDwarfId
      ? (this.dwarves.find(d => d.id === this.selectedDwarfId)?.name ?? '?')
      : `${targets.length} dwarves`;

    bus.emit('logEntry', {
      tick:       this.tick,
      dwarfId:    this.selectedDwarfId ?? 'all',
      dwarfName:  who,
      message:    `ordered to (${tx},${ty})`,
      level:      'info',
    });
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

    // PIANO step 6 — check pending outcome verifications, log surprises
    const surprises = llmSystem.checkVerifications(this.dwarves, this.tick);
    for (const msg of surprises) {
      bus.emit('logEntry', {
        tick:      this.tick,
        dwarfId:   'system',
        dwarfName: 'VERIFY',
        message:   msg,
        level:     'warn',
      });
    }

    for (const d of this.dwarves) {
      const wasAlive = d.alive;
      tickAgent(d, this.grid, this.tick, this.dwarves, (message, level) => {
        bus.emit('logEntry', {
          tick:      this.tick,
          dwarfId:   d.id,
          dwarfName: d.name,
          message,
          level,
        });
      }, this.foodStockpiles, this.goblins, this.oreStockpiles, this.colonyGoal ?? undefined);
      if (wasAlive && !d.alive) {
        this.pendingSuccessions.push({ deadDwarfId: d.id, spawnAtTick: this.tick + SUCCESSION_DELAY });
      }

      // Fire async LLM crisis check — never blocks the game loop
      llmSystem.requestDecision(d, this.dwarves, this.grid, this.tick, this.goblins,
        (dwarf, decision, situation) => {
          dwarf.llmReasoning = decision.reasoning;
          dwarf.task         = decision.action;  // show LLM action string as task label

          // Store structured intent with expiry (~7.5 s at 7 ticks/s)
          if (decision.intent && decision.intent !== 'none') {
            dwarf.llmIntent       = decision.intent;
            dwarf.llmIntentExpiry = this.tick + 50;
          }

          // Push to rolling memory (uncapped; last 5 entries used in LLM prompts)
          dwarf.memory.push({ tick: this.tick, crisis: situation.type, action: decision.action, reasoning: decision.reasoning });

          bus.emit('logEntry', {
            tick:      this.tick,
            dwarfId:   dwarf.id,
            dwarfName: dwarf.name,
            message:   `[${situation.type}] ${decision.intent ?? 'none'} — "${decision.reasoning}"`,
            level:     'warn',
          });
        },
        this.colonyGoal,
      );
    }

    growback(this.grid);

    // ── Goblin raids ───────────────────────────────────────────────────────
    const raid = maybeSpawnRaid(this.grid, this.dwarves, this.tick);
    if (raid) {
      this.goblins.push(...raid.goblins);
      bus.emit('logEntry', {
        tick:      this.tick,
        dwarfId:   'goblin',
        dwarfName: 'RAID',
        message:   `⚔ ${raid.count} goblins storm from the ${raid.edge}!`,
        level:     'error',
      });
    }

    if (this.goblins.length > 0) {
      const gr = tickGoblins(this.goblins, this.dwarves, this.grid, this.tick);

      // Apply damage to targeted dwarves
      for (const { dwarfId, damage } of gr.attacks) {
        const d = this.dwarves.find(dw => dw.id === dwarfId);
        if (d && d.alive) {
          d.health = Math.max(0, d.health - damage);
          d.morale = Math.max(0, d.morale - 5);
          if (d.health <= 0) {
            d.alive        = false;
            d.task         = 'dead';
            d.causeOfDeath = 'killed by goblins';
            bus.emit('logEntry', {
              tick:      this.tick,
              dwarfId:   d.id,
              dwarfName: d.name,
              message:   'killed by goblins!',
              level:     'error',
            });
            this.pendingSuccessions.push({ deadDwarfId: d.id, spawnAtTick: this.tick + SUCCESSION_DELAY });
          } else {
            // Survived — log the hit and add a memory so the LLM knows they were in combat
            d.memory.push({ tick: this.tick, crisis: 'combat', action: `hit by goblin, ${d.health.toFixed(0)} hp remaining` });
            bus.emit('logEntry', {
              tick:      this.tick,
              dwarfId:   d.id,
              dwarfName: d.name,
              message:   `⚔ hit by goblin! (${d.health.toFixed(0)} hp)`,
              level:     'warn',
            });
          }
        }
      }

      // Emit goblin action log entries
      for (const { message, level } of gr.logs) {
        bus.emit('logEntry', {
          tick:      this.tick,
          dwarfId:   'goblin',
          dwarfName: 'GOBLIN',
          message,
          level,
        });
      }

      // Remove dead goblins and their sprites
      if (gr.goblinDeaths.length > 0) {
        const deadIds = new Set(gr.goblinDeaths);
        this.goblins  = this.goblins.filter(g => !deadIds.has(g.id));
        this.goblinKillCount += gr.goblinDeaths.length;
        for (const id of gr.goblinDeaths) {
          const spr = this.goblinSprites.get(id);
          if (spr) { spr.destroy(); this.goblinSprites.delete(id); }
        }
        // Add kill memory to the dwarves that scored the kill
        for (const { dwarfId } of gr.kills) {
          const killer = this.dwarves.find(dw => dw.id === dwarfId && dw.alive);
          if (killer) {
            killer.memory.push({ tick: this.tick, crisis: 'combat', action: 'slew a goblin in battle' });
            bus.emit('logEntry', {
              tick:      this.tick,
              dwarfId:   killer.id,
              dwarfName: killer.name,
              message:   '⚔ slew a goblin!',
              level:     'warn',
            });
          }
        }
      }
    }

    // World events — blight / bounty / ore discovery
    const ev = tickWorldEvents(this.grid, this.tick);
    if (ev.fired) {
      bus.emit('logEntry', {
        tick:      this.tick,
        dwarfId:   'world',
        dwarfName: 'WORLD',
        message:   ev.message,
        level:     'warn',
      });
    }

    // ── Succession — spawn queued replacements ──────────────────────────────
    for (let i = this.pendingSuccessions.length - 1; i >= 0; i--) {
      const s = this.pendingSuccessions[i];
      if (this.tick < s.spawnAtTick) continue;
      this.pendingSuccessions.splice(i, 1);

      const dead = this.dwarves.find(d => d.id === s.deadDwarfId);
      if (!dead) continue;

      const successor = spawnSuccessor(dead, this.grid, this.spawnZone, this.dwarves, this.tick);
      successor.homeTile = { x: this.foodStockpiles[0].x, y: this.foodStockpiles[0].y };
      this.dwarves.push(successor);

      bus.emit('logEntry', {
        tick:      this.tick,
        dwarfId:   successor.id,
        dwarfName: successor.name,
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

    // ── Storage expansion — spawn a new unit when the last one fills ────────
    // New units spawn on the nearest open adjacent tile (BFS), so they
    // naturally fill existing room interior before pushing the walls out.
    const lastFoodStockpile = this.foodStockpiles[this.foodStockpiles.length - 1];
    if (lastFoodStockpile.food >= lastFoodStockpile.maxFood) {
      const allOccupied = [...this.foodStockpiles, ...this.oreStockpiles];
      const pos = this.findNearestOpenTile(this.foodStockpiles, allOccupied);
      if (pos) {
        const nd: FoodStockpile = { ...pos, food: 0, maxFood: 200 };
        this.foodStockpiles.push(nd);
        this.addFoodStockpileGraphics(nd);
        bus.emit('logEntry', { tick: this.tick, dwarfId: 'world', dwarfName: 'COLONY',
          message: `New food stockpile established (${this.foodStockpiles.length} total)!`, level: 'info' });
      }
    }
    const lastOreStockpile = this.oreStockpiles[this.oreStockpiles.length - 1];
    if (lastOreStockpile.ore >= lastOreStockpile.maxOre) {
      const allOccupied = [...this.foodStockpiles, ...this.oreStockpiles];
      const pos = this.findNearestOpenTile(this.oreStockpiles, allOccupied);
      if (pos) {
        const ns: OreStockpile = { ...pos, ore: 0, maxOre: 200 };
        this.oreStockpiles.push(ns);
        this.addOreStockpileGraphics(ns);
        bus.emit('logEntry', { tick: this.tick, dwarfId: 'world', dwarfName: 'COLONY',
          message: `New ore stockpile established (${this.oreStockpiles.length} total)!`, level: 'info' });
      }
    }

    this.terrainDirty = true;

    // Clear flag once all commanded dwarves have arrived
    if (this.commandTile) {
      const anyPending = this.dwarves.some(d => d.alive && d.commandTarget !== null);
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
      dwarves: this.dwarves
        .filter(d => d.alive)
        .map(d => ({ x: d.x, y: d.y, hunger: d.hunger })),
      goblins: this.goblins.map(g => ({ x: g.x, y: g.y })),
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
    const alive = this.dwarves.filter(d => d.alive);
    bus.emit('gameState', {
      tick:            this.tick,
      dwarves:         this.dwarves.map(d => ({ ...d })),
      totalFood:       alive.reduce((s, d) => s + d.inventory.food, 0),
      totalMaterials:  alive.reduce((s, d) => s + d.inventory.materials, 0),
      selectedDwarfId: this.selectedDwarfId,
      overlayMode:     this.overlayMode,
      paused:          this.paused,
      speed:           this.speedMultiplier,
      colonyGoal:      { ...this.colonyGoal },
      foodStockpiles:  this.foodStockpiles.map(d => ({ ...d })),
      oreStockpiles:   this.oreStockpiles.map(s => ({ ...s })),
    });
  }

  // ── Colony goal ────────────────────────────────────────────────────────

  private updateGoalProgress() {
    const alive = this.dwarves.filter(d => d.alive);
    switch (this.colonyGoal.type) {
      case 'stockpile_food':
        this.colonyGoal.progress = this.foodStockpiles.reduce((sum, d) => sum + d.food, 0);
        break;
      case 'survive_ticks':
        this.colonyGoal.progress = this.tick;
        break;
      case 'defeat_goblins':
        this.colonyGoal.progress = this.goblinKillCount;
        break;
    }
    if (this.colonyGoal.progress >= this.colonyGoal.target) {
      this.completeGoal(alive);
    }
  }

  private completeGoal(alive: Dwarf[]) {
    const gen = this.colonyGoal.generation + 1;
    for (const d of alive) {
      d.morale = Math.min(100, d.morale + 15);
    }
    bus.emit('logEntry', {
      tick:      this.tick,
      dwarfId:   'world',
      dwarfName: 'COLONY',
      message:   `✓ Goal complete: ${this.colonyGoal.description}! Morale boost for all!`,
      level:     'info',
    });
    const GOAL_TYPES: ColonyGoal['type'][] = ['stockpile_food', 'survive_ticks', 'defeat_goblins'];
    const curr = GOAL_TYPES.indexOf(this.colonyGoal.type);
    const next = GOAL_TYPES[(curr + 1) % GOAL_TYPES.length];
    // Reset relevant counters so the new goal tracks from zero
    // Note: food stockpile and ore stockpile totals are intentionally NOT cleared on goal completion
    if (next === 'defeat_goblins') this.goblinKillCount = 0;
    this.colonyGoal = WorldScene.makeGoal(next, gen);
  }

  /**
   * BFS from all `anchors` to find the nearest walkable tile that isn't in
   * `occupied` or the grid. Traverses through walls and occupied tiles so it
   * can escape a full room, but never crosses water.
   * Direction priority: E → W → N → S, giving a natural left-to-right fill
   * before spilling southward.
   */
  private findNearestOpenTile(
    anchors:  Array<{ x: number; y: number }>,
    occupied: Array<{ x: number; y: number }>,
  ): { x: number; y: number } | null {
    const occupiedSet = new Set(occupied.map(p => `${p.x},${p.y}`));
    const visited     = new Set<string>();
    const queue: Array<{ x: number; y: number }> = [];
    for (const a of anchors) {
      const key = `${a.x},${a.y}`;
      if (!visited.has(key)) { visited.add(key); queue.push(a); }
    }
    const DIRS = [[1,0],[-1,0],[0,-1],[0,1]] as const;   // E W N S
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        const t = this.grid[ny][nx];
        if (t.type === TileType.Water) continue;              // hard impassable
        if (occupiedSet.has(key) || t.type === TileType.Wall) {
          queue.push({ x: nx, y: ny });                       // traverse but don't stop
          continue;
        }
        return { x: nx, y: ny };                              // open tile found
      }
    }
    return null;
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
        } else {
          t.tint = 0xffffff;
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
        } else if (this.overlayMode === 'material' && tile.maxMaterial > 0) {
          alpha = (tile.materialValue / tile.maxMaterial) * 0.65;
          color = 0xff8800; // amber
        }

        if (alpha > 0.02) {
          this.overlayGfx.fillStyle(color, alpha);
          this.overlayGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }
    }
  }

  /** Arrow at viewport edge pointing toward the selected dwarf when off-screen. */
  private drawOffScreenIndicator() {
    this.offScreenGfx.clear();
    if (!this.selectedDwarfId) return;

    const d = this.dwarves.find(dw => dw.id === this.selectedDwarfId && dw.alive);
    if (!d) return;

    const cam  = this.cameras.main;
    const view = cam.worldView;

    // Screen position of dwarf (world → screen)
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

    // Draw filled triangle arrow pointing toward dwarf
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

    // Convert newly-dead dwarves to tombstone sprites and remove their live sprite.
    // Ghost sprites are created once and stay until a new game.
    const TOMBSTONE_FRAME = SPRITE_CONFIG.tombstone ?? DWARF_FRAME;
    for (const [id, spr] of this.dwarfSprites) {
      const d = this.dwarves.find(dw => dw.id === id);
      if (!d || !d.alive) {
        if (!this.dwarfGhostSprites.has(id)) {
          const ghost = this.add.sprite(spr.x, spr.y, 'tiles', TOMBSTONE_FRAME);
          ghost.setTint(0xaaaaaa); // gray tombstone
          this.dwarfGhostSprites.set(id, ghost);
        }
        spr.destroy();
        this.dwarfSprites.delete(id);
      }
    }

    // Red selection ring on ghost sprites of dead dwarves
    for (const [id, spr] of this.dwarfGhostSprites) {
      if (id === this.selectedDwarfId) {
        this.selectionGfx.lineStyle(2, 0xff4444, 0.85);
        this.selectionGfx.strokeCircle(spr.x, spr.y, TILE_SIZE / 2 + 3);
      }
    }

    for (const d of this.dwarves) {
      if (!d.alive) continue;

      const px = d.x * TILE_SIZE + TILE_SIZE / 2;
      const py = d.y * TILE_SIZE + TILE_SIZE / 2;

      // Get or create sprite
      let spr = this.dwarfSprites.get(d.id);
      if (!spr) {
        spr = this.add.sprite(px, py, 'tiles', DWARF_FRAME);
        this.dwarfSprites.set(d.id, spr);
      } else {
        spr.setPosition(px, py);
      }

      // Colour shifts green → red as hunger rises
      const hr = d.hunger / 100;
      const r  = Math.floor(60 + hr * 195);
      const g  = Math.floor(200 - hr * 150);
      spr.setTint((r << 16) | (g << 8) | 60);

      // Yellow selection ring
      if (d.id === this.selectedDwarfId) {
        this.selectionGfx.lineStyle(2, 0xffff00, 1);
        this.selectionGfx.strokeCircle(px, py, TILE_SIZE / 2 + 3);
      }

      // Cyan ring when dwarf has an active command
      if (d.commandTarget) {
        this.selectionGfx.lineStyle(1, 0x00ffff, 0.7);
        this.selectionGfx.strokeCircle(px, py, TILE_SIZE / 2 + 1);
      }
    }

    // ── Goblin sprites ──────────────────────────────────────────────────────
    for (const g of this.goblins) {
      const px = g.x * TILE_SIZE + TILE_SIZE / 2;
      const py = g.y * TILE_SIZE + TILE_SIZE / 2;
      let spr = this.goblinSprites.get(g.id);
      if (!spr) {
        spr = this.add.sprite(px, py, 'tiles', GOBLIN_FRAME);
        spr.setTint(0xff6600); // bright orange — clearly hostile
        this.goblinSprites.set(g.id, spr);
      } else {
        spr.setPosition(px, py);
      }
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────

  update(time: number, delta: number) {
    // WASD camera pan
    const cam   = this.cameras.main;
    const speed = CAM_PAN_SPEED * (delta / 1000) / cam.zoom; // scale with zoom for consistent apparent speed
    if (this.wasd.W.isDown) cam.scrollY -= speed;
    if (this.wasd.S.isDown) cam.scrollY += speed;
    if (this.wasd.A.isDown) cam.scrollX -= speed;
    if (this.wasd.D.isDown) cam.scrollX += speed;

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
    this.drawOffScreenIndicator();
  }
}
