import { TileType } from '../shared/types';

/**
 * Cost in ticks to enter a tile type.
 * 1 = normal speed (one tile per tick). Higher values slow movement.
 */
export function getTerrainMoveCost(tileType: TileType): number {
  switch (tileType) {
    case TileType.Pool:
      return 4;
    case TileType.Stone:
    case TileType.Ore:
      return 3;
    case TileType.Farmland:
    case TileType.CropGrowing:
    case TileType.CropRipe:
      return 2;

    case TileType.Dirt:
    case TileType.Grass:
    case TileType.Water: // not walkable, but keep defined for completeness
    case TileType.Forest:
    case TileType.Mushroom:
    case TileType.Wall:
    case TileType.WoodWall:
    case TileType.StoneWall:
    case TileType.Hearth:
    case TileType.TreeStump:
    case TileType.Fire:
      return 1;
    default: {
      const _exhaustive: never = tileType;
      return _exhaustive;
    }
  }
}

