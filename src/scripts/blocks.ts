type allBlocks = 'air' | 'grass' | 'dirt';

export const blocks:{
  [key in allBlocks]: {
    id: number;
    name: string;
    color?: number;
  }
} = {
  air: {
    id: 0,
    name: 'Air',
  },
  grass:{
    id: 1,
    name: 'Grass Block',
    color: 0x559020
  },
  dirt:{
    id: 2,
    name: 'Dirt Block',
    color: 0x807020
  },
}