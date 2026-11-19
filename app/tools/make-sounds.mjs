// Peermate's game sounds, synthesized here (original, no samples or third-party
// sounds): writes short mono 16-bit WAVs to assets/sounds/. Deterministic, so
// re-running gives the same files.
//
//   node tools/make-sounds.mjs
//
// move: a soft wooden "tock". capture: a firmer double knock. check: a tock
// with a light high ping. start / end: a short rising / settling two-note chime.
// lowtime: a quiet tick (the clock running low).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 44100
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../assets/sounds')

// Small seeded PRNG for the noise in the knocks (same output every run).
let seed = 0x2545f491
const rand = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return ((seed >>> 0) / 0xffffffff) * 2 - 1
}

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE))

/** A wooden knock: two damped partials plus a very short filtered noise click. */
function knock(buf, at, { freq = 520, decay = 38, gain = 0.8, click = 0.35 } = {}) {
  const start = Math.round(at * RATE)
  let lp = 0
  for (let i = 0; start + i < buf.length; i++) {
    const t = i / RATE
    if (t > 0.25) break
    const env = Math.exp(-decay * t) * Math.min(1, t * 2000) // 0.5 ms attack: no pop
    const body = Math.sin(2 * Math.PI * freq * t) * 0.7 + Math.sin(2 * Math.PI * freq * 2.37 * t) * 0.3 * Math.exp(-decay * 1.8 * t)
    lp += 0.35 * (rand() - lp) // one-pole low-pass: a duller click
    const noise = lp * click * Math.exp(-260 * t)
    buf[start + i] += gain * (body * env + noise)
  }
}

/** A soft bell-like tone (sine plus a quiet octave), for pings and chimes. */
function tone(buf, at, { freq, length = 0.35, decay = 9, gain = 0.3 } = {}) {
  const start = Math.round(at * RATE)
  for (let i = 0; i < length * RATE && start + i < buf.length; i++) {
    const t = i / RATE
    const env = Math.exp(-decay * t) * Math.min(1, t * 400)
    buf[start + i] += gain * env * (Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(2 * Math.PI * freq * 2 * t))
  }
}

function wav(buf, peak = 0.7) {
  // Normalize to the given peak, then fade the last 5 ms to silence.
  let max = 0
  for (const s of buf) max = Math.max(max, Math.abs(s))
  const k = max ? peak / max : 1
  const fade = Math.round(0.005 * RATE)
  const data = Buffer.alloc(buf.length * 2)
  for (let i = 0; i < buf.length; i++) {
    const f = Math.min(1, (buf.length - i) / fade)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i] * k * f)) * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

const sounds = {
  move: (() => {
    const b = buffer(0.16)
    knock(b, 0, { freq: 520, decay: 40 })
    return wav(b, 0.55)
  })(),
  capture: (() => {
    const b = buffer(0.2)
    knock(b, 0, { freq: 600, decay: 45, click: 0.6 })
    knock(b, 0.045, { freq: 470, decay: 40, gain: 0.9, click: 0.5 })
    return wav(b, 0.75)
  })(),
  check: (() => {
    const b = buffer(0.42)
    knock(b, 0, { freq: 540, decay: 40 })
    tone(b, 0.03, { freq: 1318.5, length: 0.38, decay: 8, gain: 0.35 }) // E6
    return wav(b, 0.7)
  })(),
  start: (() => {
    const b = buffer(0.6)
    tone(b, 0, { freq: 659.3, length: 0.3, decay: 10 }) // E5
    tone(b, 0.12, { freq: 987.8, length: 0.45, decay: 7 }) // B5
    return wav(b, 0.55)
  })(),
  end: (() => {
    const b = buffer(0.8)
    tone(b, 0, { freq: 987.8, length: 0.35, decay: 9 }) // B5
    tone(b, 0.16, { freq: 659.3, length: 0.6, decay: 5 }) // E5
    return wav(b, 0.55)
  })(),
  lowtime: (() => {
    const b = buffer(0.08)
    tone(b, 0, { freq: 1760, length: 0.06, decay: 60, gain: 0.5 })
    return wav(b, 0.35)
  })(),
}

mkdirSync(OUT, { recursive: true })
for (const [name, data] of Object.entries(sounds)) {
  writeFileSync(join(OUT, `${name}.wav`), data)
  console.log(`${name}.wav  ${(data.length / 1024).toFixed(1)} KB`)
}
