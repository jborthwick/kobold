import { useRef, useState, useCallback, type TouchEvent, type MouseEvent } from 'react';
import { ColonyGoalPanel, SelectedDwarfPanel } from './HUD';
import { EventLog } from './EventLog';
import type { LayoutMode } from '../shared/useViewport';

type SheetState = 'collapsed' | 'half' | 'expanded';
const STATES: SheetState[] = ['collapsed', 'half', 'expanded'];

const COLLAPSED_H = 56;
const CONTROLS_H  = 56; // matches MobileControls height

export function MobileBottomSheet({ layout }: { layout: LayoutMode }) {
  const [sheetState, setSheetState] = useState<SheetState>('collapsed');
  const dragStartY  = useRef(0);
  const dragStartH  = useRef(0);
  const currentH    = useRef(COLLAPSED_H);
  const sheetRef    = useRef<HTMLDivElement>(null);
  const dragged     = useRef(false);

  const getHeight = (state: SheetState): number => {
    const vh = window.innerHeight;
    switch (state) {
      case 'collapsed': return COLLAPSED_H;
      case 'half':      return vh * 0.4;
      case 'expanded':  return vh * 0.85;
    }
  };

  const snapTo = useCallback((next: SheetState) => {
    const snapH = getHeight(next);
    currentH.current = snapH;
    setSheetState(next);
    if (sheetRef.current) {
      sheetRef.current.style.height = `${snapH}px`;
      sheetRef.current.style.transition = 'height 0.2s ease';
    }
  }, []);

  const snapToNearest = useCallback(() => {
    const h = currentH.current;
    const vh = window.innerHeight;
    let next: SheetState;
    if (h < vh * 0.2) {
      next = 'collapsed';
    } else if (h < vh * 0.6) {
      next = 'half';
    } else {
      next = 'expanded';
    }
    snapTo(next);
  }, [snapTo]);

  // --- Touch handlers ---
  const onTouchStart = useCallback((e: TouchEvent) => {
    dragged.current = false;
    dragStartY.current = e.touches[0].clientY;
    dragStartH.current = currentH.current;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    dragged.current = true;
    const dy = dragStartY.current - e.touches[0].clientY;
    const newH = Math.max(COLLAPSED_H, Math.min(window.innerHeight * 0.85, dragStartH.current + dy));
    currentH.current = newH;
    if (sheetRef.current) {
      sheetRef.current.style.height = `${newH}px`;
      sheetRef.current.style.transition = 'none';
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    snapToNearest();
  }, [snapToNearest]);

  // --- Mouse handlers (desktop drag) ---
  const onMouseDown = useCallback((e: MouseEvent) => {
    dragged.current = false;
    dragStartY.current = e.clientY;
    dragStartH.current = currentH.current;

    const onMouseMove = (ev: globalThis.MouseEvent) => {
      dragged.current = true;
      const dy = dragStartY.current - ev.clientY;
      const newH = Math.max(COLLAPSED_H, Math.min(window.innerHeight * 0.85, dragStartH.current + dy));
      currentH.current = newH;
      if (sheetRef.current) {
        sheetRef.current.style.height = `${newH}px`;
        sheetRef.current.style.transition = 'none';
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (dragged.current) {
        snapToNearest();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [snapToNearest]);

  // --- Click to cycle (collapsed → half → expanded → collapsed) ---
  const onHandleClick = useCallback(() => {
    if (dragged.current) return; // ignore click after drag
    const idx = STATES.indexOf(sheetState);
    const next = STATES[(idx + 1) % STATES.length];
    snapTo(next);
  }, [sheetState, snapTo]);

  const height = getHeight(sheetState);

  return (
    <div
      ref={sheetRef}
      style={{
        ...styles.sheet,
        height,
        bottom: CONTROLS_H,
      }}
    >
      {/* Drag handle — supports touch drag, mouse drag, and click-to-cycle */}
      <div
        style={styles.handleArea}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
        onClick={onHandleClick}
      >
        <div style={styles.handle} />
      </div>

      <div style={styles.content}>
        <ColonyGoalPanel />
        {sheetState !== 'collapsed' && <SelectedDwarfPanel />}
        {sheetState === 'expanded' && <EventLog layout={layout} />}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    background: 'rgba(0,0,0,0.88)',
    borderRadius: '12px 12px 0 0',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    pointerEvents: 'auto',
    transition: 'height 0.2s ease',
    zIndex: 9,
  },
  handleArea: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: 4,
    cursor: 'grab',
    flexShrink: 0,
  },
  handle: {
    width: 40,
    height: 4,
    background: '#555',
    borderRadius: 2,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    scrollbarWidth: 'thin',
    scrollbarColor: '#444 transparent',
  } as React.CSSProperties,
};
