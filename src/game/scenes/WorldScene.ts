import Phaser from 'phaser';
import { generateWorld, growback, darkenColor } from '../../simulation/world';
import { spawnDwarves, tickAgent } from '../../simulation/agents';
import { bus } from '../../shared/events';
import { GRID_SIZE, TILE_SIZE, TICK_RATE_MS } from '../../shared/constants';
import { TileType, type Tile, type Dwarf, type GameState } from '../../shared/types';

const TILE_COLORS: Record<TileType, number> = {
  [TileType.Grass]:    0x5a8a3a,
  [TileType.Stone]:    0x888888,
  [TileType.Water]:    0x2255bb,
  [TileType.Forest]:   0x2d6a2d,
  [TileType.Farmland]: 0xc8a832,
  [TileType.Ore]:      0x7733aa,
};

export class WorldScene extends Phaser.Scene {
  private grid: Tile[][] = [];
  private dwarves: Dwarf[] = [];
  private tick = 0;
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private agentGfx!: Phaser.GameObjects.Graphics;
  private selectedDwarfId: string | null = null;
  private terrainDirty = true;

  constructor() {
    super({ key: 'WorldScene' });
  }

  create() {
    this.grid   = generateWorld();
    this.dwarves = spawnDwarves(this.grid);

    this.terrainGfx = this.add.graphics();
    this.agentGfx   = this.add.graphics();

    const worldPx = GRID_SIZE * TILE_SIZE;
    this.cameras.main.setBounds(0, 0, worldPx, worldPx);
    this.cameras.main.centerOn(worldPx / 2, worldPx / 2);
    this.cameras.main.setZoom(2); // start zoomed in a bit

    this.setupInput();

    this.time.addEvent({
      delay: TICK_RATE_MS,
      callback: this.gameTick,
      callbackScope: this,
      loop: true,
    });
  }

  private setupInput() {
    const cam = this.cameras.main;
    let dragStartX = 0, dragStartY = 0;
    let scrollAtDragX = 0, scrollAtDragY = 0;
    let didDrag = false;

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      dragStartX    = p.x;
      dragStartY    = p.y;
      scrollAtDragX = cam.scrollX;
      scrollAtDragY = cam.scrollY;
      didDrag       = false;
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      const dx = (dragStartX - p.x) / cam.zoom;
      const dy = (dragStartY - p.y) / cam.zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      cam.scrollX = scrollAtDragX + dx;
      cam.scrollY = scrollAtDragY + dy;
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (didDrag) return;
      // Treat as a tap/click — check for dwarf at tile
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

  private gameTick() {
    this.tick++;
    for (const d of this.dwarves) tickAgent(d, this.grid);
    growback(this.grid);
    this.terrainDirty = true;

    const alive = this.dwarves.filter(d => d.alive);
    const state: GameState = {
      tick:             this.tick,
      dwarves:          this.dwarves.map(d => ({ ...d })),
      totalFood:        alive.reduce((s, d) => s + d.inventory.food, 0),
      totalMaterials:   alive.reduce((s, d) => s + d.inventory.materials, 0),
      selectedDwarfId:  this.selectedDwarfId,
    };
    bus.emit('gameState', state);
  }

  private drawTerrain() {
    this.terrainGfx.clear();
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const tile  = this.grid[y][x];
        let   color = TILE_COLORS[tile.type];

        // Dim food tiles as they're depleted
        if (tile.maxFood > 0) {
          const ratio = tile.foodValue / tile.maxFood;
          color = darkenColor(color, (1 - ratio) * 0.5);
        }

        this.terrainGfx.fillStyle(color);
        this.terrainGfx.fillRect(
          x * TILE_SIZE, y * TILE_SIZE,
          TILE_SIZE - 1, TILE_SIZE - 1,
        );
      }
    }
    this.terrainDirty = false;
  }

  private drawAgents() {
    this.agentGfx.clear();
    for (const d of this.dwarves) {
      if (!d.alive) continue;

      const px = d.x * TILE_SIZE + TILE_SIZE / 2;
      const py = d.y * TILE_SIZE + TILE_SIZE / 2;
      const r  = TILE_SIZE / 2 - 1;

      if (d.id === this.selectedDwarfId) {
        this.agentGfx.lineStyle(2, 0xffff00, 1);
        this.agentGfx.strokeCircle(px, py, r + 3);
      }

      // Colour shifts from green → red as hunger rises
      const hr  = d.hunger / 100;
      const col = (Math.floor(60 + hr * 195) << 16)
                | (Math.floor(200 - hr * 150) << 8)
                | 60;
      this.agentGfx.fillStyle(col);
      this.agentGfx.fillCircle(px, py, r);
    }
  }

  update() {
    if (this.terrainDirty) this.drawTerrain();
    this.drawAgents();
  }
}
