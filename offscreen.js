'use strict';
// Hidden extension page: reports the current audio output and runs mic
// measurements. Offscreen pages only get chrome.runtime, so sw.js does storage.

async function report() {
  const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
  const def = outs.find(d => d.deviceId === 'default');
  if (!def?.label) return; // labels stay hidden until mic access is granted (calibrate.html)
  // "default" is an alias; the real device in the same group has the plain name.
  const real = outs.find(d => d.deviceId !== 'default' && d.groupId === def.groupId);
  chrome.runtime.sendMessage({ type: 'speaker', name: (real || def).label });
}

let busy = false;
async function measure() {
  if (busy) return { error: 'already measuring' };
  busy = true;
  try {
    return { ms: (await measureLatency()).ms };
  } catch (e) {
    return { error: e.name === 'NotAllowedError' ? 'mic not allowed. Open Calibrate and allow it.' : e.message };
  } finally {
    busy = false;
  }
}

navigator.mediaDevices.addEventListener('devicechange', report);
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'recheck') report();
  else if (msg.type === 'measure') {
    measure().then(reply);
    return true;
  }
});
report();
