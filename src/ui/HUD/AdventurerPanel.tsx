import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { Adventurer } from '../../shared/types';

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
    color:      '#f0c040',
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

export function AdventurerPanel() {
  const [adventurer, setAdventurer] = useState<Adventurer | null>(null);

  useEffect(() => {
    bus.on('adventurerSelect', setAdventurer);
    return () => bus.off('adventurerSelect', setAdventurer);
  }, []);

  if (!adventurer) return null;

  const hpPct = adventurer.maxHealth > 0 ? Math.min(1, adventurer.health / adventurer.maxHealth) : 0;
  return (
    <div style={{ ...styles.panel, borderLeft: '2px solid #e74c3c' }}>
      <div style={{ ...styles.panelName, color: '#e74c3c' }}>⚔ Adventurer</div>
      <div style={{ fontSize: 9, color: '#888', marginBottom: 6 }}>
        pos ({adventurer.x}, {adventurer.y}){adventurer.targetId ? ' · pursuing' : ' · wandering'}
      </div>
      <Bar label="health" value={adventurer.health} max={adventurer.maxHealth} color="#e74c3c" />
      <div style={{ fontSize: 9, color: '#999', marginTop: 3 }}>
        {adventurer.health.toFixed(0)} / {adventurer.maxHealth} hp
        {hpPct < 0.5 && <span style={{ color: '#e67e22', marginLeft: 6 }}>⚠ wounded</span>}
      </div>
      <div style={{ fontSize: 9, color: '#666', marginTop: 4, fontStyle: 'italic' }}>
        snapshot at time of click
      </div>
    </div>
  );
}
