import { useState } from 'react';
import { peekSave, deleteSave } from '../shared/save';
import { type FactionId, FACTIONS } from '../shared/factions';

interface Props {
  onStart: (mode: 'new' | 'load', faction?: FactionId) => void;
}

export function StartMenu({ onStart }: Props) {
  const save = peekSave();
  const [confirmNew, setConfirmNew] = useState(false);
  const [faction, setFaction] = useState<FactionId>('goblins');

  // Read faction from save metadata
  const savedFaction: FactionId = save?.faction ?? 'goblins';
  const savedCfg = save ? FACTIONS[savedFaction] : null;

  const handleContinue = () => onStart('load');

  const handleNewColony = () => {
    if (save) {
      setConfirmNew(true);
    } else {
      onStart('new', faction);
    }
  };

  const handleConfirmNew = () => {
    deleteSave();
    onStart('new', faction);
  };

  const cfg = FACTIONS[faction];

  return (
    <div style={styles.backdrop}>
      <div style={styles.panel}>
        <div style={{ ...styles.title, color: save ? (savedCfg?.accentColor ?? '#f0c040') : cfg.accentColor }}>
          {save ? (savedCfg?.title ?? 'KOBOLD') : cfg.title}
        </div>
        <div style={styles.subtitle}>
          {save ? (savedCfg?.subtitle ?? 'colony sim') : cfg.subtitle}
        </div>

        <div style={styles.divider} />

        {save ? (
          <>
            <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={handleContinue}>
              ▶ Continue Colony
            </button>
            <div style={styles.saveInfo}>
              <span style={styles.saveInfoItem}>tick {save.tick.toLocaleString()}</span>
              <span style={styles.dot}>·</span>
              <span style={styles.saveInfoItem}>
                {save.aliveGoblins} {savedCfg?.unitNoun ?? 'goblin'}{save.aliveGoblins !== 1 ? 's' : ''} alive
              </span>
            </div>
          </>
        ) : null}

        {/* Faction picker — only visible for new games */}
        {!save || confirmNew ? (
          <div style={styles.factionPicker}>
            <div style={styles.factionLabel}>choose your colony</div>
            <div style={styles.factionBtns}>
              <button
                style={{
                  ...styles.factionBtn,
                  ...(faction === 'goblins' ? styles.factionBtnActive : styles.factionBtnInactive),
                  borderColor: faction === 'goblins' ? FACTIONS.goblins.accentColor : '#333',
                  color: faction === 'goblins' ? FACTIONS.goblins.accentColor : '#666',
                }}
                onClick={() => setFaction('goblins')}
              >
                <span style={styles.factionIcon}>👺</span>
                <span style={styles.factionName}>Goblins</span>
                <span style={styles.factionDesc}>chaos · dark humor</span>
              </button>
              <button
                style={{
                  ...styles.factionBtn,
                  ...(faction === 'dwarves' ? styles.factionBtnActive : styles.factionBtnInactive),
                  borderColor: faction === 'dwarves' ? FACTIONS.dwarves.accentColor : '#333',
                  color: faction === 'dwarves' ? FACTIONS.dwarves.accentColor : '#666',
                }}
                onClick={() => setFaction('dwarves')}
              >
                <span style={styles.factionIcon}>⛏</span>
                <span style={styles.factionName}>Dwarves</span>
                <span style={styles.factionDesc}>order · saga tone</span>
              </button>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: save ? 16 : 0 }}>
          {confirmNew ? (
            <div style={styles.confirmBox}>
              <div style={styles.confirmText}>abandon your colony? this cannot be undone.</div>
              <div style={styles.confirmBtns}>
                <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={handleConfirmNew}>
                  yes, start fresh
                </button>
                <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={() => setConfirmNew(false)}>
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              style={{ ...styles.btn, ...(save ? styles.btnSecondary : styles.btnPrimary) }}
              onClick={handleNewColony}
            >
              {save ? '⚑ New Colony' : '▶ New Colony'}
            </button>
          )}
        </div>

        <div style={styles.hint}>
          {save
            ? 'auto-saves every ~45 seconds'
            : cfg.startHint}
        </div>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position:       'fixed',
    inset:          0,
    background:     '#1a1a2e',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         9999,
  } as React.CSSProperties,

  panel: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    background:     'rgba(0,0,0,0.6)',
    border:         '1px solid #333',
    borderRadius:   12,
    padding:        '40px 52px',
    minWidth:       300,
    fontFamily:     'monospace',
    userSelect:     'none',
  } as React.CSSProperties,

  title: {
    fontSize:      42,
    fontWeight:    'bold',
    color:         '#f0c040',
    letterSpacing: '0.18em',
    lineHeight:    1,
  },

  subtitle: {
    fontSize:      11,
    color:         '#555',
    letterSpacing: '0.2em',
    marginTop:     4,
    textTransform: 'uppercase',
  } as React.CSSProperties,

  divider: {
    width:        '100%',
    height:       1,
    background:   '#2a2a3e',
    margin:       '28px 0 24px',
  },

  btn: {
    width:         '100%',
    fontFamily:    'monospace',
    fontSize:      13,
    fontWeight:    'bold',
    border:        'none',
    borderRadius:  6,
    padding:       '10px 24px',
    cursor:        'pointer',
    letterSpacing: '0.05em',
    transition:    'opacity 0.1s',
  } as React.CSSProperties,

  btnPrimary: {
    background: 'rgba(240,192,64,0.18)',
    color:      '#f0c040',
    border:     '1px solid rgba(240,192,64,0.3)',
  },

  btnSecondary: {
    background: 'rgba(120,120,120,0.15)',
    color:      '#888',
    border:     '1px solid #333',
  },

  btnDanger: {
    background: 'rgba(200,50,50,0.2)',
    color:      '#e74c3c',
    border:     '1px solid rgba(200,50,50,0.3)',
  },

  saveInfo: {
    display:    'flex',
    gap:        6,
    marginTop:  8,
    fontSize:   10,
    color:      '#555',
    alignItems: 'center',
  },

  saveInfoItem: {
    color: '#666',
  },

  dot: {
    color: '#333',
  },

  confirmBox: {
    display:       'flex',
    flexDirection: 'column',
    gap:           10,
    width:         '100%',
  } as React.CSSProperties,

  confirmText: {
    fontSize:  10,
    color:     '#e74c3c',
    textAlign: 'center',
  } as React.CSSProperties,

  confirmBtns: {
    display:       'flex',
    flexDirection: 'column',
    gap:           6,
    width:         '100%',
  } as React.CSSProperties,

  hint: {
    marginTop:  20,
    fontSize:   9,
    color:      '#333',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  } as React.CSSProperties,

  // ── Faction picker ────────────────────────────────────────────────────
  factionPicker: {
    width:        '100%',
    marginBottom: 16,
  },

  factionLabel: {
    fontSize:      9,
    color:         '#555',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    textAlign:     'center',
    marginBottom:  10,
  } as React.CSSProperties,

  factionBtns: {
    display: 'flex',
    gap:     8,
    width:   '100%',
  },

  factionBtn: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           4,
    padding:       '10px 8px',
    borderRadius:  8,
    border:        '1px solid #333',
    background:    'transparent',
    cursor:        'pointer',
    fontFamily:    'monospace',
    transition:    'all 0.15s',
  } as React.CSSProperties,

  factionBtnActive: {
    background: 'rgba(240,192,64,0.08)',
  },

  factionBtnInactive: {
    background: 'transparent',
  },

  factionIcon: {
    fontSize: 20,
    lineHeight: 1,
  },

  factionName: {
    fontSize:      11,
    fontWeight:    'bold',
    letterSpacing: '0.05em',
  },

  factionDesc: {
    fontSize: 8,
    color:    '#555',
    letterSpacing: '0.05em',
  },
};
