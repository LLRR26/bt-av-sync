'use strict';
// Mic measurement: play chirps, find them in the mic recording, and return how
// much later the sound arrives than Chrome assumes (= the video delay needed).

const CHIRP_SPACING = 1.3; // s between chirps
const SEARCH = 1.2;        // s after each chirp to look for it (max measurable lag)
const MIN_SCORE = 0.1;     // normalized correlation; room noise scores ~0.02

function makeChirp(rate, dur = 0.1, f0 = 1000, f1 = 6000) {
  const n = Math.round(rate * dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * dur));
    out[i] = 0.8 * Math.sin(phase) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return out;
}

// Best match of `chirp` in rec[from .. from+maxLag]. Coarse pass every 4 samples,
// then exact around the best. abs() because speakers may flip polarity.
function findChirp(rec, chirp, from, maxLag) {
  const n = chirp.length;
  let cn = 0;
  for (const v of chirp) cn += v * v;
  const last = Math.min(maxLag, rec.length - from - n);
  const score = lag => {
    let s = 0, e = 0;
    for (let i = 0; i < n; i++) {
      const x = rec[from + lag + i];
      s += x * chirp[i];
      e += x * x;
    }
    return e > 0 ? Math.abs(s) / Math.sqrt(e * cn) : 0;
  };
  let best = -1, bestLag = 0;
  for (let lag = 0; lag <= last; lag += 4) {
    const v = score(lag);
    if (v > best) { best = v; bestLag = lag; }
  }
  const lo = Math.max(0, bestLag - 8), hi = Math.min(last, bestLag + 8);
  for (let lag = lo; lag <= hi; lag++) {
    const v = score(lag);
    if (v > best) { best = v; bestLag = lag; }
  }
  return { lag: bestLag, score: best };
}

const median = a => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Returns { ms, results } where ms is the raw lag Chrome doesn't know about
// (before the user's mic offset). Throws with a readable message on failure.
async function measureLatency(count = 3) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule('recorder-worklet.js');
    const rate = ctx.sampleRate;
    const chirp = makeChirp(rate);
    const blocks = [];
    const rec = new AudioWorkletNode(ctx, 'recorder', { numberOfOutputs: 0 });
    rec.port.onmessage = e => blocks.push(e.data);
    ctx.createMediaStreamSource(stream).connect(rec);
    // Pages without a click (the offscreen one) may be refused audio; don't hang on it.
    await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1000))]);
    if (ctx.state !== 'running') throw new Error("Chrome wouldn't start audio for the measurement.");

    const buf = ctx.createBuffer(1, chirp.length, rate);
    buf.copyToChannel(chirp, 0);
    const c0 = ctx.currentTime + 0.5; // let the mic settle first
    const starts = [];
    for (let k = 0; k < count; k++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(c0 + k * CHIRP_SPACING);
      starts.push(c0 + k * CHIRP_SPACING);
    }
    const end = starts[count - 1] + SEARCH + chirp.length / rate + 0.1;
    while (ctx.currentTime < end) await new Promise(r => setTimeout(r, 50));

    if (!blocks.length) throw new Error('No sound from the microphone.');
    const t0 = blocks[0].t;
    const span = Math.round((blocks[blocks.length - 1].t - t0) * rate) + 128;
    if (span !== blocks.length * 128) throw new Error('Audio dropped out during the test. Try again.');
    const samples = new Float32Array(span);
    blocks.forEach((b, i) => samples.set(b.data, i * 128));

    // Lag Chrome already accounts for: what it reports for the output, and the mic's own delay.
    const known = ctx.outputLatency * 1000 + (stream.getAudioTracks()[0].getSettings().latency ?? 0) * 1000;
    const results = starts.map(c => {
      const { lag, score } = findChirp(samples, chirp, Math.round((c - t0) * rate), Math.round(SEARCH * rate));
      return { ms: (lag / rate) * 1000 - known, score };
    });
    const good = results.filter(r => r.score >= MIN_SCORE).map(r => r.ms);
    if (good.length < Math.min(2, count)) throw new Error("Couldn't hear the chirps. Turn the volume up, or pause the video and try again.");
    if (Math.max(...good) - Math.min(...good) > 40) throw new Error('Results disagreed. Pause the video and try again.');
    return { ms: median(good), results };
  } finally {
    stream.getTracks().forEach(t => t.stop());
    ctx.close();
  }
}

if (typeof module !== 'undefined') module.exports = { makeChirp, findChirp, median };
