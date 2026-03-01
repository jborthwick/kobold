import { useState, useEffect } from 'react';
import { bus } from '../shared/events';
import type { GameState, OverlayMode } from '../shared/types';

const OVERLAY_MODES: OverlayMode[] = ['off', 'food', 'material', 'wood'];
const OVERLAY_ICONS: Record<OverlayMode, string> = {
  off:      '◇',
  food:     '◈',
  material: '◈',
  wood:     '◈',
};

export function MobileControls() {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  const overlayMode = state?.overlayMode ?? 'off';

  const cycleOverlay = () => {
    const next = OVERLAY_MODES[(OVERLAY_MODES.indexOf(overlayMode) + 1) % OVERLAY_MODES.length];
    bus.emit('overlayChange', { mode: next });
  };

  return (
    <div style={styles.bar}>
      <MobileBtn
        icon={state?.paused ? '▶' : '⏸'}
        label={state?.paused ? 'play' : 'pause'}
        active={state?.paused}
        onTap={() => bus.emit('controlChange', { action: 'pause' })}
      />
      <MobileBtn
        icon="−"
        label="slow"
        onTap={() => bus.emit('controlChange', { action: 'speedDown' })}
      />
      <span style={styles.speedLabel}>{state?.speed ?? 1}×</span>
      <MobileBtn
        icon="+"
        label="fast"
        onTap={() => bus.emit('controlChange', { action: 'speedUp' })}
      />
      <div style={styles.divider} />
      <MobileBtn
        icon={OVERLAY_ICONS[overlayMode]}
        label={overlayMode === 'off' ? 'overlay' : overlayMode}
        active={overlayMode !== 'off'}
        onTap={cycleOverlay}
      />
      <MobileBtn
        icon="◀"
        label="prev"
        onTap={() => bus.emit('cycleSelected', { direction: -1 })}
      />
      <MobileBtn
        icon="▶"
        label="next"
        onTap={() => bus.emit('cycleSelected', { direction: 1 })}
      />
    </div>
  );
}

function MobileBtn({
  icon, label, active, onTap,
}: { icon: string; label: string; active?: boolean; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      style={{
        ...styles.btn,
        ...(active ? styles.btnActive : {}),
      }}
    >
      <span style={styles.btnIcon}>{icon}</span>
      <span style={styles.btnLabel}>{label}</span>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 'var(--sab, 0px)',
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    height: 56,
    pointerEvents: 'auto',
    borderTop: '1px solid #222',
    zIndex: 10,
  },
  btn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    background: 'rgba(255,255,255,0.06)',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'monospace',
    padding: 0,
    WebkitTapHighlightColor: 'transparent',
  } as React.CSSProperties,
  btnActive: {
    background: 'rgba(240,192,64,0.15)',
  },
  btnIcon: {
    fontSize: 16,
    color: '#ccc',
    lineHeight: 1,
  },
  btnLabel: {
    fontSize: 8,
    color: '#666',
    marginTop: 2,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  speedLabel: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: 'bold',
    color: '#fff',
    minWidth: 24,
    textAlign: 'center' as const,
  },
  divider: {
    width: 1,
    height: 28,
    background: '#333',
    marginLeft: 4,
    marginRight: 4,
  },
};
