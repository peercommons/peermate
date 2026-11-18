// Glicko-2 ratings (SPECS §7.5), computed locally from the player's own games.
// Glickman, "Example of the Glicko-2 system" (2013). Each game is its own
// rating period, as most online servers do.

export type Rating = {
  /** Rating on the Glicko scale (1500 = new player). */
  r: number;
  /** Rating deviation: uncertainty. 350 = unknown; under ~110 = established. */
  rd: number;
  /** Volatility. */
  vol: number;
  games: number;
};

export const NEW_RATING: Rating = { r: 1500, rd: 350, vol: 0.06, games: 0 };
/** Shown with a "?" until the deviation drops below this. */
export const PROVISIONAL_RD = 110;
const TAU = 0.5;
const SCALE = 173.7178;
const EPSILON = 0.000001;
const MIN_RD = 30;
const MAX_RD = 350;

export type RatedOpponent = { r: number; rd: number };

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * One rating period: `results` are [opponent, score] with score 1, 0.5 or 0.
 * With no games the deviation just grows (time without play).
 */
export function updateRating(player: Rating, results: [RatedOpponent, number][]): Rating {
  const mu = (player.r - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { ...player, rd: Math.min(MAX_RD, phiStar * SCALE) };
  }
  let vInv = 0;
  let deltaSum = 0;
  for (const [opp, score] of results) {
    const muJ = (opp.r - 1500) / SCALE;
    const phiJ = opp.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    deltaSum += g(phiJ) * (score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // New volatility (Illinois algorithm, step 5 of the paper).
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPSILON; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return {
    r: muNew * SCALE + 1500,
    rd: Math.min(MAX_RD, Math.max(MIN_RD, phiNew * SCALE)),
    vol: sigmaNew,
    games: player.games + results.length,
  };
}

/** A reported rating from a peer, clamped to sane values (it's self-reported). */
export function sanitizeOpponent(r: unknown, rd: unknown): RatedOpponent {
  const rating = typeof r === 'number' && Number.isFinite(r) ? Math.min(3500, Math.max(100, r)) : NEW_RATING.r;
  const dev = typeof rd === 'number' && Number.isFinite(rd) ? Math.min(MAX_RD, Math.max(MIN_RD, rd)) : MAX_RD;
  return { r: rating, rd: dev };
}

/** "1532" or "1500?" (provisional). */
export function formatRating(r: Rating | RatedOpponent): string {
  return `${Math.round(r.r)}${r.rd >= PROVISIONAL_RD ? '?' : ''}`;
}
