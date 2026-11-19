import assert from 'node:assert/strict';
import test from 'node:test';
import { FAIL_LIMIT, MIN_ACTIVE, REST_BASE_MS, REST_MAX_MS, RelayHealth } from './relayHealth.ts';

const RELAYS = ['wss://a', 'wss://b', 'wss://c', 'wss://d', 'wss://e'];

function setup() {
  let t = 1_000_000;
  const h = new RelayHealth(RELAYS, () => t);
  return { h, advance: (ms: number) => (t += ms) };
}

const fail = (h: RelayHealth, url: string, n: number) => {
  for (let i = 0; i < n; i++) h.record(url, false);
};

test('a relay rests after FAIL_LIMIT failures in a row, not before', () => {
  const { h } = setup();
  fail(h, 'wss://b', FAIL_LIMIT - 1);
  assert.deepEqual(h.active(), RELAYS);
  h.record('wss://b', false);
  assert.deepEqual(h.active(), ['wss://a', 'wss://c', 'wss://d', 'wss://e']);
});

test('a success in between resets the count', () => {
  const { h } = setup();
  fail(h, 'wss://b', FAIL_LIMIT - 1);
  h.record('wss://b', true);
  fail(h, 'wss://b', FAIL_LIMIT - 1);
  assert.ok(!h.resting('wss://b'));
});

test('the rest ends, a failure on probation rests it again for twice as long', () => {
  const { h, advance } = setup();
  fail(h, 'wss://b', FAIL_LIMIT);
  advance(REST_BASE_MS - 1);
  assert.ok(h.resting('wss://b'));
  advance(1);
  assert.ok(!h.resting('wss://b'));
  h.record('wss://b', false); // one failure is enough now
  assert.ok(h.resting('wss://b'));
  advance(2 * REST_BASE_MS - 1);
  assert.ok(h.resting('wss://b'));
  advance(1);
  assert.ok(!h.resting('wss://b'));
});

test('rests are capped', () => {
  const { h, advance } = setup();
  for (let i = 0; i < 20; i++) {
    fail(h, 'wss://b', FAIL_LIMIT);
    advance(REST_MAX_MS);
  }
  fail(h, 'wss://b', 1);
  assert.equal(h.restingUntil('wss://b') - (1_000_000 + 20 * REST_MAX_MS), REST_MAX_MS);
});

test('a success after probation clears the record', () => {
  const { h, advance } = setup();
  fail(h, 'wss://b', FAIL_LIMIT);
  advance(REST_BASE_MS);
  h.record('wss://b', true);
  fail(h, 'wss://b', FAIL_LIMIT - 1);
  assert.ok(!h.resting('wss://b'));
  h.record('wss://b', false);
  assert.equal(h.restingUntil('wss://b') - REST_BASE_MS, 1_000_000 + REST_BASE_MS); // back to the base rest
});

test('at least MIN_ACTIVE relays stay in use: the ones back soonest', () => {
  const { h, advance } = setup();
  for (const [i, u] of ['wss://a', 'wss://b', 'wss://c', 'wss://d'].entries()) {
    fail(h, u, FAIL_LIMIT);
    advance(1000 * (4 - i)); // each rests from a later time: a comes back first, d last
  }
  const active = h.active();
  assert.equal(active.length, MIN_ACTIVE);
  assert.deepEqual(active, ['wss://a', 'wss://b', 'wss://e']); // configured order kept
});

test('state round-trips through load(); junk is ignored', () => {
  const { h } = setup();
  fail(h, 'wss://b', FAIL_LIMIT);
  const saved = JSON.parse(JSON.stringify(h.snapshot()));
  const { h: h2 } = setup();
  h2.load({ ...saved, 'wss://unknown': saved['wss://b'], 'wss://c': { fails: 'x' } });
  assert.ok(h2.resting('wss://b'));
  assert.deepEqual(Object.keys(h2.snapshot()), ['wss://b']);
});

test('listeners hear changes, not no-op successes', () => {
  const { h } = setup();
  let n = 0;
  h.onChange(() => n++);
  h.record('wss://a', true);
  assert.equal(n, 0);
  h.record('wss://a', false);
  h.record('wss://a', true);
  assert.equal(n, 2);
});
