import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import { HEARTH_FUEL_MAX } from '../../shared/constants';
import type { GameState } from '../../shared/types';

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: 'rgba(0,0,0,0.75)',
    padding:    '10px 14px',
    fontFamily: 'monospace',
    fontSize:   12,
    color:      '#ccc',
    overflowY:  'auto',
    scrollbarWidth: 'thin',
    scrollbarColor: '#444 transparent',
    userSelect: 'none',
    pointerEvents: 'auto',
    flexShrink: 0,
    maxHeight:  '50vh',
  } as React.CSSProperties,
  panelName: {
    fontSize:   15,
    fontWeight: 'bold',
    color:      '#ff8844',
    marginBottom: 8,
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
};

export function HearthPanel() {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  const tile = state?.selectedHearthTile;
  if (!tile || !state) return null;

  const fuel = tile.hearthFuel;
  const max = HEARTH_FUEL_MAX;
  const pct = max > 0 ? Math.min(1, fuel / max) : 0;
  const isLit = fuel > 0;

  return (
    <div style={{ ...styles.panel, borderLeft: '2px solid #ff8844' }}>
      <div style={styles.panelName}>🔥 Hearth</div>
      <div style={{ fontSize: 9, color: '#888', marginBottom: 6 }}>({tile.x}, {tile.y})</div>
      <div style={{ marginBottom: 6 }}>
        <div style={styles.barLabel}>fuel</div>
        <div style={styles.barTrack}>
          <div style={{ ...styles.barFill, width: `${pct * 100}%`, background: isLit ? '#ff8844' : '#555' }} />
        </div>
        <div style={{ fontSize: 9, color: '#999', marginTop: 2 }}>{fuel.toFixed(0)} / {max}</div>
      </div>
      <div style={{ fontSize: 9, color: '#888' }}>
        {isLit ? 'Lit — provides warmth' : 'Unlit — add wood to refuel'}
      </div>
    </div>
  );
}
