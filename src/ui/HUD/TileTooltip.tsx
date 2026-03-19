import { useEffect, useState, type CSSProperties } from 'react';
import { bus } from '../../shared/events';
import type { TileInfo } from '../../shared/types';

const styles: Record<string, CSSProperties> = {
  tileTooltip: {
    position:   'absolute',
    top:        48,
    left:       12,
    background: 'rgba(0,0,0,0.65)',
    padding:    '4px 10px',
    borderRadius: 6,
    fontFamily: 'monospace',
    fontSize:   11,
    color:      '#ccc',
    userSelect: 'none',
    pointerEvents: 'none',
    display:    'flex',
    flexDirection: 'column',
    gap: 2,
  },
  row: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  section: {
    color: '#9aa0a6',
    fontWeight: 600,
  },
};

function fmt(value: number): string {
  return value.toFixed(1);
}

export function TileTooltip() {
  const [info, setInfo] = useState<TileInfo | null>(null);
  const [isInspectHeld, setIsInspectHeld] = useState(false);

  useEffect(() => {
    bus.on('tileHover', setInfo);
    return () => bus.off('tileHover', setInfo);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key.toLowerCase() !== 'q') return;
      setIsInspectHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'q') return;
      setIsInspectHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  if (!isInspectHeld || !info) return null;

  return (
    <div style={styles.tileTooltip}>
      <div style={styles.row}>
        <span style={styles.section}>terrain</span>
        <span style={{ color: '#f0c040', fontWeight: 'bold' }}>{info.type}</span>
        <span style={{ color: '#888' }}>({info.x},{info.y})</span>
      </div>
      <div style={styles.row}>
        <span style={styles.section}>resources</span>
        <span style={{ color: '#56d973' }}>food {fmt(info.foodValue)}/{fmt(info.maxFood)}</span>
        <span style={{ color: '#ff8800' }}>material {fmt(info.materialValue)}/{fmt(info.maxMaterial)}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.section}>tile</span>
        <span>warmth {fmt(info.warmth)}</span>
        <span>danger {fmt(info.danger)}</span>
        <span>traffic {fmt(info.trafficScore)}</span>
        <span>moveCost {fmt(info.moveCost)}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.section}>weights</span>
        <span>foodPri {fmt(info.foodPriority)}</span>
        <span>matPri {fmt(info.materialPriority)}</span>
        <span>cons {fmt(info.consumablesPressure)}</span>
        <span>ore {fmt(info.orePressure)}</span>
        <span>wood {fmt(info.woodPressure)}</span>
        <span>upg {fmt(info.upgradesPressure)}</span>
      </div>
    </div>
  );
}
