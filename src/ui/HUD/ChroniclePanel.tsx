import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { Chapter } from '../../shared/types';

const styles: Record<string, React.CSSProperties> = {
  chroniclePanel: {
    background:    'rgba(30, 22, 12, 0.85)',
    padding:       '8px 12px',
    fontFamily:    'monospace',
    fontSize:      11,
    color:         '#d4c4a0',
    userSelect:    'none',
    pointerEvents: 'auto' as const,
    cursor:        'pointer',
    flexShrink:    0,
    borderLeft:    '2px solid #8b7355',
    borderBottom:  '1px solid #333',
    maxHeight:     200,
    overflowY:     'auto' as const,
    scrollbarWidth: 'thin' as const,
    scrollbarColor: '#6b5b45 transparent',
  },
  chronicleHeader: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    fontSize:       8,
    color:          '#6b5b45',
    letterSpacing:  '0.1em',
    textTransform:  'uppercase' as const,
    marginBottom:   4,
  },
  chronicleToggle: {
    fontSize: 8,
    color:    '#6b5b45',
  },
  chronicleEntry: {
    marginBottom: 6,
  },
  chronicleLabel: {
    fontSize:     8,
    color:        '#6b5b45',
    marginBottom: 2,
  },
  chronicleText: {
    color:      '#d4c4a0',
    fontStyle:  'italic',
    fontSize:   10,
    lineHeight: '1.5',
    wordBreak:  'break-word' as const,
  },
};

export function ChroniclePanel() {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onChapter = (ch: Chapter) => setChapters(prev => [...prev, ch]);
    const onRestore = (chs: Chapter[]) => setChapters(chs);
    bus.on('chronicleChapter', onChapter);
    bus.on('restoreChronicle', onRestore);
    return () => {
      bus.off('chronicleChapter', onChapter);
      bus.off('restoreChronicle', onRestore);
    };
  }, []);

  if (chapters.length === 0) return null;

  const latest = chapters[chapters.length - 1];
  const shown  = expanded ? chapters : [latest];

  return (
    <div
      style={styles.chroniclePanel}
      onClick={() => setExpanded(e => !e)}
    >
      <div style={styles.chronicleHeader}>
        <span>📜 CHRONICLE</span>
        <span style={styles.chronicleToggle}>{expanded ? '▲' : `▼ ${chapters.length} ch.`}</span>
      </div>
      {shown.map(ch => (
        <div key={ch.chapterNumber} style={styles.chronicleEntry}>
          <div style={styles.chronicleLabel}>
            Chapter {ch.chapterNumber} · tick {ch.tick}
          </div>
          <div style={styles.chronicleText}>{ch.text}</div>
        </div>
      ))}
    </div>
  );
}
