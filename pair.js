'use strict';
// Two-tab sync for Crunchyroll (where DRM blocks frame-delay) and YouTube.
// A pinned "sound" tab plays the video for audio while this muted "watch" tab
// plays the same video delayMs behind it. sw.js pairs the tabs, follows the
// next episode and relays messages; this script runs in both tabs and takes
// whichever role sw.js assigns.
// Loaded after content.js, whose `players`, `delayMs`, `readout` and `needMeasure` it uses.

// After an extension reload this old script is cut off and chrome.* throws synchronously.
const send = msg => {
  if (orphaned()) return Promise.resolve(null);
  try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); }
};
const toSound = msg => send({ type: 'to-sound', msg });
const clock = () => performance.timeOrigin + performance.now(); // comparable across tabs
const sleep = ms => new Promise(r => setTimeout(r, ms));
// YouTube marks its player while an ad plays; never true on Crunchyroll.
const adShowing = v => !!v.closest?.('.ad-showing');

// The main video: the biggest one in this frame (skips small previews).
function mainVideo() {
  let best = null, area = -1;
  for (const p of players) {
    const a = p.video.offsetWidth * p.video.offsetHeight;
    if (p.video.isConnected && a > area) { best = p; area = a; }
  }
  return best;
}

// Resolves true once `v` can play from where it's parked, false after `ms`.
function ready(v, ms = 15000) {
  return new Promise(resolve => {
    const check = () => { if (!v.seeking && v.readyState >= 3) done(true); };
    const done = ok => {
      clearTimeout(timer);
      v.removeEventListener('canplay', check);
      v.removeEventListener('seeked', check);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    v.addEventListener('canplay', check);
    v.addEventListener('seeked', check);
    check();
  });
}

// ---- Sound tab: the timing master. Plays only when told; its rate is never touched.
let sound = null;

function becomeSound(p) {
  if (sound?.v === p.video) return;
  const v = p.video;
  p.paired = true;
  sound = { v, allow: false };
  v.addEventListener('play', () => { if (sound?.v === v && !sound.allow) v.pause(); }); // no autoplay
  // Its own "up next" must not play: the watch tab decides what comes next.
  for (const ev of ['ended', 'emptied']) v.addEventListener(ev, () => { if (sound?.v === v) sound.allow = false; });
  v.addEventListener('error', () => send({ type: 'pair-fail', text: "Two-tab sync off: the sound tab couldn't play (another stream in use?)" }));
  if (!v.paused) v.pause();
}

async function soundCmd(msg) {
  const v = sound.v;
  switch (msg.type) {
    case 's-state':
      return { t: v.currentTime, at: clock(), rate: v.playbackRate, paused: v.paused, ended: v.ended, stalled: v.readyState < 3, ad: adShowing(v) };
    case 's-pause':
      sound.allow = false;
      v.pause();
      return true;
    case 's-prepare':
      if (adShowing(v)) { // the ad has to play out before the video can be parked
        sound.allow = true;
        v.play().catch(() => {});
        return 'ad';
      }
      sound.allow = false;
      v.pause();
      if (Math.abs(v.currentTime - msg.t) > 0.02) v.currentTime = msg.t;
      return ready(v);
    case 's-volume':
      v.volume = msg.volume;
      v.muted = msg.muted;
      return true;
    case 's-play':
      sound.allow = true;
      await v.play();
      return true;
  }
}

// ---- Watch tab: follows the sound tab delayMs behind by nudging its own rate.
let ctl = null;

function becomeWatch(p) {
  if (ctl?.video === p.video) return;
  ctl?.stop();
  ctl = makeController(p);
  ctl.start();
}

function makeController(p) {
  const v = p.video;
  const ac = new AbortController();
  const on = (ev, f) => v.addEventListener(ev, f, { signal: ac.signal });
  // `want` is what we're steering toward:
  //   waiting  - for the sound tab or a measurement; the picture stays paused
  //   starting - parking both tabs and starting them (startAt)
  //   playing / paused / ended - following the user
  //   ad       - a YouTube ad is playing in one tab; the other waits
  // Media events that disagree with `want` came from the user or the player, never from us.
  let want = 'waiting', gen = 0, ownSeek = null, loop = 0, busy = false, restarts = [];
  p.paired = true;

  // This tab is tab-muted, so its player volume/mute acts as the remote for the sound tab.
  const sendVolume = () => toSound({ type: 's-volume', volume: v.volume, muted: v.muted });
  on('volumechange', sendVolume);

  const fail = text => { c.stop(); send({ type: 'pair-fail', text }); };

  // Freeze both tabs, park both at x, start the sound, then start the picture
  // delayMs later, when that sound comes out of the speaker. `status` shows on
  // the video until both are playing in sync.
  async function startAt(x, status = 'syncing…') {
    if (adShowing(v)) return enterAd(false);
    const g = ++gen;
    want = 'starting';
    p.osd(`Two-tab sync: ${status}`, 30000);
    v.playbackRate = 1;
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - x) > 0.05) { ownSeek = x; v.currentTime = x; }
    const [sOk, wOk] = await Promise.all([toSound({ type: 's-prepare', t: x }), ready(v)]);
    if (g !== gen) return;
    if (sOk === 'ad') return enterAd(true);
    if (sOk !== true) return fail('Two-tab sync off: the sound tab stopped loading');
    if (!wOk) return fail('Two-tab sync off: this tab stopped loading');
    sendVolume();
    const r = await toSound({ type: 's-play' });
    if (g !== gen) return;
    if (r !== true) return fail('Two-tab sync off: Chrome blocked the sound tab from playing');
    await sleep(delayMs);
    if (g !== gen) return;
    want = 'playing';
    v.play().catch(() => {});
    p.osd(`Two-tab sync: in sync (${delayMs} ms)`, 1500);
  }

  // Pause both, measure with the mic, then start again from here
  // (or stay paused, if the user had paused).
  async function calibrate() {
    const stayPaused = want === 'paused' || want === 'ended';
    const g = ++gen;
    want = 'waiting';
    needMeasure = false; // sw.js clears the stored flag too; this stops tick() repeating it meanwhile
    v.playbackRate = 1;
    if (!v.paused) v.pause();
    await toSound({ type: 's-pause' });
    p.osd('Two-tab sync: measuring the delay… (about 5 s)', 30000);
    const ms = await send({ type: 'measure-now' });
    if (g !== gen) return;
    if (ms == null) await sleep(3000); // let the reason (shown by sw.js) be read; keeps the saved delay
    else delayMs = ms;
    if (g !== gen) return;
    if (stayPaused) want = 'paused'; // pressing play restarts both (the 'play' handler)
    else startAt(v.currentTime);
  }

  // One tab is playing an ad: let it play out, hold the other one.
  function enterAd(inSoundTab) {
    if (want === 'ad') return;
    ++gen;
    want = 'ad';
    v.playbackRate = 1;
    p.osd('Two-tab sync: waiting for the ad to finish…', 120000);
    if (inSoundTab) v.pause();
    else {
      toSound({ type: 's-pause' });
      v.play().catch(() => {});
    }
  }

  // Restarts the loop triggers itself; too many in 30 s means something fights us.
  function restart(why, status) {
    const now = Date.now();
    restarts = restarts.filter(t => now - t < 30000);
    restarts.push(now);
    if (restarts.length > 4) return fail(`Two-tab sync off: ${why}`);
    startAt(v.currentTime, status);
  }

  async function tick() {
    if (orphaned()) return c.stop();
    if ((want !== 'playing' && want !== 'ad') || busy) return;
    if (want === 'playing' && needMeasure) return calibrate(); // speaker changed
    busy = true;
    const s = await toSound({ type: 's-state' });
    busy = false;
    if (want !== 'playing' && want !== 'ad') return;
    if (!s || s.error) return fail('Two-tab sync off: lost the sound tab');
    const ad = s.ad || adShowing(v);
    if (want === 'ad') {
      if (!ad) return startAt(v.currentTime);
      // YouTube swaps the ad in with 'emptied', which can leave it paused; ads must play out.
      if (s.ad && s.paused) toSound({ type: 's-prepare', t: s.t });
      if (adShowing(v) && v.paused) v.play().catch(() => {});
      return;
    }
    if (ad) return enterAd(s.ad);
    if (s.ended) return; // sound finishes delayMs before the picture
    if (s.paused) return restart('the site keeps pausing the sound tab', 'resyncing…');
    if (s.stalled) return restart('the sound tab keeps buffering', 'sound loading…');
    const err = s.t + ((clock() - s.at) / 1000) * s.rate - delayMs / 1000 - v.currentTime; // > 0: picture behind
    if (Math.abs(err) > 1) return restart('the site keeps resetting the video speed', 'resyncing…');
    v.playbackRate = s.rate * (Math.abs(err) < 0.02 ? 1 : 1 + Math.max(-0.1, Math.min(0.1, err)));
    if (readout) p.osd(`err ${err >= 0 ? '+' : ''}${Math.round(err * 1000)} ms · rate ${v.playbackRate.toFixed(3)} · restarts ${restarts.length}`, 1000);
  }

  on('play', () => {
    if (want === 'waiting' || want === 'starting') v.pause();
    else if (want === 'paused' || want === 'ended') startAt(v.currentTime);
  });
  on('pause', () => {
    if (want !== 'playing' || v.ended) return;
    if (adShowing(v)) return enterAd(false);
    want = 'paused';
    toSound({ type: 's-pause' });
  });
  on('seeking', () => {
    if (ownSeek !== null && Math.abs(v.currentTime - ownSeek) < 0.05) return;
    if (adShowing(v)) return;
    // paused: resume re-parks both. waiting: the start that follows uses the new spot.
    if (want === 'playing' || want === 'starting') startAt(v.currentTime);
  });
  on('seeked', () => (ownSeek = null));
  on('waiting', () => {
    if (want !== 'playing') return;
    if (adShowing(v)) return enterAd(false);
    startAt(v.currentTime, 'video loading…');
  });
  on('ended', () => {
    if (want !== 'playing' || adShowing(v)) return;
    want = 'ended';
    toSound({ type: 's-pause' });
  });

  const c = {
    video: v,
    // Pairing started, or the episode changed (sw.js is loading it in the sound tab).
    async start() {
      if (!loop) loop = setInterval(tick, 250);
      const g = ++gen;
      want = 'waiting';
      v.playbackRate = 1;
      if (!v.paused) v.pause();
      p.osd('Two-tab sync: loading the sound tab…', 30000);
      const ok = await send({ type: 'pair-wait-sound' });
      if (g !== gen) return;
      if (!ok) return fail("Two-tab sync off: the sound tab didn't load");
      if (needMeasure) calibrate();
      else startAt(v.currentTime);
    },
    calibrate,
    stop() {
      if (ctl !== c) return;
      const resume = want === 'waiting' || want === 'starting' || want === 'playing';
      ++gen;
      want = null;
      clearInterval(loop);
      ac.abort();
      v.playbackRate = 1;
      p.paired = false;
      ctl = null;
      if (resume && v.paused) v.play().catch(() => {});
    },
  };
  return c;
}

// ---- Wiring
async function onPlayer(p) {
  const role = await send({ type: 'hello' });
  if (p !== mainVideo()) return;
  if (role === 'sound') becomeSound(p);
  else if (role === 'watch') becomeWatch(p);
}
players.forEach(onPlayer); // videos content.js found before this script loaded

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'pair-start' || msg.type === 'pair-episode') {
    const p = mainVideo();
    if (!p) return; // not this frame, or the video isn't there yet (its hello will start it)
    if (ctl?.video === p.video) ctl.start();
    else becomeWatch(p);
  } else if (msg.type === 'pair-end') {
    ctl?.stop();
  } else if (msg.type === 'pair-resync') {
    ctl?.calibrate();
  } else if (msg.type?.startsWith('s-') && sound?.v.isConnected) {
    soundCmd(msg).then(reply, e => reply({ error: e.message }));
    return true;
  }
});
