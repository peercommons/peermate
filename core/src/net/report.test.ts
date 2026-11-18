import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveIdentity } from './identity.ts';
import { buildReport, verifyReport } from './report.ts';

const me = deriveIdentity(new Uint8Array(32).fill(7));
const them = deriveIdentity(new Uint8Array(32).fill(8));

test('report: signed by the reporter, and any edit breaks it', () => {
  const text = buildReport(me, {
    reporter: { nick: 'Alice' },
    opponent: { key: them.peer.publicKey, nick: 'Mallory\nfake line' },
    gameId: 'g1',
    timeControl: '5+0',
    moves: ['e4', 'e5', 'Nf3'],
    chat: [{ from: 'opponent', text: 'rude words', at: 0 }],
    reason: 'abusive chat',
    at: Date.UTC(2026, 10, 18),
  });
  assert.equal(verifyReport(text), me.peer.publicKey);
  assert.match(text, /1\. e4 e5 2\. Nf3/);
  assert.match(text, /Mallory fake line/); // a nickname can't inject lines
  assert.equal(verifyReport(text.replace('rude words', 'nice words')), null);
  assert.equal(verifyReport('no signature here'), null);
});
