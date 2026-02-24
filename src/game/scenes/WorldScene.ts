import * as Phaser from 'phaser';
// Note: import * as Phaser is required — Phaser's dist build has no default export
import { generateWorld, growback, isWalkable } from '../../simulation/world';
import { spawnDwarves, tickAgent } from '../../simulation/agents';
import { bus } from '../../shared/events';
import { GRID_SIZE, TILE_SIZE, TICK_RATE_MS } from '../../shared/constants';
import { TileType, type OverlayMode, type Tile, type Dwarf, type GameState } from '../../shared/types';
import { llmSystem } from '../../ai/crisis';
import { tickWorldEvents } from '../../simulation/events';
import { TILE_CONFIG, SPRITE_CONFIG } from '../tileConfig';

// Frame assignments live in src/game/tileConfig.ts — edit them there
// or use the in-game tile picker (press T).
const DWARF_FRAME = SPRITE_CONFIG.dwarf;
const CAM_PAN_SPEED  = 200; // world pixels per second for WASD pan

export class WorldScene extends Phaser.Scene {
  private grid: Tile[][] = [];
  private dwarves: Dwarf[] = [];
  private tick = 0;
  private selectedDwarfId: string | null = null;
  private terrainDirty = true;
  private lastTickTime = 0;

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

  create() {
    this.grid    = generateWorld();
    this.dwarves = spawnDwarves(this.grid);

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
    this.overlayGfx   = this.add.graphics();
    this.flagGfx      = this.add.graphics();
    this.selectionGfx = this.add.graphics();

    // ── Camera ──────────────────────────────────────────────────────────
    const worldPx = GRID_SIZE * TILE_SIZE;
    this.cameras.main.setBounds(0, 0, worldPx, worldPx);
    this.cameras.main.setZoom(2);
    this.cameras.main.centerOn(24 * TILE_SIZE, 35 * TILE_SIZE); // spawn zone center

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

    // ── Settings bus ────────────────────────────────────────────────────
    bus.on('settingsChange', ({ llmEnabled }) => {
      llmSystem.enabled = llmEnabled;
    });

    this.setupInput();
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
      if (!p.isDown || p.rightButtonDown()) return;
      const dx = (dragStartX - p.x) / cam.zoom;
      const dy = (dragStartY - p.y) / cam.zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      cam.scrollX = scrollAtDragX + dx;
      cam.scrollY = scrollAtDragY + dy;
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (didDrag || p.rightButtonReleased()) return;
      // Left tap: select dwarf at tile
      const tx = Math.floor(p.worldX / TILE_SIZE);
      const ty = Math.floor(p.worldY / TILE_SIZE);
      const hit = this.dwarves.find(d => d.alive && d.x === tx && d.y === ty);
      this.selectedDwarfId = hit?.id ?? null;
    });

    this.input.on('wheel',
      (ptr: Phaser.Input.Pointer, _objs: unknown, _dx: number, deltaY: number) => {
        const worldPx  = GRID_SIZE * TILE_SIZE;
        // Minimum zoom = whichever axis would show beyond the map edge first
        const minZoom  = Math.max(cam.width, cam.height) / worldPx;
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
      tickAgent(d, this.grid, this.tick, this.dwarves, (message, level) => {
        bus.emit('logEntry', {
          tick:      this.tick,
          dwarfId:   d.id,
          dwarfName: d.name,
          message,
          level,
        });
      });

      // Fire async LLM crisis check — never blocks the game loop
      llmSystem.requestDecision(d, this.dwarves, this.grid, this.tick,
        (dwarf, decision, situation) => {
          dwarf.llmReasoning = decision.reasoning;
          dwarf.task         = decision.action;  // show LLM action string as task label

          // Store structured intent with expiry (~7.5 s at 7 ticks/s)
          if (decision.intent && decision.intent !== 'none') {
            dwarf.llmIntent       = decision.intent;
            dwarf.llmIntentExpiry = this.tick + 50;
          }

          // Push to rolling short-term memory (cap at 5 entries)
          dwarf.memory.push({ tick: this.tick, crisis: situation.type, action: decision.action });
          if (dwarf.memory.length > 5) dwarf.memory.shift();

          bus.emit('logEntry', {
            tick:      this.tick,
            dwarfId:   dwarf.id,
            dwarfName: dwarf.name,
            message:   `[${situation.type}] ${decision.intent ?? 'none'} — "${decision.reasoning}"`,
            level:     'warn',
          });
        },
      );
    }

    growback(this.grid);

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

    this.terrainDirty = true;

    // Clear flag once all commanded dwarves have arrived
    if (this.commandTile) {
      const anyPending = this.dwarves.some(d => d.alive && d.commandTarget !== null);
      if (!anyPending) {
        this.commandTile = null;
        this.flagGfx.clear();
      }
    }

    const alive = this.dwarves.filter(d => d.alive);
    const state: GameState = {
      tick:            this.tick,
      dwarves:         this.dwarves.map(d => ({ ...d })),
      totalFood:       alive.reduce((s, d) => s + d.inventory.food, 0),
      totalMaterials:  alive.reduce((s, d) => s + d.inventory.materials, 0),
      selectedDwarfId: this.selectedDwarfId,
      overlayMode:     this.overlayMode,
    };
    bus.emit('gameState', state);
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

        // Dim food tiles as they deplete (multiplicative brightness mask).
        // No per-type hue needed — correct frame colors handle visual identity.
        if (tile.maxFood > 0) {
          const ratio      = tile.foodValue / tile.maxFood;
          const brightness = Math.floor((0.5 + ratio * 0.5) * 255);
          t.tint = (brightness << 16) | (brightness << 8) | brightness;
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

  private drawAgents() {
    this.selectionGfx.clear();

    // Remove sprites for dwarves that have died
    for (const [id, spr] of this.dwarfSprites) {
      const d = this.dwarves.find(dw => dw.id === id);
      if (!d || !d.alive) {
        spr.destroy();
        this.dwarfSprites.delete(id);
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

    // Simulation tick
    if (time - this.lastTickTime >= TICK_RATE_MS) {
      this.lastTickTime = time;
      this.gameTick();
    }

    if (this.terrainDirty) {
      this.drawTerrain();
      this.drawOverlay(); // refresh density whenever food values change
    }
    this.drawAgents();
  }
}
