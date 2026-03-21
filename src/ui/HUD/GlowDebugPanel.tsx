import { useCallback, useRef, useState } from 'react';
import { bus } from '../../shared/events';
import {
  ambientGlowDebug,
  resetAmbientGlowDebug,
  type DebugGfxBlendMode,
} from '../../debug/ambientGlowDebug';

const PANEL_MIN_W = 200;

const panelBase: React.CSSProperties = {
  position: 'absolute',
  background: 'rgba(0,0,0,0.78)',
  borderRadius: 6,
  padding: '8px 10px',
  fontFamily: 'monospace',
  fontSize: 10,
  color: '#bbb',
  userSelect: 'none',
  pointerEvents: 'auto' as const,
  minWidth: PANEL_MIN_W,
  maxWidth: 300,
  zIndex: 50,
};

const headerBase: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 9,
  color: '#666',
  letterSpacing: '0.06em',
  marginBottom: 6,
  marginLeft: -2,
  marginRight: -2,
  marginTop: -2,
  padding: '4px 6px',
  borderRadius: 4,
  cursor: 'grab',
  touchAction: 'none',
};

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 5,
};

const label: React.CSSProperties = {
  flex: '0 0 100px',
  color: '#777',
  fontSize: 9,
};

const subSection: React.CSSProperties = {
  fontSize: 8,
  color: '#555',
  letterSpacing: '0.12em',
  marginTop: 8,
  marginBottom: 4,
  borderTop: '1px solid #333',
  paddingTop: 6,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 8,
  color: '#555',
  letterSpacing: '0.12em',
  marginBottom: 5,
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 10,
  background: '#222',
  color: '#ccc',
  border: '1px solid #444',
};

const BLEND_OPTIONS: { value: DebugGfxBlendMode; label: string; title?: string }[] = [
  { value: 'normal', label: 'normal' },
  { value: 'add', label: 'add' },
  { value: 'screen', label: 'screen' },
  { value: 'multiply', label: 'multiply' },
  {
    value: 'overlay',
    label: 'overlay',
    title: 'Phaser: documented as canvas-oriented; may look wrong in WebGL',
  },
];

const slider: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

function emitGlowChanged() {
  bus.emit('ambientGlowDebugChanged', undefined);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function GlowDebugPanel() {
  const [, tick] = useState(0);
  const rerender = useCallback(() => tick((n) => n + 1), []);
  const [pos, setPos] = useState({ top: 44, left: 8 });
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
  } | null>(null);

  const clampPos = useCallback((left: number, top: number) => {
    const el = panelRef.current;
    const w = el?.offsetWidth ?? PANEL_MIN_W;
    const h = el?.offsetHeight ?? 320;
    const maxL = Math.max(0, window.innerWidth - Math.min(w, window.innerWidth));
    const maxT = Math.max(0, window.innerHeight - Math.min(h, window.innerHeight));
    return {
      left: clamp(left, 0, maxL),
      top: clamp(top, 0, maxT),
    };
  }, []);

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: pos.left,
      origTop: pos.top,
    };
    (e.currentTarget as HTMLElement).style.cursor = 'grabbing';
  };

  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setPos(clampPos(d.origLeft + dx, d.origTop + dy));
  };

  const onHeaderPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    (e.currentTarget as HTMLElement).style.cursor = 'grab';
  };

  const g = ambientGlowDebug;

  return (
    <div
      ref={panelRef}
      style={{ ...panelBase, top: pos.top, left: pos.left }}
    >
      <div
        style={headerBase}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span>GLOW DEBUG</span>
        <button
          type="button"
          onClick={() => {
            resetAmbientGlowDebug();
            emitGlowChanged();
            rerender();
          }}
          style={{
            background: '#333',
            border: 'none',
            borderRadius: 4,
            color: '#999',
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: 9,
            padding: '2px 6px',
          }}
        >
          reset
        </button>
      </div>

      <div style={sectionTitle}>LAYER BLENDS</div>
      <BlendSelectRow
        leftLabel="warmth"
        value={g.blendMode}
        onChange={(v) => {
          g.blendMode = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <BlendSelectRow
        leftLabel="wx tint"
        title="Day/night + weather color (full-screen)"
        value={g.weatherTintBlendMode}
        onChange={(v) => {
          g.weatherTintBlendMode = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <BlendSelectRow
        leftLabel="wx parts"
        title="Rain / snow / dust layer"
        value={g.weatherParticlesBlendMode}
        onChange={(v) => {
          g.weatherParticlesBlendMode = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <BlendSelectRow
        leftLabel="tactical"
        title="Food / material / wood overlay mode"
        value={g.overlayTacticalBlendMode}
        onChange={(v) => {
          g.overlayTacticalBlendMode = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="wx tint α"
        title="Whole weather+tint graphics alpha (dims night wash without retuning fills)"
        min={0.2}
        max={1}
        step={0.05}
        value={g.weatherTintLayerAlpha}
        onChange={(v) => {
          g.weatherTintLayerAlpha = v;
          emitGlowChanged();
          rerender();
        }}
      />

      <div style={subSection}>WARMTH SHAPE</div>
      <SliderRow
        label="warmth pow"
        min={1}
        max={3}
        step={0.05}
        value={g.warmthPow}
        onChange={(v) => {
          g.warmthPow = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="warmth ×"
        min={0}
        max={0.8}
        step={0.02}
        value={g.warmthMult}
        onChange={(v) => {
          g.warmthMult = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="danger pow"
        min={1}
        max={3}
        step={0.05}
        value={g.dangerPow}
        onChange={(v) => {
          g.dangerPow = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="danger ×"
        min={0}
        max={0.8}
        step={0.02}
        value={g.dangerMult}
        onChange={(v) => {
          g.dangerMult = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="night pow"
        min={1}
        max={2.5}
        step={0.05}
        value={g.nightBoostPow}
        onChange={(v) => {
          g.nightBoostPow = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="night base"
        min={0}
        max={0.5}
        step={0.01}
        value={g.nightBoostBase}
        onChange={(v) => {
          g.nightBoostBase = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="night scale"
        min={0}
        max={0.8}
        step={0.02}
        value={g.nightBoostScale}
        onChange={(v) => {
          g.nightBoostScale = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="night min"
        min={0}
        max={1}
        step={0.05}
        value={g.nightMinStrength}
        onChange={(v) => {
          g.nightMinStrength = v;
          emitGlowChanged();
          rerender();
        }}
      />

      <div style={subSection}>HEARTH / FIRE TILE</div>
      <SliderRow
        label="src warmth ×"
        title="Orange ADD on the hearth/fire cell only — neighbors keep full halo"
        min={0}
        max={1}
        step={0.02}
        value={g.sourceWarmthTileMult}
        onChange={(v) => {
          g.sourceWarmthTileMult = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="src night ×"
        title="Yellow night boost on hearth/fire only — lower preserves pixel art"
        min={0}
        max={1}
        step={0.02}
        value={g.sourceNightBoostTileMult}
        onChange={(v) => {
          g.sourceNightBoostTileMult = v;
          emitGlowChanged();
          rerender();
        }}
      />

      <div style={subSection}>NIGHT WASH → GLOW COMP</div>
      <SliderRow
        label="ovly night α"
        title="Modeled peak α of night blue full-screen layer (match WeatherFX unless experimenting)"
        min={0}
        max={0.7}
        step={0.01}
        value={g.overlayCompNightPeak}
        onChange={(v) => {
          g.overlayCompNightPeak = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="ovly dusk α"
        title="Modeled peak α of dusk purple layer"
        min={0}
        max={0.35}
        step={0.01}
        value={g.overlayCompDuskPeak}
        onChange={(v) => {
          g.overlayCompDuskPeak = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="dusk mix"
        title="How much dusk α adds to estimated wash before 1/(1−t)"
        min={0}
        max={1}
        step={0.05}
        value={g.overlayCompDuskMix}
        onChange={(v) => {
          g.overlayCompDuskMix = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="wash cap"
        title="Clamp estimated wash t before invert (lower = safer, less boost)"
        min={0.25}
        max={0.9}
        step={0.02}
        value={g.overlayCompMaxWash}
        onChange={(v) => {
          g.overlayCompMaxWash = v;
          emitGlowChanged();
          rerender();
        }}
      />
      <SliderRow
        label="glow × max"
        title="Hard cap on multiplier applied to warmth/danger/night-boost alphas"
        min={1}
        max={4}
        step={0.05}
        value={g.overlayCompMaxScale}
        onChange={(v) => {
          g.overlayCompMaxScale = v;
          emitGlowChanged();
          rerender();
        }}
      />
    </div>
  );
}

function BlendSelectRow(props: {
  leftLabel: string;
  title?: string;
  value: DebugGfxBlendMode;
  onChange: (v: DebugGfxBlendMode) => void;
}) {
  const { leftLabel, title, value, onChange } = props;
  return (
    <div style={row}>
      <span style={label} title={title}>{leftLabel}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DebugGfxBlendMode)}
        style={selectStyle}
      >
        {BLEND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SliderRow(props: {
  label: string;
  title?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  const { label: lab, title, min, max, step, value, onChange } = props;
  return (
    <div style={row}>
      <span style={label} title={title}>{lab}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={slider}
      />
      <span style={{ width: 36, textAlign: 'right', fontSize: 9, color: '#888' }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}
