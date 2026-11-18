// Peermate's piece set: original artwork drawn for this project (SPECS §14.1),
// no third-party set involved. Every shape is plain SVG path data on a 100x100
// canvas, so the same data renders in the app (react-native-svg) and in the
// preview script (app/tools/pieces-preview.mjs).
//
// Each piece is a list of layers: `body` is filled in the side's colour with an
// outline; `detail` is a line drawn in the outline colour on white pieces and in
// the light colour on black pieces, so features stay visible on both.
import type { PieceSymbol } from '@peermate/core';

export type PieceLayer = { d: string; role: 'body' | 'detail' };

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}` +
  `h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;

// Shared plinth: every piece stands on the same rounded base.
const base = (w: number) => rect(50 - w / 2, 80, w, 10, 4);

export const PIECES: Record<PieceSymbol, PieceLayer[]> = {
  p: [
    { role: 'body', d: 'M37 81C38 66 42 56 46 50H54C58 56 62 66 63 81Z' },
    { role: 'body', d: rect(39, 46, 22, 6, 3) },
    { role: 'body', d: circle(50, 33, 12) },
    { role: 'body', d: base(40) },
  ],
  r: [
    { role: 'body', d: 'M35 81L37 40H63L65 81Z' },
    { role: 'body', d: rect(31, 36, 38, 6, 3) },
    { role: 'body', d: 'M30 16H38V23H45V16H55V23H62V16H70V34Q70 37 67 37H33Q30 37 30 34Z' },
    { role: 'detail', d: 'M39 52H61M39 66H61' },
    { role: 'body', d: base(48) },
  ],
  b: [
    { role: 'body', d: 'M40 81C42 70 44 62 43 55H57C56 62 58 70 60 81Z' },
    { role: 'body', d: rect(37, 50, 26, 6, 3) },
    { role: 'body', d: 'M50 15C63 24 67 38 60 49H40C33 38 37 24 50 15Z' },
    { role: 'body', d: circle(50, 12, 4.5) },
    { role: 'detail', d: 'M54 27L47 38' },
    { role: 'body', d: base(44) },
  ],
  n: [
    {
      role: 'body',
      d: 'M30 81C29 68 36 60 45 53L33 59C27 62 21 59 20 53C19 48 22 44 27 41L41 29C44 24 48 21 51 20L54 10L60 19C74 25 80 48 74 81Z',
    },
    { role: 'detail', d: 'M60 22C69 33 71 55 67 76' },
    { role: 'detail', d: circle(41, 34, 1.6) },
    { role: 'detail', d: 'M25 51L28 50' },
    { role: 'body', d: base(48) },
  ],
  q: [
    { role: 'body', d: 'M31 77L22 32L33 53L36 25L44 50L50 20L56 50L64 25L67 53L78 32L69 77Z' },
    { role: 'body', d: circle(22, 30, 4) },
    { role: 'body', d: circle(36, 23, 4) },
    { role: 'body', d: circle(50, 17, 4.5) },
    { role: 'body', d: circle(64, 23, 4) },
    { role: 'body', d: circle(78, 30, 4) },
    { role: 'detail', d: 'M34 69H66' },
    { role: 'body', d: base(48) },
  ],
  k: [
    { role: 'body', d: 'M47 6H53V13H59V19H53V27H47V19H41V13H47Z' },
    { role: 'body', d: 'M42 46C42 35 45 30 50 27C55 30 58 35 58 46Z' },
    { role: 'body', d: 'M30 77C22 60 26 42 38 41C45 40 49 46 50 51C51 46 55 40 62 41C74 42 78 60 70 77Z' },
    { role: 'detail', d: 'M34 69H66' },
    { role: 'body', d: base(48) },
  ],
};

export const PIECE_COLORS = {
  w: { fill: '#f6f2e8', stroke: '#26221d', detail: '#26221d' },
  b: { fill: '#2b2826', stroke: '#0f0d0c', detail: '#d9d2c3' },
} as const;

export const STROKE_WIDTH = 3;
