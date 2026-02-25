import { useEffect, useRef } from 'react';
import * as Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { WorldScene } from './scenes/WorldScene';

interface Props {
  startMode: 'new' | 'load';
}

export function PhaserGame({ startMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef      = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type:            Phaser.AUTO,
      parent:          containerRef.current,
      backgroundColor: '#1a1a2e',
      scene:           [BootScene, WorldScene],
      scale: {
        mode:       Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    // Store startMode in Phaser registry before any scene runs.
    // BootScene.preload() is async (file load), so this is set well before WorldScene.create() fires.
    game.registry.set('startMode', startMode);
    gameRef.current = game;

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);  // startMode is stable at mount; component only mounts once per game session

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}
