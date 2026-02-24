import * as Phaser from 'phaser';
// Note: import * as Phaser is required — Phaser's dist build has no default export
import { generateWorld, growback, isWalkable } from '../../simulation/world';
import { spawnDwarves, tickAgent } from '../../simulation/agents';
import { bus } from '../../shared/events';
import { GRID_SIZE, TILE_SIZE, TICK_RATE_MS } from '../../shared/constants';
import { TileType, type OverlayMode, type Tile, type Dwarf, type GameState, type TileInfo, type MiniMapData } from '../../shared/types';
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
    const { grid, spawnZone } = generateWorld();
    this.grid    = grid;
    this.dwarves = spawnDwarves(this.grid, spawnZone);

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
    // Fixed to screen (scroll factor 0) so coords are in screen-space pixels
    this.offScreenGfx = this.add.graphics().setScrollFactor(0).setDepth(100);

    // ── Camera ──────────────────────────────────────────────────────────
    const worldPx = GRID_SIZE * TILE_SIZE;
    this.cameras.main.setBounds(0, 0, worldPx, worldPx);
    this.cameras.main.setZoom(1.2);
    // Centre camera on the dynamically-placed spawn zone
    this.cameras.main.centerOn(
      (spawnZone.x + spawnZone.w / 2) * TILE_SIZE,
      (spawnZone.y + spawnZone.h / 2) * TILE_SIZE,
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
    bus.on('controlChange', ({ action }) => {
      if (action === 'pause')     this.togglePause();
      if (action === 'speedUp')   this.adjustSpeed(1);
      if (action === 'speedDown') this.adjustSpeed(-1);
    });
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
      // Left tap: select dwarf at tile
      const tx = Math.floor(p.worldX / TILE_SIZE);
      const ty = Math.floor(p.worldY / TILE_SIZE);
      const hit = this.dwarves.find(d => d.alive && d.x === tx && d.y === ty);
      this.selectedDwarfId = hit?.id ?? null;
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

    if (this.tick % 5 === 0) this.emitMiniMap();
    this.emitGameState();
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
    });
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

    // Convert newly-dead dwarves to ghost sprites (red + upside-down) and
    // remove their live sprite. Ghost sprites are created once and stay.
    for (const [id, spr] of this.dwarfSprites) {
      const d = this.dwarves.find(dw => dw.id === id);
      if (!d || !d.alive) {
        if (!this.dwarfGhostSprites.has(id)) {
          const ghost = this.add.sprite(spr.x, spr.y, 'tiles', DWARF_FRAME);
          ghost.setTint(0xff2222);
          ghost.setFlipY(true);
          this.dwarfGhostSprites.set(id, ghost);
        }
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
    this.drawOffScreenIndicator();
  }
}
