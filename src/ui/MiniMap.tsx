import { useEffect, useRef, useState } from 'react';
import { bus } from '../shared/events';
import { TileType, type MiniMapData } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

// 2 px per tile → 128×128 canvas
const SCALE = 2;
const SIZE  = GRID_SIZE * SCALE; // 128

// Base colors per tile type [r, g, b]
const TILE_RGB: Record<TileType, [number, number, number]> = {
  [TileType.Dirt]:     [ 42,  28,  22],
  [TileType.Grass]:    [ 50,  90,  35],
  [TileType.Forest]:   [ 20,  60,  20],
  [TileType.Water]:    [ 20,  60, 110],
  [TileType.Stone]:    [ 85,  85,  85],
  [TileType.Farmland]: [100,  80,  40],
  [TileType.Ore]:      [ 90,  75,  20],
  [TileType.Mushroom]: [ 70,  40,  80],
};

export function MiniMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<MiniMapData | null>(null);

  useEffect(() => {
    bus.on('miniMapUpdate', setData);
    return () => bus.off('miniMapUpdate', setData);
  }, []);

  // Redraw whenever data changes
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // ── Terrain ──────────────────────────────────────────────────────────
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const cell = data.tiles[y][x];
        const [r, g, b] = TILE_RGB[cell.type] ?? [40, 40, 40];
        // Brighten tiles that have food/material based on fill ratio
        const boost = cell.foodRatio > 0
          ? 0.6 + cell.foodRatio * 0.4
          : cell.matRatio > 0
            ? 0.6 + cell.matRatio * 0.4
            : 1.0;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const i = ((y * SCALE + dy) * SIZE + (x * SCALE + dx)) * 4;
            img.data[i]     = Math.min(255, Math.round(r * boost));
            img.data[i + 1] = Math.min(255, Math.round(g * boost));
            img.data[i + 2] = Math.min(255, Math.round(b * boost));
            img.data[i + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    // ── Camera viewport ──────────────────────────────────────────────────
    const vp = data.viewport;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(
      vp.x * SCALE,
      vp.y * SCALE,
      vp.w * SCALE,
      vp.h * SCALE,
    );

    // ── Dwarf dots ───────────────────────────────────────────────────────
    for (const d of data.dwarves) {
      const hr = d.hunger / 100;
      const dr = Math.floor(60  + hr * 195);
      const dg = Math.floor(200 - hr * 150);
      ctx.fillStyle = `rgb(${dr},${dg},60)`;
      ctx.fillRect(d.x * SCALE, d.y * SCALE, SCALE + 1, SCALE + 1);
    }
  }, [data]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>MAP</div>
      <canvas ref={canvasRef} width={SIZE} height={SIZE} style={styles.canvas} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position:      'absolute',
    bottom:        16,
    left:          12,
    background:    'rgba(0,0,0,0.75)',
    borderRadius:  6,
    padding:       '4px 6px 6px',
    userSelect:    'none',
    pointerEvents: 'none',
  },
  header: {
    fontFamily:    'monospace',
    fontSize:      8,
    color:         '#555',
    letterSpacing: '0.1em',
    marginBottom:  3,
  },
  canvas: {
    display:     'block',
    imageRendering: 'pixelated',
    border:      '1px solid #333',
  },
};
