// Board themes and UI colours.
import type { BoardThemeName } from './settings';

export type BoardColors = {
  light: string;
  dark: string;
  lastMove: string;
  selected: string;
  check: string;
  hint: string;
};

const shared = {
  check: 'rgba(220, 40, 40, 0.75)',
  hint: 'rgba(30, 30, 30, 0.28)',
};

export const BOARD_THEMES: Record<BoardThemeName, { label: string } & BoardColors> = {
  wood: {
    label: 'Wood',
    light: '#EBD9B4',
    dark: '#B5835A',
    lastMove: 'rgba(235, 200, 60, 0.55)',
    selected: 'rgba(90, 160, 90, 0.65)',
    ...shared,
  },
  green: {
    label: 'Green',
    light: '#E9EDCC',
    dark: '#6E9A5B',
    lastMove: 'rgba(240, 220, 80, 0.55)',
    selected: 'rgba(40, 110, 160, 0.5)',
    ...shared,
  },
  blue: {
    label: 'Blue',
    light: '#DEE6EF',
    dark: '#7E9DB8',
    lastMove: 'rgba(240, 210, 90, 0.6)',
    selected: 'rgba(80, 170, 110, 0.6)',
    ...shared,
  },
  contrast: {
    label: 'High contrast',
    light: '#FFFFFF',
    dark: '#5A5A5A',
    lastMove: 'rgba(255, 200, 0, 0.7)',
    selected: 'rgba(0, 150, 255, 0.6)',
    check: 'rgba(255, 0, 0, 0.85)',
    hint: 'rgba(0, 120, 255, 0.55)',
  },
};

export const ui = {
  accent: '#2f6f4f',
  accentText: '#ffffff',
  muted: '#9aa',
  text: '#1d1d1d',
  subtle: '#666',
  background: '#fafafa',
  card: '#ffffff',
  border: '#ddd',
  good: '#2f6f4f',
  inaccuracy: '#c9a227',
  mistake: '#e07b24',
  blunder: '#c62828',
};
