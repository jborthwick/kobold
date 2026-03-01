import { useState, useEffect } from 'react';

export type LayoutMode = 'phone' | 'tablet' | 'desktop';

function getMode(): LayoutMode {
  const w = window.innerWidth;
  if (w < 768) return 'phone';
  if (w < 1200) return 'tablet';
  return 'desktop';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(getMode());

  useEffect(() => {
    const handler = () => setMode(getMode());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return mode;
}
