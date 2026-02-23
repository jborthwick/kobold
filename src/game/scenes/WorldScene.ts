import * as Phaser from 'phaser';
// Note: import * as Phaser is required — Phaser's dist build has no default export
import { generateWorld, growback, isWalkable } from '../../simulation/world';
import { spawnDwarves, tickAgent } from '../../simulation/agents';
import { bus } from '../../shared/events';
import { GRID_SIZE, TILE_SIZE, TICK_RATE_MS } from '../../shared/constants';
import { TileType, type Tile, type Dwarf, type GameState } from '../../shared/types';

// colored_packed.png: 49 columns × 22 rows, 16×16, no spacing.
// Frame index = row * 49 + col  (0-based)
const TILE_FRAMES: Record<TileType, number> = {
  [TileType.Forest]:   0,    // row 0, col 0  – green tree ✓
  [TileType.Grass]:    9,    // row 0, col 9  – subtle ground dot
  [TileType.Water]:    204,  // row 4, col 8  – blue water ✓
  [TileType.Stone]:    98,   // row 2, col 0  – dark stone
  [TileType.Farmland]: 147,  // row 3, col 2  – grid/soil pattern
  [TileType.Ore]:      16,   // row 0, col 16 – mineral icon
};

// Armored humanoid character sprite (row 0, cols 26-43 are character sprites)
const DWARF_FRAME    = 26;
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
    this.flagGfx      = this.add.graphics();
    this.selectionGfx = this.add.graphics();

    // ── Camera ──────────────────────────────────────────────────────────
    const worldPx = GRID_SIZE * TILE_SIZE;
    this.cameras.main.setBounds(0, 0, worldPx, worldPx);
    this.cameras.main.setZoom(2);
    this.cameras.main.centerOn(200, 200); // NW food zone where dwarves start

    // ── Keyboard ────────────────────────────────────────────────────────
    this.wasd = {
      W: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    // Suppress browser right-click context menu over the canvas
    this.input.mouse?.disableContextMenu();

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
        const wx = cam.scrollX + p.x / cam.zoom;
        const wy = cam.scrollY + p.y / cam.zoom;
        const tx = Phaser.Math.Clamp(Math.floor(wx / TILE_SIZE), 0, GRID_SIZE - 1);
        const ty = Phaser.Math.Clamp(Math.floor(wy / TILE_SIZE), 0, GRID_SIZE - 1);

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
      const wx = cam.scrollX + p.x / cam.zoom;
      const wy = cam.scrollY + p.y / cam.zoom;
      const tx = Math.floor(wx / TILE_SIZE);
      const ty = Math.floor(wy / TILE_SIZE);
      const hit = this.dwarves.find(d => d.alive && d.x === tx && d.y === ty);
      this.selectedDwarfId = hit?.id ?? null;
    });

    this.input.on('wheel',
      (_ptr: unknown, _objs: unknown, _dx: number, deltaY: number) => {
        const z = cam.zoom * (deltaY > 0 ? 0.9 : 1.1);
        cam.zoom = Phaser.Math.Clamp(z, 0.4, 6);
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

    for (const d of this.dwarves) {
      tickAgent(d, this.grid, (message, level) => {
        bus.emit('logEntry', {
          tick:      this.tick,
          dwarfId:   d.id,
          dwarfName: d.name,
          message,
          level,
        });
      });
    }

    growback(this.grid);
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
    };
    bus.emit('gameState', state);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private drawTerrain() {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const tile  = this.grid[y][x];
        const frame = TILE_FRAMES[tile.type];
        const t     = this.terrainLayer.putTileAt(frame, x, y)!;

        // Dim food tiles as they deplete (tint is a multiplicative RGB mask)
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
    const speed = CAM_PAN_SPEED * (delta / 1000);
    if (this.wasd.W.isDown) cam.scrollY -= speed;
    if (this.wasd.S.isDown) cam.scrollY += speed;
    if (this.wasd.A.isDown) cam.scrollX -= speed;
    if (this.wasd.D.isDown) cam.scrollX += speed;

    // Simulation tick
    if (time - this.lastTickTime >= TICK_RATE_MS) {
      this.lastTickTime = time;
      this.gameTick();
    }

    if (this.terrainDirty) this.drawTerrain();
    this.drawAgents();
  }
}
