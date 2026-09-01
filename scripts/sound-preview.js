// Development-only. Renders the shipped sound recipes to a WAV so they can be
// auditioned without a browser, in the same spirit as the terrain and frame
// previews: there is no audio in this toolchain either, and tuning an effect
// by argument rather than by ear is how the beam ended up sounding like a
// blown speaker.
//
// The recipes are read out of `game.js` rather than copied, so this can never
// preview something the game does not actually play. Only the synthesis is
// reimplemented, because Web Audio is the one part Node has no answer for.
import { readFileSync, writeFileSync } from 'node:fs';

const RATE = 44100;
const source = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');

/** Pull one `const NAME = <literal>;` out of the game and evaluate it. */
function constant(name) {
  const match = source.match(new RegExp(`\\nconst ${name} = ([\\s\\S]*?);\\n`));
  if (!match) throw Error(`game.js has no const ${name}`);
  return Function(`return (${match[1]})`)();
}

const WAVES = constant('WAVES');
const SOUNDS = constant('SOUNDS');
const BEAM = constant('BEAM');
const BEAM_LEVEL = constant('BEAM_LEVEL');
const BEAM_CUTOFF = constant('BEAM_CUTOFF');
const BEAM_SWEEP = constant('BEAM_SWEEP');
const BEAM_RATE = constant('BEAM_RATE');
const NOISE_Q = constant('NOISE_Q');

// Seeded, so two renders of the same recipe are comparable sample for sample
// and a measured difference is always a change to the recipe.
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/**
 * The shared amplitude envelope: a linear rise over the attack, then an
 * exponential fall to silence across the rest of the note. Web Audio's ramps
 * run from wherever the last one ended, so the decay starts at the peak
 * rather than at the beginning.
 */
function envelope(index, samples, volume, attack) {
  const rise = Math.max(1, Math.round(attack * RATE));
  if (index < rise) return volume * (index / rise);
  const amount = (index - rise) / (samples - rise);
  return volume * (0.001 / volume) ** amount;
}

/** One cycle of each oscillator shape, as Web Audio defines them. */
function wave(shape, phase) {
  const turn = phase % 1;
  if (shape === 'sine') return Math.sin(turn * Math.PI * 2);
  if (shape === 'square') return turn < 0.5 ? 1 : -1;
  if (shape === 'sawtooth') return turn * 2 - 1;
  return 1 - Math.abs(turn * 4 - 2);
}

/**
 * Mix one oscillator into a buffer with the same envelope `playNote` uses: a
 * near-instant attack, then an exponential decay to silence, with an optional
 * exponential glide in pitch across the note.
 */
function note(buffer, frequency, start, duration, volume, shape, end, attack) {
  let phase = 0;
  const from = Math.round(start * RATE);
  const samples = Math.round(duration * RATE);
  for (let index = 0; index < samples; index++) {
    const amount = index / samples;
    phase += (frequency * (end / frequency) ** amount) / RATE;
    buffer[from + index] += wave(shape, phase) * envelope(index, samples, volume, attack);
  }
}

/**
 * A resonant filter, recomputed per sample so its frequency can be swept.
 * Low-pass by default, band-pass when `band` is set — the same two shapes
 * Web Audio gives the beam and the noise voices respectively.
 */
function biquad(buffer, from, samples, frequencyAt, q, band) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let index = 0; index < samples; index++) {
    const w0 = 2 * Math.PI * Math.max(20, frequencyAt(index)) / RATE;
    const alpha = Math.sin(w0) / (2 * q);
    const cosine = Math.cos(w0);
    const a0 = 1 + alpha;
    const b0 = band ? alpha / a0 : (1 - cosine) / 2 / a0;
    const b1 = band ? 0 : 2 * b0;
    const b2 = band ? -b0 : b0;
    const x0 = buffer[from + index];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2
      - (-2 * cosine / a0) * y1 - ((1 - alpha) / a0) * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    buffer[from + index] = y0;
  }
}

/**
 * Wave 4: white noise through a band-pass that slides from one frequency to
 * the other. Filtered first and enveloped second, in that order, because that
 * is the order the graph in the game puts them in.
 */
function noiseNote(buffer, frequency, start, duration, volume, end, attack) {
  const from = Math.round(start * RATE);
  const samples = Math.round(duration * RATE);
  const voice = new Float64Array(samples);
  for (let index = 0; index < samples; index++) voice[index] = random() * 2 - 1;
  biquad(voice, 0, samples, index =>
    frequency * (end / frequency) ** (index / samples), NOISE_Q, true);
  for (let index = 0; index < samples; index++) {
    buffer[from + index] += voice[index] * envelope(index, samples, volume, attack);
  }
}

/** Render one struck effect from the SOUNDS table. */
function renderSound(buffer, name, at) {
  for (const [frequency, offset, duration, volume, end = frequency, shape = 0, attack = 0.004] of SOUNDS[name]) {
    if (shape > 3) noiseNote(buffer, frequency, at + offset, duration, volume, end, attack);
    else note(buffer, frequency, at + offset, duration, volume, WAVES[shape], end, attack);
  }
}

/** Render the held beam, filter sweep and all, for `seconds`. */
function renderBeam(buffer, at, seconds) {
  const from = Math.round(at * RATE);
  const samples = Math.round(seconds * RATE);
  for (const [frequency, shape] of BEAM) {
    let phase = 0;
    for (let index = 0; index < samples; index++) {
      phase += frequency / RATE;
      // Matches the engine's own fade in and release either end of the hold.
      const fade = Math.min(1, index / (RATE * 0.05), (samples - index) / (RATE * 0.09));
      buffer[from + index] += wave(WAVES[shape], phase) * BEAM_LEVEL * fade;
    }
  }
  biquad(buffer, from, samples, index =>
    BEAM_CUTOFF + Math.sin(index / RATE * BEAM_RATE * Math.PI * 2) * BEAM_SWEEP, 3);
}

function encodeWav(samples) {
  const header = Buffer.alloc(44);
  const body = Buffer.alloc(samples.length * 2);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  // Normalised only if it would otherwise clip, so relative loudness between
  // effects is preserved and a sound that is too quiet still sounds too quiet.
  const scale = peak > 1 ? 1 / peak : 1;
  samples.forEach((sample, index) => body.writeInt16LE(Math.round(sample * scale * 32767), index * 2));
  return Buffer.concat([header, body]);
}

const [, , outPath = 'dist/sounds.wav', only] = process.argv;
// `hold` is not in the table — it is the sustained beam, previewed on its own.
const wantsBeam = !only || only === 'hold';
const names = !only ? Object.keys(SOUNDS) : only === 'hold' ? [] : [only];
// One second per struck effect leaves room for the longest of them to ring
// out, and a gap long enough to tell where one ends and the next begins.
const length = Math.ceil((names.length * 1 + (wantsBeam ? 3 : 0) + 1) * RATE);
const buffer = new Float64Array(length);
let at = 0.2;
const played = [];
for (const name of names) {
  renderSound(buffer, name, at);
  played.push(`${name} @${at.toFixed(1)}s`);
  at += 1;
}
if (wantsBeam) {
  // The ignition transient and the hold together, as the game plays them.
  renderSound(buffer, 'beam', at);
  renderBeam(buffer, at, 2.5);
  played.push(`beam+hold @${at.toFixed(1)}s`);
}
writeFileSync(outPath, encodeWav(buffer));
console.log(`${outPath}: ${played.join(', ')}`);
