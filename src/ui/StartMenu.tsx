import { useState } from 'react';
import { peekSave, deleteSave } from '../shared/save';

interface Props {
  onStart: (mode: 'new' | 'load') => void;
}

export function StartMenu({ onStart }: Props) {
  const save = peekSave();
  const [confirmNew, setConfirmNew] = useState(false);

  const handleContinue = () => onStart('load');

  const handleNewColony = () => {
    if (save) {
      setConfirmNew(true);
    } else {
      onStart('new');
    }
  };

  const handleConfirmNew = () => {
    deleteSave();
    onStart('new');
  };

  return (
    <div style={styles.backdrop}>
      <div style={styles.panel}>
        <div style={styles.title}>KOBOLD</div>
        <div style={styles.subtitle}>dwarf colony sim</div>

        <div style={styles.divider} />

        {save ? (
          <>
            <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={handleContinue}>
              ▶ Continue Colony
            </button>
            <div style={styles.saveInfo}>
              <span style={styles.saveInfoItem}>tick {save.tick.toLocaleString()}</span>
              <span style={styles.dot}>·</span>
              <span style={styles.saveInfoItem}>{save.aliveDwarves} dwarf{save.aliveDwarves !== 1 ? 's' : ''} alive</span>
            </div>
          </>
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
            : 'a procedural colony awaits'}
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
};
