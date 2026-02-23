import { useEffect, useRef } from 'react';
import * as Phaser from 'phaser';
import { WorldScene } from './scenes/WorldScene';

export function PhaserGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef      = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    gameRef.current = new Phaser.Game({
      type:            Phaser.AUTO,
      parent:          containerRef.current,
      backgroundColor: '#1a1a2e',
      scene:           [WorldScene],
      scale: {
        mode:       Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}
