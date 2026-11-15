// node test/pair-sync.test.js — runs pair.js's sound + watch roles against fake
// videos (time advances with playbackRate) and checks the watch video settles
// delayMs behind the sound video through drift, a stall, a pause and a seek.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeVideo extends EventTarget {
  constructor(t) {
    super();
    this.base = t; this.t0 = 0; this.paused = true; this.rate = 1;
    this.rs = 4; this.seeking = false; this.ended = false;
    this.volume = 1; this.muted = false;
    this.isConnected = true; this.offsetWidth = 640; this.offsetHeight = 360;
  }
  fire(type) { setTimeout(() => this.dispatchEvent(new Event(type)), 0); } // media events are async
  get currentTime() { return this.paused ? this.base : this.base + ((Date.now() - this.t0) / 1000) * this.rate; }
  set currentTime(t) {
    this.base = t; this.t0 = Date.now(); this.seeking = true; this.fire('seeking');
    setTimeout(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); }, 20);
  }
  get readyState() { return this.rs; }
  set readyState(n) { const was = this.rs; this.rs = n; if (was < 3 && n >= 3) this.fire('canplay'); }
  get playbackRate() { return this.rate; }
  set playbackRate(r) { this.base = this.currentTime; this.t0 = Date.now(); this.rate = r; }
  closest(sel) { return sel === '.ad-showing' && this.ad ? this : null; }
  play() { if (this.paused) { this.t0 = Date.now(); this.paused = false; this.fire('play'); } return Promise.resolve(); }
  pause() { if (!this.paused) { this.base = this.currentTime; this.paused = true; this.fire('pause'); } }
  shift(dt) { this.base = this.currentTime + dt; this.t0 = Date.now(); } // drift without events
}

const soundV = new FakeVideo(10), watchV = new FakeVideo(10);
const log = [];
let tabListener, ended = null;
const ctx = vm.createContext({
  players: new Set(), delayMs: 300, readout: true, needMeasure: false, orphaned: () => false, performance, console, Date,
  setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Promise,
  chrome: { runtime: {
    onMessage: { addListener: f => (tabListener = f) },
    sendMessage: async msg => {
      log.push(msg.msg?.type ?? msg.type);
      if (msg.type === 'pair-wait-sound') return true;
      if (msg.type === 'measure-now') { await sleep(700); return 280; }
      if (msg.type === 'pair-fail') { ended = msg.text; return; }
      if (msg.type === 'to-sound') return new Promise(r => { if (!tabListener(msg.msg, {}, r)) r(undefined); });
      return null;
    },
  } },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../pair.js'), 'utf8'), ctx);
const osd = [];
const mk = v => ({ video: v, osd: t => osd.push(t) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lag = () => soundV.currentTime - watchV.currentTime;
const near = (what, want, tol = 0.03) => assert(Math.abs(lag() - want) < tol, `${what}: lag ${lag().toFixed(3)} s, want ${want}`);

(async () => {
  ctx.becomeSound(mk(soundV));
  ctx.becomeWatch(mk(watchV));
  await sleep(1500);
  assert(!soundV.paused && !watchV.paused, 'both playing');
  near('start', 0.3);
  assert.strictEqual(soundV.rate, 1, 'sound rate untouched');

  watchV.shift(0.15); // picture runs ahead
  await sleep(2500);
  near('drift corrected', 0.3);
  assert(Math.abs(watchV.rate - 1) < 0.03, `rate back near 1 (${watchV.rate})`);

  const preps = log.filter(t => t === 's-prepare').length;
  soundV.readyState = 2; // sound tab buffers
  await sleep(400);
  assert(watchV.paused, 'picture freezes while the sound buffers');
  soundV.readyState = 4;
  await sleep(1200);
  assert(log.filter(t => t === 's-prepare').length > preps, 'restarted');
  near('after stall', 0.3);

  watchV.pause(); // user pauses
  await sleep(100);
  assert(soundV.paused, 'pause copied to sound');
  watchV.play(); // user resumes
  await sleep(1200);
  near('after resume', 0.3);

  watchV.currentTime = 50; // user seeks
  await sleep(1500);
  assert(watchV.currentTime > 50 && watchV.currentTime < 52, `seek kept (${watchV.currentTime})`);
  near('after seek', 0.3);

  ctx.delayMs = 350; // Alt+] in pair mode
  await sleep(3000);
  near('delay change', 0.35);

  ctx.needMeasure = true; // speaker changed: pause, measure (fake 280 ms), restart
  await sleep(400);
  assert(watchV.paused && soundV.paused, 'both paused while measuring');
  await sleep(2500);
  assert.strictEqual(ctx.delayMs, 280);
  near('after measuring', 0.28);

  soundV.ad = true; // YouTube ad starts in the sound tab: source swap, then the player re-plays it
  soundV.dispatchEvent(new Event('emptied'));
  soundV.pause();
  soundV.play();
  await sleep(800);
  assert(watchV.paused && !soundV.paused, 'picture holds while the sound tab plays its ad');
  soundV.ad = false;
  await sleep(1500);
  near('after ad', 0.28);

  watchV.pause(); // Alt+S while paused: measures, stays paused
  await sleep(100);
  tabListener({ type: 'pair-resync' }, {}, () => {});
  await sleep(1000);
  assert(watchV.paused && soundV.paused, 'still paused after measuring');
  watchV.play();
  await sleep(1200);
  near('play after paused measure', 0.28);

  watchV.volume = 0.4; // watch tab's volume/mute is the remote for the sound tab
  watchV.dispatchEvent(new Event('volumechange'));
  await sleep(50);
  assert.strictEqual(soundV.volume, 0.4, 'volume copied to sound');
  watchV.muted = true;
  watchV.dispatchEvent(new Event('volumechange'));
  await sleep(50);
  assert.strictEqual(soundV.muted, true, 'mute copied to sound');
  watchV.muted = false;
  watchV.dispatchEvent(new Event('volumechange'));
  await sleep(50);
  assert.strictEqual(soundV.muted, false, 'unmute copied to sound');
  soundV.volume = 1; // the site resets it; the next restart puts it back
  watchV.currentTime = 60;
  await sleep(1500);
  assert.strictEqual(soundV.volume, 0.4, 'volume re-applied on restart');

  assert.strictEqual(ended, null, `no failure (${ended})`);
  console.log('ok', 'lag', lag().toFixed(3), 'last readout:', osd[osd.length - 1]);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
