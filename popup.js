'use strict';
const $ = id => document.getElementById(id);
const clamp = v => Math.min(1500, Math.max(0, Math.round(v / 10) * 10));

function setDelay(v) {
  v = clamp(v);
  $('ms').value = $('range').value = v;
  chrome.storage.local.set({ delayMs: v });
}

function show(s) {
  $('enabled').checked = s.enabled;
  $('ms').value = $('range').value = s.delayMs;
  const el = $('speaker');
  if (s.speaker) {
    el.textContent = `Speaker: ${s.speaker}`;
  } else {
    el.innerHTML = 'Speaker unknown · <a href="#" id="setup">set up</a> to save a delay per speaker';
    $('setup').onclick = () => chrome.runtime.openOptionsPage();
  }
}

chrome.storage.local.get({ delayMs: 200, enabled: true, speaker: '' }, show);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get({ delayMs: 200, enabled: true, speaker: '' }, show));
chrome.runtime.sendMessage({ type: 'recheck' }).catch(() => {});

$('calibrate').onclick = () => chrome.runtime.openOptionsPage();
$('enabled').onchange = e => chrome.storage.local.set({ enabled: e.target.checked });
$('minus').onclick = () => setDelay(+$('ms').value - 10);
$('plus').onclick = () => setDelay(+$('ms').value + 10);
$('range').oninput = e => setDelay(+e.target.value);
$('ms').onchange = e => setDelay(+e.target.value);
