import { useEffect, useRef, useState } from 'react';
import { bus } from '../shared/events';
import type { LogEntry } from '../shared/types';

const MAX_ENTRIES = 50;

export function EventLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (entry: LogEntry) => {
      setEntries(prev => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    };
    bus.on('logEntry', handler);
    return () => bus.off('logEntry', handler);
  }, []);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>EVENT LOG</div>
      {entries.length === 0
        ? <div style={styles.empty}>Waiting for events…</div>
        : entries.map((e, i) => (
            <div key={i} style={{ ...styles.entry, color: levelColor(e.level) }}>
              <span style={styles.tick}>[{e.tick}]</span>
              <span style={styles.name}>{e.dwarfName}</span>
              {e.message}
            </div>
          ))
      }
      <div ref={bottomRef} />
    </div>
  );
}

function levelColor(level: LogEntry['level']): string {
  if (level === 'error') return '#e74c3c';
  if (level === 'warn')  return '#e67e22';
  return '#8ecae6';
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position:       'absolute',
    bottom:         16,
    right:          12,
    width:          280,
    maxHeight:      200,
    overflowY:      'auto',
    background:     'rgba(0,0,0,0.70)',
    borderRadius:   8,
    padding:        '6px 10px',
    fontFamily:     'monospace',
    fontSize:       11,
    color:          '#aaa',
    userSelect:     'none',
    pointerEvents:  'none',
    display:        'flex',
    flexDirection:  'column',
    gap:            2,
    scrollbarWidth: 'thin',
    scrollbarColor: '#444 transparent',
  } as React.CSSProperties,
  header: {
    fontSize:      9,
    color:         '#555',
    letterSpacing: '0.1em',
    marginBottom:  4,
    borderBottom:  '1px solid #222',
    paddingBottom: 3,
  },
  empty: {
    color:     '#444',
    fontStyle: 'italic',
    fontSize:  10,
  },
  entry: {
    lineHeight:   '1.4',
    whiteSpace:   'nowrap',
    overflow:     'hidden',
    textOverflow: 'ellipsis',
  },
  tick: {
    color:       '#555',
    marginRight: 4,
  },
  name: {
    color:       '#f0c040',
    marginRight: 4,
    fontWeight:  'bold',
  },
};
