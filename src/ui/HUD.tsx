import { useEffect, useState } from 'react';
import { bus } from '../shared/events';
import type { GameState, Dwarf, OverlayMode } from '../shared/types';

export function HUD() {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  if (!state) return null;

  const alive    = state.dwarves.filter(d => d.alive);
  const selected = state.selectedDwarfId
    ? state.dwarves.find(d => d.id === state.selectedDwarfId)
    : null;

  return (
    <>
      <div style={styles.topBar}>
        <Stat label="dwarves" value={`${alive.length}/${state.dwarves.length}`} />
        <Stat label="food"    value={state.totalFood.toFixed(1)} />
        <Stat label="stone"   value={state.totalMaterials.toFixed(1)} />
        <Stat label="tick"    value={String(state.tick)} />
        <OverlayIndicator mode={state.overlayMode} />
      </div>

      {selected && <DwarfPanel dwarf={selected} />}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </div>
  );
}

const OVERLAY_LABEL: Record<OverlayMode, string> = {
  off:      '[O] overlay',
  food:     '[O] food ▓',
  material: '[O] stone ▓',
};
const OVERLAY_COLOR: Record<OverlayMode, string> = {
  off:      '#555',
  food:     '#00dd44',
  material: '#ff8800',
};

function OverlayIndicator({ mode }: { mode: OverlayMode }) {
  return (
    <div style={{ ...styles.stat, justifyContent: 'center' }}>
      <span style={{ ...styles.statLabel, color: OVERLAY_COLOR[mode], fontSize: 10 }}>
        {OVERLAY_LABEL[mode]}
      </span>
    </div>
  );
}

function DwarfPanel({ dwarf }: { dwarf: Dwarf }) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelName}>{dwarf.name}</div>
      <Bar label="health" value={dwarf.health}  max={dwarf.maxHealth} color="#e74c3c" />
      <Bar label="hunger" value={dwarf.hunger}  max={100}             color="#e67e22" />
      <Bar label="morale" value={dwarf.morale}  max={100}             color="#3498db" />
      <div style={styles.panelRow}>food: {dwarf.inventory.food.toFixed(1)}</div>
      <div style={styles.panelRow}>vision: {dwarf.vision}</div>
      <div style={styles.panelRow}>metabolism: {dwarf.metabolism}/tick</div>
      <div style={styles.task}>{dwarf.task}</div>
      {dwarf.llmReasoning && (
        <div style={styles.llmReasoning}>💭 "{dwarf.llmReasoning}"</div>
      )}
    </div>
  );
}

function Bar({
  label, value, max, color,
}: { label: string; value: number; max: number; color: string }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={styles.barLabel}>{label}</div>
      <div style={styles.barTrack}>
        <div style={{ ...styles.barFill, width: `${(value / max) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    position:   'absolute',
    top:        12,
    left:       12,
    display:    'flex',
    gap:        16,
    background: 'rgba(0,0,0,0.65)',
    padding:    '6px 14px',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize:   13,
    color:      '#fff',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  stat: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           2,
  },
  statLabel: {
    fontSize: 9,
    color:    '#aaa',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  statValue: {
    fontSize:   14,
    fontWeight: 'bold',
  },
  panel: {
    position:   'absolute',
    bottom:     16,
    left:       12,
    background: 'rgba(0,0,0,0.75)',
    padding:    '10px 14px',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize:   12,
    color:      '#ccc',
    minWidth:   170,
    userSelect: 'none',
    pointerEvents: 'none',
  },
  panelName: {
    fontSize:   15,
    fontWeight: 'bold',
    color:      '#f0c040',
    marginBottom: 8,
  },
  panelRow: {
    marginTop: 4,
  },
  task: {
    marginTop:  8,
    color:      '#7ec8e3',
    fontStyle:  'italic',
    fontSize:   11,
  },
  barLabel: {
    fontSize: 10,
    color:    '#999',
    marginBottom: 2,
  },
  barTrack: {
    background:   '#333',
    height:       7,
    borderRadius: 4,
    overflow:     'hidden',
  },
  barFill: {
    height:       '100%',
    borderRadius: 4,
    transition:   'width 0.15s ease',
  },
  llmReasoning: {
    marginTop:  8,
    padding:    '5px 7px',
    background: 'rgba(255,200,0,0.08)',
    borderLeft: '2px solid #f0c040',
    color:      '#f0c040',
    fontStyle:  'italic',
    fontSize:   10,
    lineHeight: 1.4,
  },
};
