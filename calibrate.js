'use strict';
const $ = id => document.getElementById(id);
const clamp = v => Math.min(1500, Math.max(0, Math.round(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULTS = { speaker: '', delayMs: 200, micOffsetMs: 0 };
let state = { ...DEFAULTS };

function refresh() {
  chrome.storage.local.get(DEFAULTS, s => {
    state = s;
    $('now').textContent = `Speaker: ${s.speaker || 'unknown (allow mic below)'} · Current delay: ${s.delayMs} ms`;
    if (document.activeElement !== $('offset')) $('offset').value = s.micOffsetMs;
  });
}
chrome.storage.onChanged.addListener(refresh);
refresh();

const useDelay = ms => chrome.storage.local.set({ delayMs: clamp(ms) });

// 1. Mic access
$('grant').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // only needed the permission
    $('grantOut').textContent = 'Microphone allowed.';
    chrome.runtime.sendMessage({ type: 'recheck' }).catch(() => {});
  } catch (e) {
    $('grantOut').textContent = `Mic access was blocked (${e.name}). Allow it from the icon in the address bar, then click again.`;
  }
};

// 2. Tap test: tap along with beeps; each tap is compared to when Chrome thinks
// that beep is heard. The gap is exactly the lag Chrome doesn't know about.
let tapResult = null;
$('tapStart').onclick = async () => {
  const PERIOD = 1, COUNT = 12, WARMUP = 3; // first beeps are for catching the rhythm
  $('tapStart').disabled = true;
  $('tapUse').hidden = true;
  $('tapOut').textContent = 'Listen, then tap along…';
  document.activeElement.blur(); // so Space doesn't press the button again

  const ctx = new AudioContext();
  await ctx.resume();
  const start = ctx.currentTime + 1;
  const beeps = [];
  for (let k = 0; k < COUNT; k++) {
    const t = start + k * PERIOD;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = 1000;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + 0.06);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
    beeps.push(t);
  }

  const offsets = [];
  const tap = timeStamp => {
    const ts = ctx.getOutputTimestamp();
    const heard = c => ts.performanceTime + (c - ts.contextTime) * 1000;
    let k = 0;
    beeps.forEach((c, i) => { if (Math.abs(timeStamp - heard(c)) < Math.abs(timeStamp - heard(beeps[k]))) k = i; });
    if (k >= WARMUP) offsets.push(timeStamp - heard(beeps[k]));
    $('pad').classList.add('beat');
    setTimeout(() => $('pad').classList.remove('beat'), 80);
  };
  const onKey = e => { if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) tap(e.timeStamp); } };
  const onPad = e => tap(e.timeStamp);
  addEventListener('keydown', onKey);
  $('pad').addEventListener('pointerdown', onPad);
  $('pad').style.display = 'flex';

  while (ctx.currentTime < start + COUNT * PERIOD) await sleep(50);
  removeEventListener('keydown', onKey);
  $('pad').removeEventListener('pointerdown', onPad);
  $('pad').style.display = 'none';
  ctx.close();
  $('tapStart').disabled = false;

  if (offsets.length < 5) {
    $('tapOut').textContent = `Only ${offsets.length} taps counted. Try again and keep tapping to the end.`;
    return;
  }
  tapResult = median(offsets);
  const spread = median(offsets.map(o => Math.abs(o - tapResult)));
  $('tapOut').textContent = `Tap result: ${Math.round(tapResult)} ms (±${Math.round(spread)} ms over ${offsets.length} taps)` +
    (spread > 40 ? '. The taps were uneven; try again.' : '');
  $('tapUse').hidden = false;
};
$('tapUse').onclick = () => useDelay(tapResult);

// 3. Mic test
let micRaw = null;
$('micStart').onclick = async () => {
  $('micStart').disabled = true;
  $('micUse').hidden = $('match').hidden = true;
  $('micOut').textContent = 'Measuring… keep quiet.';
  try {
    micRaw = (await measureLatency()).ms;
    $('micOut').textContent = `Mic result: ${Math.round(micRaw - state.micOffsetMs)} ms ` +
      `(raw ${Math.round(micRaw)} ms − offset ${state.micOffsetMs} ms)`;
    $('micUse').hidden = $('match').hidden = false;
  } catch (e) {
    $('micOut').textContent = e.message;
  }
  $('micStart').disabled = false;
};
$('micUse').onclick = () => useDelay(micRaw - state.micOffsetMs);
$('match').onclick = () => {
  chrome.storage.local.set({ micOffsetMs: Math.round(micRaw - state.delayMs) });
  $('micOut').textContent = `Offset set to ${Math.round(micRaw - state.delayMs)} ms. Mic results now match ${state.delayMs} ms.`;
};
$('offset').onchange = e => chrome.storage.local.set({ micOffsetMs: Math.round(+e.target.value || 0) });
