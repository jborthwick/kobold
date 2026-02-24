/**
 * TilePicker — in-game overlay for reassigning sprite frames to tile types.
 *
 * Press T to toggle open/closed.
 * Left panel : list of terrain types and sprite keys with preview thumbnails.
 * Right panel: full 49×22 tileset canvas at 2× zoom, click to assign frames.
 * Save button: POSTs to /api/write-tile-config which rewrites tileConfig.ts.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { TILE_CONFIG, SPRITE_CONFIG } from '../game/tileConfig';
import { TileType } from '../shared/types';

// ── Constants ────────────────────────────────────────────────────────────────

const SHEET_COLS  = 49;
const SHEET_ROWS  = 22;
const TILE_PX     = 16;
const SCALE       = 2;               // display scale for the tileset canvas
const CELL        = TILE_PX * SCALE; // 32px per cell in the canvas

const SHEET_URL   = '/assets/kenney-1-bit/Tilesheet/colored_packed.png';

// Stable palette for type highlighting (cycles if more types than colors)
const HIGHLIGHT_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#e91e63',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function frameToXY(frame: number): { col: number; row: number } {
  return { col: frame % SHEET_COLS, row: Math.floor(frame / SHEET_COLS) };
}

function xyToFrame(col: number, row: number): number {
  return row * SHEET_COLS + col;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Section = 'terrain' | 'sprite';

interface TypeEntry {
  key:     string;
  section: Section;
  frames:  number[];
}

/** Build initial entry list from the imported config. */
function buildEntries(): TypeEntry[] {
  const terrain: TypeEntry[] = Object.values(TileType).map(v => {
    const key = v.charAt(0).toUpperCase() + v.slice(1); // 'dirt' → 'Dirt'
    return {
      key,
      section: 'terrain',
      frames:  TILE_CONFIG[v as TileType] ?? [],
    };
  });
  const sprites: TypeEntry[] = Object.entries(SPRITE_CONFIG).map(([k, f]) => ({
    key:     k,
    section: 'sprite',
    frames:  [f],
  }));
  return [...terrain, ...sprites];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TilePicker() {
  const [open,        setOpen]        = useState(false);
  const [entries,     setEntries]     = useState<TypeEntry[]>(buildEntries);
  const [selected,    setSelected]    = useState<string | null>(null);
  const [hovered,     setHovered]     = useState<number | null>(null);
  const [saveStatus,  setSaveStatus]  = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [newTypeName, setNewTypeName] = useState('');

  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const sheetRef    = useRef<HTMLImageElement | null>(null);
  const newTypeRef  = useRef<HTMLInputElement>(null);

  // ── T key toggle ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey) {
        // Ignore T when focus is in an input so typing still works
        if (document.activeElement?.tagName === 'INPUT') return;
        setOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Load sheet image once ────────────────────────────────────────────────────
  useEffect(() => {
    const img = new Image();
    img.src = SHEET_URL;
    img.onload = () => {
      sheetRef.current = img;
      redrawCanvas();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw tileset canvas ──────────────────────────────────────────────────────
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const sheet  = sheetRef.current;
    if (!canvas || !sheet) return;

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // Full sheet at 2×
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sheet, 0, 0, sheet.width * SCALE, sheet.height * SCALE);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 0.5;
    for (let c = 0; c <= SHEET_COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * CELL, 0);
      ctx.lineTo(c * CELL, SHEET_ROWS * CELL);
      ctx.stroke();
    }
    for (let r = 0; r <= SHEET_ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * CELL);
      ctx.lineTo(SHEET_COLS * CELL, r * CELL);
      ctx.stroke();
    }

    // Highlight assigned frames (one color per entry)
    entries.forEach((entry, i) => {
      const color = HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length];
      const isSelected = entry.key === selected;
      ctx.strokeStyle = color;
      ctx.lineWidth   = isSelected ? 2.5 : 1.5;
      ctx.globalAlpha = isSelected ? 1.0 : 0.55;
      for (const f of entry.frames) {
        const { col, row } = frameToXY(f);
        ctx.strokeRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
        // Fill tint for selected type
        if (isSelected) {
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.2;
          ctx.fillRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
          ctx.globalAlpha = 1.0;
        }
      }
    });
    ctx.globalAlpha = 1.0;

    // Hover outline
    if (hovered !== null) {
      const { col, row } = frameToXY(hovered);
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth   = 2;
      ctx.strokeRect(col * CELL, row * CELL, CELL, CELL);
    }
  }, [entries, selected, hovered]);

  useEffect(() => { redrawCanvas(); }, [redrawCanvas]);

  // ── Canvas interaction ────────────────────────────────────────────────────────
  const getFrameFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const col  = Math.floor((e.clientX - rect.left) / CELL);
    const row  = Math.floor((e.clientY - rect.top)  / CELL);
    if (col < 0 || col >= SHEET_COLS || row < 0 || row >= SHEET_ROWS) return null;
    return xyToFrame(col, row);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selected) return;
    const frame = getFrameFromEvent(e);
    if (frame === null) return;

    setEntries(prev => prev.map(entry => {
      if (entry.key !== selected) return entry;
      const isSprite = entry.section === 'sprite';
      if (isSprite) {
        // Sprites always hold exactly one frame — replace it
        return { ...entry, frames: [frame] };
      }
      // Terrain: toggle frame in the array
      const has = entry.frames.includes(frame);
      const next = has
        ? entry.frames.filter(f => f !== frame)
        : [...entry.frames, frame].sort((a, b) => a - b);
      return { ...entry, frames: next };
    }));
  };

  const handleCanvasMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = getFrameFromEvent(e);
    setHovered(frame);
  };

  // ── Add type ─────────────────────────────────────────────────────────────────
  const addType = () => {
    const name = newTypeName.trim();
    if (!name) return;
    // Capitalise first letter
    const key = name.charAt(0).toUpperCase() + name.slice(1);
    if (entries.some(e => e.key === key)) return; // already exists
    setEntries(prev => [...prev, { key, section: 'terrain', frames: [] }]);
    setSelected(key);
    setNewTypeName('');
  };

  // ── Save ─────────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaveStatus('saving');

    // Split entries back into tileConfig / spriteConfig
    const tileConfig:   Record<string, number[]> = {};
    const spriteConfig: Record<string, number>   = {};
    const existingTypes = new Set(Object.values(TileType).map(v =>
      v.charAt(0).toUpperCase() + v.slice(1)
    ));
    const newTypes: string[] = [];

    for (const entry of entries) {
      if (entry.section === 'terrain') {
        tileConfig[entry.key] = entry.frames;
        if (!existingTypes.has(entry.key)) newTypes.push(entry.key);
      } else {
        spriteConfig[entry.key] = entry.frames[0] ?? 0;
      }
    }

    try {
      const res = await fetch('/api/write-tile-config', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ tileConfig, spriteConfig, newTypes }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (err) {
      console.error('[TilePicker] save failed:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  // ── Thumbnail canvas ──────────────────────────────────────────────────────────
  // Draw a 32×32 preview of the first frame in `frames` onto a <canvas> element.
  const drawThumb = useCallback((canvas: HTMLCanvasElement | null, frames: number[]) => {
    if (!canvas || !sheetRef.current || frames.length === 0) return;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 32, 32);
    const { col, row } = frameToXY(frames[0]);
    ctx.drawImage(
      sheetRef.current,
      col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX,
      0, 0, 32, 32,
    );
  }, []);

  if (!open) return null;

  // ── Render ───────────────────────────────────────────────────────────────────
  const saveLabel = {
    idle:   '💾 Save',
    saving: '⏳ Saving…',
    saved:  '✅ Saved',
    error:  '❌ Error',
  }[saveStatus];

  return (
    <div style={styles.overlay}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>🗂 TILE PICKER</span>
        <span style={styles.hint}>T = close · click type → click tile(s)</span>
        <button
          onClick={save}
          disabled={saveStatus === 'saving'}
          style={{
            ...styles.saveBtn,
            ...(saveStatus === 'saved' ? styles.saveBtnSaved : {}),
            ...(saveStatus === 'error' ? styles.saveBtnError : {}),
          }}
        >
          {saveLabel}
        </button>
      </div>

      <div style={styles.body}>
        {/* ── Left panel: type list ─────────────────────────────────────── */}
        <div style={styles.leftPanel}>

          <div style={styles.sectionLabel}>TERRAIN TYPES</div>
          {entries.filter(e => e.section === 'terrain').map((entry, i) => (
            <EntryRow
              key={entry.key}
              entry={entry}
              color={HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length]}
              isSelected={entry.key === selected}
              onSelect={() => setSelected(entry.key)}
              drawThumb={drawThumb}
              sheetLoaded={!!sheetRef.current}
            />
          ))}

          <div style={{ ...styles.sectionLabel, marginTop: 10 }}>SPRITES</div>
          {entries.filter(e => e.section === 'sprite').map((entry, i) => (
            <EntryRow
              key={entry.key}
              entry={entry}
              color={HIGHLIGHT_COLORS[(entries.filter(e2 => e2.section === 'terrain').length + i) % HIGHLIGHT_COLORS.length]}
              isSelected={entry.key === selected}
              onSelect={() => setSelected(entry.key)}
              drawThumb={drawThumb}
              sheetLoaded={!!sheetRef.current}
            />
          ))}

          {/* Add type */}
          <div style={styles.addRow}>
            <input
              ref={newTypeRef}
              value={newTypeName}
              onChange={e => setNewTypeName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addType(); }}
              placeholder="new type…"
              style={styles.addInput}
            />
            <button onClick={addType} style={styles.addBtn}>+</button>
          </div>
        </div>

        {/* ── Right panel: full tileset ─────────────────────────────────── */}
        <div style={styles.rightPanel}>
          <div style={styles.hoverInfo}>
            {hovered !== null
              ? `frame ${hovered}  (row ${Math.floor(hovered / SHEET_COLS)}, col ${hovered % SHEET_COLS})`
              : selected
                ? `← click a tile to assign to "${selected}"`
                : 'select a type on the left first'}
          </div>
          <div style={styles.canvasScroll}>
            <canvas
              ref={canvasRef}
              width={SHEET_COLS * CELL}
              height={SHEET_ROWS * CELL}
              style={styles.canvas}
              onClick={handleCanvasClick}
              onMouseMove={handleCanvasMove}
              onMouseLeave={() => setHovered(null)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── EntryRow sub-component ────────────────────────────────────────────────────

function EntryRow({
  entry, color, isSelected, onSelect, drawThumb, sheetLoaded,
}: {
  entry:       TypeEntry;
  color:       string;
  isSelected:  boolean;
  onSelect:    () => void;
  drawThumb:   (canvas: HTMLCanvasElement | null, frames: number[]) => void;
  sheetLoaded: boolean;
}) {
  const thumbRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    drawThumb(thumbRef.current, entry.frames);
  }, [drawThumb, entry.frames, sheetLoaded]);

  return (
    <div
      onClick={onSelect}
      style={{
        ...styles.entryRow,
        ...(isSelected ? { background: 'rgba(255,255,255,0.1)', borderLeft: `3px solid ${color}` } : {}),
      }}
    >
      <canvas ref={thumbRef} width={32} height={32} style={styles.thumb} />
      <span style={styles.entryKey}>{entry.key}</span>
      <span style={{ ...styles.entryFrames, color }}>
        {entry.frames.length > 0 ? entry.frames.join(', ') : '—'}
      </span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position:   'fixed',
    inset:      0,
    zIndex:     1000,
    background: 'rgba(10,8,14,0.93)',
    display:    'flex',
    flexDirection: 'column',
    fontFamily: 'monospace',
    color:      '#ccc',
    userSelect: 'none',
  },
  header: {
    display:    'flex',
    alignItems: 'center',
    gap:        16,
    padding:    '8px 16px',
    borderBottom: '1px solid #333',
    flexShrink: 0,
  },
  title: {
    fontSize:   15,
    fontWeight: 'bold',
    color:      '#fff',
  },
  hint: {
    fontSize: 11,
    color:    '#666',
    flex:     1,
  },
  saveBtn: {
    fontFamily:    'monospace',
    fontSize:      12,
    fontWeight:    'bold',
    padding:       '5px 14px',
    borderRadius:  5,
    border:        'none',
    cursor:        'pointer',
    background:    'rgba(0,180,80,0.25)',
    color:         '#4efa8a',
    transition:    'background 0.15s',
  },
  saveBtnSaved: {
    background: 'rgba(0,200,100,0.35)',
    color:      '#7fff9f',
  },
  saveBtnError: {
    background: 'rgba(220,50,50,0.35)',
    color:      '#ff8888',
  },
  body: {
    display:  'flex',
    flex:     1,
    overflow: 'hidden',
  },
  leftPanel: {
    width:       240,
    flexShrink:  0,
    overflowY:   'auto',
    borderRight: '1px solid #333',
    padding:     '8px 0',
  },
  sectionLabel: {
    fontSize:      9,
    letterSpacing: '0.1em',
    color:         '#555',
    padding:       '4px 12px 2px',
  },
  entryRow: {
    display:     'flex',
    alignItems:  'center',
    gap:         8,
    padding:     '4px 12px 4px 9px',
    cursor:      'pointer',
    borderLeft:  '3px solid transparent',
    transition:  'background 0.1s',
  },
  thumb: {
    width:           32,
    height:          32,
    flexShrink:      0,
    imageRendering:  'pixelated',
    background:      '#1a1520',
    borderRadius:    2,
  },
  entryKey: {
    flex:     1,
    fontSize: 12,
    color:    '#ddd',
  },
  entryFrames: {
    fontSize: 10,
    minWidth: 40,
    textAlign: 'right' as const,
  },
  addRow: {
    display:    'flex',
    gap:        6,
    padding:    '8px 12px',
    marginTop:  6,
    borderTop:  '1px solid #2a2a2a',
  },
  addInput: {
    flex:          1,
    fontFamily:    'monospace',
    fontSize:      11,
    background:    '#1c1925',
    border:        '1px solid #444',
    borderRadius:  4,
    color:         '#ccc',
    padding:       '3px 7px',
    outline:       'none',
  },
  addBtn: {
    fontFamily:  'monospace',
    fontSize:    14,
    fontWeight:  'bold',
    background:  'rgba(255,255,255,0.08)',
    border:      'none',
    borderRadius: 4,
    color:       '#aaa',
    cursor:      'pointer',
    width:       28,
  },
  rightPanel: {
    flex:         1,
    display:      'flex',
    flexDirection: 'column',
    overflow:     'hidden',
  },
  hoverInfo: {
    padding:    '5px 12px',
    fontSize:   11,
    color:      '#888',
    borderBottom: '1px solid #222',
    flexShrink: 0,
  },
  canvasScroll: {
    flex:     1,
    overflow: 'auto',
    padding:  8,
  },
  canvas: {
    display:        'block',
    cursor:         'crosshair',
    imageRendering: 'pixelated',
  },
};
