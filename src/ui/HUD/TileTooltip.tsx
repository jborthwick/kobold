import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { TileInfo } from '../../shared/types';

const styles: Record<string, React.CSSProperties> = {
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
    gap:        8,
  },
};

export function TileTooltip() {
  const [info, setInfo] = useState<TileInfo | null>(null);

  useEffect(() => {
    bus.on('tileHover', setInfo);
    return () => bus.off('tileHover', setInfo);
  }, []);

  if (!info) return null;

  const foodPct = info.maxFood > 0
    ? ` food ${info.foodValue.toFixed(1)}/${info.maxFood}`
    : '';
  const matPct  = info.maxMaterial > 0
    ? ` ore ${info.materialValue.toFixed(1)}/${info.maxMaterial}`
    : '';

  return (
    <div style={styles.tileTooltip}>
      <span style={{ color: '#f0c040', fontWeight: 'bold' }}>{info.type}</span>
      <span style={{ color: '#888' }}> ({info.x},{info.y})</span>
      {foodPct && <span style={{ color: '#56d973' }}>{foodPct}</span>}
      {matPct  && <span style={{ color: '#ff8800' }}>{matPct}</span>}
    </div>
  );
}
