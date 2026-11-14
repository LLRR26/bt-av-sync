// Streams mic samples to the page, each 128-sample block tagged with its context time.
registerProcessor('recorder', class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage({ t: currentTime, data: ch.slice() });
    return true;
  }
});
