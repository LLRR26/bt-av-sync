// node test/find-chirp.test.js — chirp detection must find a buried, quieter,
// polarity-flipped chirp at the exact sample, and must score plain noise low.
const assert = require('assert');
const { makeChirp, findChirp, median } = require('../measure.js');

const rate = 48000;
const chirp = makeChirp(rate);
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.4;

const rec = new Float32Array(rate * 2).map(noise);
const at = 1000 + 11117; // search starts at 1000; true lag 11117 samples ≈ 231.6 ms
chirp.forEach((v, i) => (rec[at + i] += -0.3 * v));

const hit = findChirp(rec, chirp, 1000, Math.round(1.2 * rate));
assert.strictEqual(hit.lag, 11117);
assert(hit.score > 0.3, `score ${hit.score}`);

const quiet = findChirp(new Float32Array(rate * 2).map(noise), chirp, 1000, Math.round(1.2 * rate));
assert(quiet.score < 0.1, `noise scored ${quiet.score}`);

assert.strictEqual(median([5, 1, 3]), 3);
assert.strictEqual(median([4, 1, 3, 2]), 2.5);
console.log('ok', hit, 'noise', quiet.score.toFixed(3));
