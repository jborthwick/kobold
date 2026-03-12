/**
 * Full-screen chronicle modal shown when a new chapter is logged.
 * Displays chronicle in reverse chronological order (latest on top), highlights the new chapter,
 * and pauses the world until the player clicks "Next chapter".
 */

import { useEffect, useState } from 'react';
import { bus } from '../shared/events';
import type { Chapter } from '../shared/types';

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    pointerEvents: 'auto' as const,
  },
  modal: {
    background: 'rgba(30, 22, 12, 0.98)',
    border: '2px solid #8b7355',
    borderRadius: 8,
    maxWidth: 520,
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'monospace',
    color: '#d4c4a0',
    boxShadow: '0 0 24px rgba(0,0,0,0.5)',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #6b5b45',
    fontSize: 12,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color: '#8b7355',
  },
  scroll: {
    padding: 12,
    overflowY: 'auto' as const,
    scrollbarWidth: 'thin' as const,
    scrollbarColor: '#6b5b45 transparent',
    flex: 1,
  },
  entry: {
    marginBottom: 14,
  },
  entryHighlight: {
    marginBottom: 14,
    padding: 10,
    background: 'rgba(139, 115, 85, 0.25)',
    borderLeft: '3px solid #c4a574',
    borderRadius: 4,
  },
  label: {
    fontSize: 10,
    color: '#6b5b45',
    marginBottom: 4,
  },
  text: {
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid #6b5b45',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  button: {
    padding: '8px 20px',
    fontFamily: 'monospace',
    fontSize: 12,
    background: '#6b5b45',
    color: '#d4c4a0',
    border: '1px solid #8b7355',
    borderRadius: 4,
    cursor: 'pointer',
  },
};

export function ChronicleModal() {
  const [state, setState] = useState<{
    open: boolean;
    chapter: Chapter | null;
    allChapters: Chapter[];
  } | null>(null);

  useEffect(() => {
    const handler = (payload: { open: boolean; chapter: Chapter; allChapters: Chapter[] }) => {
      if (payload.open) {
        setState({
          open: true,
          chapter: payload.chapter,
          allChapters: payload.allChapters,
        });
      }
    };
    bus.on('chronicleModal', handler);
    return () => bus.off('chronicleModal', handler);
  }, []);

  const handleClose = () => {
    setState(null);
    bus.emit('chronicleModalClosed', undefined);
  };

  if (!state?.open) return null;

  // Reverse chronological order (latest on top)
  const ordered = [...state.allChapters].reverse();
  const latestChapterNumber = state.chapter?.chapterNumber ?? (state.allChapters.length > 0 ? state.allChapters[state.allChapters.length - 1].chapterNumber : 0);

  return (
    <div style={styles.backdrop} role="dialog" aria-label="Chronicle">
      <div style={styles.modal}>
        <div style={styles.header}>Chronicle</div>
        <div style={styles.scroll}>
          {ordered.map((ch) => {
            const isLatest = ch.chapterNumber === latestChapterNumber;
            return (
              <div
                key={ch.chapterNumber}
                style={isLatest ? styles.entryHighlight : styles.entry}
              >
                <div style={styles.label}>
                  Chapter {ch.chapterNumber} · tick {ch.tick}
                </div>
                <div style={styles.text}>{ch.text}</div>
              </div>
            );
          })}
        </div>
        <div style={styles.footer}>
          <button type="button" style={styles.button} onClick={handleClose}>
            Next chapter
          </button>
        </div>
      </div>
    </div>
  );
}
