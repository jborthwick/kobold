import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { Chapter } from '../../shared/types';

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flexShrink: 0,
    borderLeft: '2px solid #8b7355',
    borderBottom: '1px solid #333',
    background: 'rgba(30, 22, 12, 0.85)',
    pointerEvents: 'auto' as const,
  },
  chronicleHeader: {
    width: '100%',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    fontSize: 8,
    color: '#6b5b45',
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    userSelect: 'none',
    fontFamily: 'monospace',
  },
  chevron: {
    fontSize: 8,
    color: '#6b5b45',
  },
  scroll: {
    maxHeight: 220,
    overflowY: 'auto' as const,
    padding: '0 12px 10px',
    scrollbarWidth: 'thin' as const,
    scrollbarColor: '#6b5b45 transparent',
  },
  chronicleEntry: {
    marginBottom: 10,
  },
  chronicleLabel: {
    fontSize: 8,
    color: '#6b5b45',
    marginBottom: 2,
    fontFamily: 'monospace',
  },
  chronicleText: {
    color: '#d4c4a0',
    fontStyle: 'italic',
    fontSize: 10,
    lineHeight: '1.5',
    wordBreak: 'break-word' as const,
    fontFamily: 'monospace',
  },
};

export function ChroniclePanel() {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [open, setOpen] = useState(true);

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

  return (
    <div style={styles.wrapper}>
      <button
        type="button"
        style={styles.chronicleHeader}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>📜 Chronicle · {chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'}</span>
        <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={styles.scroll}>
          {chapters.map(ch => (
            <div key={ch.chapterNumber} style={styles.chronicleEntry}>
              <div style={styles.chronicleLabel}>
                Chapter {ch.chapterNumber} · tick {ch.tick}
              </div>
              <div style={styles.chronicleText}>{ch.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
