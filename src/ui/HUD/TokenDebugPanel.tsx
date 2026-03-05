import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';

const styles: Record<string, React.CSSProperties> = {
  tokenPanel: {
    position:   'absolute',
    bottom:     16,
    left:       152,
    background: 'rgba(0,0,0,0.72)',
    borderRadius: 6,
    padding:    '6px 10px',
    fontFamily: 'monospace',
    fontSize:   10,
    color:      '#aaa',
    userSelect: 'none',
    pointerEvents: 'auto' as const,
    minWidth:   160,
  },
  tokenHeader: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    fontSize:       9,
    color:          '#555',
    letterSpacing:  '0.08em',
    marginBottom:   5,
  },
  tokenToggle: {
    background: 'none',
    border:     'none',
    color:      '#555',
    cursor:     'pointer',
    fontFamily: 'monospace',
    fontSize:   9,
    padding:    0,
    lineHeight: 1,
  },
  tokenRow: {
    display:        'flex',
    justifyContent: 'space-between',
    gap:            12,
    marginBottom:   2,
  },
  tokenLabel: {
    color:   '#555',
    fontSize: 9,
  },
  tokenValue: {
    color:      '#ccc',
    fontSize:   9,
    fontWeight: 'bold' as const,
    textAlign:  'right' as const,
  },
};

export function TokenDebugPanel() {
  const [usage, setUsage] = useState<{
    inputTotal: number; outputTotal: number; callCount: number;
    lastInput: number; lastOutput: number;
  } | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    bus.on('tokenUsage', setUsage);
    return () => bus.off('tokenUsage', setUsage);
  }, []);

  if (!usage) return null;

  // Rough cost estimate: haiku input ~$0.80/M, output ~$4/M
  const costEstimate = (usage.inputTotal * 0.0000008 + usage.outputTotal * 0.000004).toFixed(4);
  const avgIn  = usage.callCount > 0 ? Math.round(usage.inputTotal  / usage.callCount) : 0;
  const avgOut = usage.callCount > 0 ? Math.round(usage.outputTotal / usage.callCount) : 0;

  return (
    <div style={styles.tokenPanel}>
      <div style={styles.tokenHeader}>
        <span>🔢 TOKEN USAGE</span>
        <button onClick={() => setVisible(v => !v)} style={styles.tokenToggle}>
          {visible ? '▲' : '▼'}
        </button>
      </div>
      {visible && (
        <>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>calls</span>
            <span style={styles.tokenValue}>{usage.callCount}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>input total</span>
            <span style={styles.tokenValue}>{usage.inputTotal.toLocaleString()}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>output total</span>
            <span style={styles.tokenValue}>{usage.outputTotal.toLocaleString()}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>avg in/out</span>
            <span style={styles.tokenValue}>{avgIn} / {avgOut}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>last call</span>
            <span style={styles.tokenValue}>{usage.lastInput}↑ {usage.lastOutput}↓</span>
          </div>
          <div style={{ ...styles.tokenRow, marginTop: 4, borderTop: '1px solid #333', paddingTop: 4 }}>
            <span style={styles.tokenLabel}>~cost (USD)</span>
            <span style={{ ...styles.tokenValue, color: '#f0c040' }}>${costEstimate}</span>
          </div>
        </>
      )}
    </div>
  );
}
