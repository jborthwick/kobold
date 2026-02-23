import * as Phaser from 'phaser';
import { TILE_SIZE } from '../../shared/constants';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    // colored_packed.png: 49 cols × 22 rows, 16×16 tiles, no spacing
    this.load.spritesheet('tiles', 'assets/kenney-1-bit/Tilesheet/colored_packed.png', {
      frameWidth:  TILE_SIZE,
      frameHeight: TILE_SIZE,
    });
  }

  create() {
    this.scene.start('WorldScene');
  }
}
