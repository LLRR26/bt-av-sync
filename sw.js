'use strict';
// Owns storage: one delay per speaker, mic re-sync results, and the Crunchyroll
// tab pair. The offscreen page does the audio work (service workers can't touch
// devices or the mic).

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Detect the audio output and measure its delay with the mic',
  }).catch(() => {}); // already being created by a parallel wake-up
}
ensureOffscreen();

// Shown on every playing video by content.js. `at` makes repeats count as changes.
const notify = text => chrome.storage.local.set({ notice: { text, at: Date.now() } });
const get = () => chrome.storage.local.get({ speaker: '', speakers: {}, delayMs: 200, micOffsetMs: 0 });

// Each handler's return value (or promise) is sent back as the reply.
const handlers = {
  speaker: msg => onSpeaker(msg.name),
  resync: (msg, sender) => resync(sender.tab?.id),
  'measure-now': () => measureAndSave(),
  hello: (msg, sender) => hello(sender),
  'pair-toggle': (msg, sender) => togglePair(sender.tab),
  'pair-wait-sound': (msg, sender) => waitSound(sender),
  'pair-fail': msg => endPair(msg.text),
  'to-sound': async msg => {
    const p = await getPair();
    return p ? chrome.tabs.sendMessage(p.sound, msg.msg).catch(() => null) : null;
  },
};
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve(h(msg, sender)).then(reply, () => reply(null));
  return true;
});

// Speaker changed (new, or reconnected): load its saved delay and flag a
// measurement, which content.js / pair.js run once a video is playing.
async function onSpeaker(name) {
  const { speaker, speakers, delayMs } = await get();
  if (name === speaker) return;
  await chrome.storage.local.set({ speaker: name, delayMs: speakers[name] ?? delayMs, needMeasure: true });
  notify(`Speaker: ${name}. Measuring the delay when a video plays.`);
}

// Alt+S, or an automatic measurement. Two-tab tabs pause and resume themselves
// (pair.js); any other tab has its videos paused around the chirps.
async function resync(tabId) {
  const p = await getPair();
  if (p && (tabId === p.watch || tabId === p.sound)) {
    chrome.tabs.sendMessage(p.watch, { type: 'pair-resync' }).catch(() => {});
    return;
  }
  if (tabId != null) await chrome.tabs.sendMessage(tabId, { type: 'hold' }).catch(() => {});
  await measureAndSave();
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'release' }).catch(() => {});
}

// Returns the new delay, or null (with the reason shown on screen). Calls made
// while a measurement runs share it instead of starting a second one.
let measuring = null;
const measureAndSave = () => (measuring ??= doMeasure().finally(() => (measuring = null)));

async function doMeasure() {
  await chrome.storage.local.set({ needMeasure: false }); // one attempt per speaker change; Alt+S retries
  await ensureOffscreen();
  notify('AV sync: measuring… (about 5 s)');
  const r = await chrome.runtime.sendMessage({ type: 'measure' }).catch(e => ({ error: e.message }));
  if (!r || r.error) {
    notify(`AV sync: ${r?.error ?? 'measurement failed'}`);
    return null;
  }
  const { speaker, speakers, micOffsetMs } = await get();
  const ms = Math.min(1500, Math.max(0, Math.round(r.ms - micOffsetMs)));
  if (speaker) speakers[speaker] = ms; // saved even if unchanged, so the new-speaker prompt stops
  await chrome.storage.local.set({ delayMs: ms, speakers });
  notify(`AV sync: ${ms} ms (measured)`);
  return ms;
}

// Any delay change (hotkey, popup, calibration) is remembered for the current speaker.
chrome.storage.onChanged.addListener(async c => {
  if (!c.delayMs) return;
  const { speaker, speakers } = await get();
  if (!speaker || speakers[speaker] === c.delayMs.newValue) return;
  speakers[speaker] = c.delayMs.newValue;
  chrome.storage.local.set({ speakers });
});

// ---- Two-tab sync for Crunchyroll and YouTube (see pair.js). One pair at a time.
// pair = { watch, sound: tab ids, ep: episode being watched, soundEp: episode the sound tab has loaded, shown }
const getPair = async () => (await chrome.storage.session.get('pair')).pair ?? null;
// Every change to the pair goes through one queue, so concurrent handlers
// (hello, onUpdated) can't overwrite each other's fields. fn edits p in place.
let pairQueue = Promise.resolve();
const updatePair = fn => (pairQueue = pairQueue.then(async () => {
  const p = await getPair();
  if (!p) return null;
  fn(p);
  await chrome.storage.session.set({ pair: p });
  return p;
}).catch(() => null));
// Which episode/video a URL plays, or null if it isn't one two-tab sync supports.
function epId(url) {
  const cr = url?.match(/^https:\/\/www\.crunchyroll\.com\/(?:[a-z-]+\/)?watch\/([^/?#]+)/i);
  if (cr) return `cr:${cr[1]}`;
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (u.hostname === 'www.youtube.com' && u.pathname === '/watch' && v) return `yt:${v}`;
  } catch {}
  return null;
}
const SOUND_TIMEOUT = 25000; // sound tab never shows a video: e.g. Crunchyroll refused the stream
let waiters = []; // watch tabs waiting for the sound tab's video

async function togglePair(tab) {
  const p = await getPair();
  if (p) {
    const mine = p.watch === tab.id || p.sound === tab.id;
    await endPair(mine ? 'Two-tab sync off' : null);
    if (mine) return;
  }
  const ep = epId(tab.url);
  if (!ep) return notify('Two-tab sync works on Crunchyroll episodes and YouTube videos');
  // Opened in front: Chrome won't start media in a tab that has never been shown.
  // onUpdated switches back to the watch tab once it has loaded.
  const s = await chrome.tabs.create({ url: tab.url, windowId: tab.windowId, index: 0, pinned: true, active: true });
  await (pairQueue = pairQueue.then(() => chrome.storage.session.set({ pair: { watch: tab.id, sound: s.id, ep, soundEp: null, shown: false } })));
  await chrome.tabs.update(tab.id, { muted: true });
  chrome.tabs.sendMessage(tab.id, { type: 'pair-start' }).catch(() => {});
}

async function endPair(text) {
  const p = await getPair();
  if (!p) return;
  await (pairQueue = pairQueue.then(() => chrome.storage.session.remove('pair')));
  waiters.splice(0).forEach(w => w(false));
  chrome.tabs.remove(p.sound).catch(() => {});
  chrome.tabs.update(p.watch, { muted: false }).catch(() => {});
  chrome.tabs.sendMessage(p.watch, { type: 'pair-end' }).catch(() => {});
  if (text) notify(text);
}

// A Crunchyroll video appeared; tell it which role its tab plays.
async function hello(sender) {
  const p = await getPair();
  if (!p) return null;
  if (sender.tab.id === p.watch) return 'watch';
  if (sender.tab.id !== p.sound) return null;
  const q = await updatePair(x => (x.soundEp = epId(sender.tab.url)));
  if (q && q.soundEp === q.ep) waiters.splice(0).forEach(w => w(true));
  return 'sound';
}

async function waitSound(sender) {
  const p = await getPair();
  if (!p || p.watch !== sender.tab?.id) return false;
  if (p.soundEp === p.ep) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => endPair("Two-tab sync off: the sound tab didn't load (another stream in use?)"), SOUND_TIMEOUT);
    waiters.push(ok => { clearTimeout(timer); resolve(ok); });
  });
}

chrome.tabs.onUpdated.addListener(async (id, info) => {
  if (!info.url && info.status !== 'complete') return;
  const p = await getPair();
  if (!p) return;
  if (id === p.sound && info.status === 'complete' && !p.shown) {
    await updatePair(x => (x.shown = true));
    chrome.tabs.update(p.watch, { active: true }).catch(() => {});
  }
  // Next episode/video in the watch tab: load it in the sound tab too.
  if (id === p.watch && info.url) {
    const ep = epId(info.url);
    if (!ep) return endPair('Two-tab sync off (left the video)');
    if (ep === p.ep) return;
    await updatePair(x => { x.ep = ep; x.soundEp = null; });
    chrome.tabs.update(p.sound, { url: info.url }).catch(() => {});
    chrome.tabs.sendMessage(p.watch, { type: 'pair-episode' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async id => {
  const p = await getPair();
  if (p && (id === p.watch || id === p.sound)) endPair(id === p.sound ? 'Two-tab sync off (sound tab closed)' : null);
});
