'use strict';
// Delays the picture of every <video> on the page by `delayMs` so it lines up
// with late Bluetooth audio. Each decoded frame is copied into a pooled canvas,
// then shown on a canvas laid over the real video once its delay has passed.

const MAX_DELAY = 1500;
const STEP = 10;
const MAX_FRAMES = 120; // 1.5 s at 80 fps; past this the oldest frame is dropped

let delayMs = 200;
let enabled = true;
let readout = false; // two-tab sync numbers on the video (pair.js), Alt+R
let needMeasure = false; // set by sw.js when the speaker changes; measured once a video plays
const players = new Set();

chrome.storage.local.get({ delayMs, enabled, readout, needMeasure }, s => {
  delayMs = s.delayMs;
  enabled = s.enabled;
  readout = s.readout;
  needMeasure = s.needMeasure;
});
chrome.storage.onChanged.addListener(c => {
  if (c.delayMs) delayMs = c.delayMs.newValue;
  if (c.enabled) enabled = c.enabled.newValue;
  if (c.readout) readout = c.readout.newValue;
  if (c.needMeasure) {
    needMeasure = c.needMeasure.newValue;
    maybeMeasure();
  }
  if (c.delayMs || c.enabled) players.forEach(p => p.osd(enabled ? `AV sync: ${delayMs} ms` : 'AV sync: off'));
  if (c.notice?.newValue) players.forEach(p => p.osd(c.notice.newValue.text, 4000)); // status from sw.js
});

// Alt+[ / Alt+] nudge the delay, Alt+\ toggles, Alt+S re-measures with the mic,
// Alt+T toggles two-tab sync (pair.js: Crunchyroll, YouTube), Alt+R its readout.
// Stored so every frame/tab follows.
window.addEventListener('keydown', function onKey(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (orphaned()) return window.removeEventListener('keydown', onKey, true);
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const next = Math.min(MAX_DELAY, Math.max(0, delayMs + (e.code === 'BracketRight' ? STEP : -STEP)));
    chrome.storage.local.set({ delayMs: next });
  } else if (e.code === 'Backslash') {
    chrome.storage.local.set({ enabled: !enabled });
  } else if (e.code === 'KeyS') {
    chrome.runtime.sendMessage({ type: 'resync' }).catch(() => {});
  } else if (e.code === 'KeyT') {
    chrome.runtime.sendMessage({ type: 'pair-toggle' }).catch(() => {});
  } else if (e.code === 'KeyR') {
    chrome.storage.local.set({ readout: !readout });
  } else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// A video with frame-delay is playing and the speaker changed: measure now.
// sw.js pauses this tab's videos around the chirps ('hold'/'release').
function maybeMeasure() {
  if (!needMeasure || ![...players].some(p => p.activePlaying())) return;
  needMeasure = false; // sw.js clears the stored flag too; this stops repeats meanwhile
  chrome.runtime.sendMessage({ type: 'resync' }).catch(() => {});
}

let held = [];
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'hold') {
    held = [...players].map(p => p.video).filter(v => !v.paused);
    held.forEach(v => v.pause());
  } else if (msg.type === 'release') {
    held.forEach(v => v.play().catch(() => {}));
    held = [];
  }
});

// After the extension is reloaded or updated, scripts already in open tabs are
// cut off and every chrome.* call throws. They step aside (normal playback)
// until the tab is reloaded and gets the new script.
const orphaned = () => !chrome.runtime?.id;

const attached = new WeakSet();

function attach(video) {
  if (attached.has(video) || orphaned()) return;
  attached.add(video);

  // The overlay lives inside the player next to the video, so it follows
  // resizes, theater mode and fullscreen-of-the-player without tracking.
  const view = document.createElement('canvas');
  view.style.cssText = 'position:absolute;pointer-events:none;background:#000;display:none;margin:0;padding:0;border:0;';
  const ctx = view.getContext('2d');
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483647;padding:4px 8px;border-radius:4px;' +
    'background:rgba(0,0,0,.7);color:#fff;font:600 13px/1.2 system-ui,sans-serif;display:none;';
  let labelTimer = 0;

  const pool = [];  // free OffscreenCanvases
  const queue = []; // { c, t } oldest first; t = when the live frame would have shown
  let shown = false;
  let showNext = true; // after a seek/start, show the first new frame at once (frozen until audio catches up)
  let drmWarned = false;
  let dead = false;

  // DRM videos are skipped: Chrome hands extensions black frames for them (tested on Crunchyroll).
  // Two-tab sync (player.paired) does its own delaying.
  // No readyState check: it dips during seeks, and hiding the overlay then
  // would flash the undelayed video. capture() guards against empty frames.
  const active = () => enabled && !player.paired && !video.mediaKeys && !video.muted && video.volume > 0;

  function flush() {
    while (queue.length) pool.push(queue.shift().c);
    showNext = true;
  }

  function draw(c) {
    if (view.width !== c.width || view.height !== c.height) {
      view.width = c.width;
      view.height = c.height;
    }
    ctx.drawImage(c, 0, 0);
    if (!shown) {
      view.style.display = 'block';
      shown = true;
    }
  }

  function capture(now, meta) {
    if (dead) return;
    video.requestVideoFrameCallback(capture);
    if (!active() || !video.clientWidth || !video.videoWidth) return;

    // Store frames at display resolution, not source resolution, to keep memory down.
    const scale = Math.min(1, (video.clientWidth * devicePixelRatio) / video.videoWidth);
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));

    let c = pool.pop();
    if (!c) c = queue.length >= MAX_FRAMES ? queue.shift().c : new OffscreenCanvas(w, h);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    try {
      c.getContext('2d').drawImage(video, 0, 0, w, h);
    } catch {
      pool.push(c);
      return;
    }
    queue.push({ c, t: meta.expectedDisplayTime });
    if (showNext) {
      showNext = false;
      draw(c);
    }
  }

  function syncBox() {
    if (view.parentNode !== video.parentNode) video.after(view, label);
    const cs = getComputedStyle(video);
    const s = view.style;
    s.left = video.offsetLeft + 'px';
    s.top = video.offsetTop + 'px';
    s.width = video.offsetWidth + 'px';
    s.height = video.offsetHeight + 'px';
    s.objectFit = cs.objectFit;
    s.zIndex = cs.zIndex;
    label.style.left = video.offsetLeft + 12 + 'px';
    label.style.top = video.offsetTop + 12 + 'px';
  }

  function render(now) {
    if (!video.isConnected || orphaned()) return teardown();
    requestAnimationFrame(render);

    if (!active()) {
      if (shown) {
        view.style.display = 'none';
        shown = false;
      }
      flush();
      return;
    }
    syncBox();

    // Show the newest frame whose delay has passed; recycle anything older.
    let pick = null;
    while (queue.length && queue[0].t + delayMs <= now) {
      if (pick) pool.push(pick.c);
      pick = queue.shift();
    }
    if (pick) {
      draw(pick.c);
      pool.push(pick.c);
    }
  }

  function teardown() {
    dead = true;
    view.remove();
    label.remove();
    queue.length = pool.length = 0;
    attached.delete(video);
    players.delete(player);
  }

  const player = {
    video,
    paired: false,
    activePlaying: () => active() && !video.paused,
    osd(text, ms = 1500) {
      if (!video.isConnected || !video.offsetWidth) return;
      syncBox();
      label.textContent = text;
      label.style.display = 'block';
      clearTimeout(labelTimer);
      labelTimer = setTimeout(() => (label.style.display = 'none'), ms);
    },
  };
  players.add(player);
  if (typeof onPlayer === 'function') onPlayer(player); // pair.js, Crunchyroll and YouTube only

  // Frames from before a jump must never play after it.
  for (const ev of ['seeking', 'emptied', 'loadstart']) video.addEventListener(ev, flush);
  video.addEventListener('playing', () => {
    maybeMeasure();
    if (video.mediaKeys && enabled && !drmWarned) {
      drmWarned = true;
      player.osd(location.hostname.endsWith('crunchyroll.com')
        ? "AV sync: DRM video, can't delay. Alt+T for two-tab sync" : "AV sync: DRM video, can't delay");
    }
  });

  video.requestVideoFrameCallback(capture);
  requestAnimationFrame(render);
}

const scan = root => root.querySelectorAll('video').forEach(attach);
new MutationObserver(muts => {
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeName === 'VIDEO') attach(n);
      else if (n.nodeType === 1 && n.firstElementChild) scan(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
scan(document);
