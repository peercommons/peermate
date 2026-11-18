// Renders the piece set to an SVG sheet for review:
//   node app/tools/pieces-preview.mjs out.svg
import { writeFileSync } from 'node:fs';
import { PIECES, PIECE_COLORS, STROKE_WIDTH } from '../src/components/pieces.ts';

const order = (process.argv[3] ?? 'kqrbnp').split('');
const cell = 100;
const squares = [];
const pieces = [];
['w', 'b'].forEach((color, row) => {
  for (const shade of [0, 1]) {
    order.forEach((type, col) => {
      const x = col * cell;
      const y = (row * 2 + shade) * cell;
      squares.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${(col + shade) % 2 ? '#b58863' : '#f0d9b5'}"/>`);
      const c = PIECE_COLORS[color];
      const layers = PIECES[type]
        .map((l) =>
          l.role === 'body'
            ? `<path d="${l.d}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round"/>`
            : `<path d="${l.d}" fill="none" stroke="${c.detail}" stroke-width="${STROKE_WIDTH * 0.8}" stroke-linecap="round"/>`,
        )
        .join('');
      pieces.push(`<g transform="translate(${x} ${y})">${layers}</g>`);
    });
  }
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${order.length * cell * 2}" height="${4 * cell * 2}" viewBox="0 0 ${order.length * cell} ${4 * cell}">${squares.join('')}${pieces.join('')}</svg>`;
writeFileSync(process.argv[2] ?? 'pieces.svg', svg);
