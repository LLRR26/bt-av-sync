# BT AV Sync

Chrome extension that delays video to match Bluetooth audio lag.

## Install
1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. After editing files, hit the reload icon on the extension card, then reload the video tab.

## Use
| Key | Action |
|---|---|
| `Alt+]` / `Alt+[` | delay +10 / −10 ms |
| `Alt+\` | on / off |
| `Alt+S` | pause, re-measure with the mic (~5 s, 3 chirps), resume |
| `Alt+T` | two-tab sync on / off (Crunchyroll, YouTube) |
| `Alt+R` | two-tab sync readout on / off (error, speed, restarts) |

The toolbar popup has a slider and on/off switch. After allowing mic access once
(popup → "Calibrate…", or right-click the icon → Options), a delay is saved per speaker
and restored automatically when that speaker becomes the output again. Whenever the speaker
changes (new, or reconnected), the delay is re-measured automatically the next time a video plays.

Default delay is 200 ms. Muted videos and DRM videos (Crunchyroll, Netflix) are left alone.

## Two-tab sync (Crunchyroll, YouTube)
DRM blocks frame-delay on Crunchyroll, so `Alt+T` on an episode opens the same episode in a
pinned tab that plays the sound, mutes your tab, and keeps your tab `delay` ms behind it.
Pause/seek in your tab are copied over, and the next episode/video is followed automatically.
`Alt+T` again (or closing either tab, or leaving the video page) ends it.
Needs 2 free streams on Crunchyroll (Mega Fan or higher). The pinned tab flashes to the front
once while it loads, because Chrome won't start video in a tab that has never been shown.
On YouTube, frame-delay already works in one tab; two-tab is the alternative. Without Premium,
each tab plays its own ads: the other tab waits until the ad is over, then they resync.
Turn it off (`Alt+T`) before reloading the extension. If you forget: close the pinned tab and
reopen the episode in a new tab (the old tab stays muted).

## Calibrate
Popup → "Calibrate…" (or right-click the icon → Options):
- **Tap test**: tap Space along with 12 beeps. ±30 ms.
- **Mic test**: 3 chirps through the speaker, heard by the laptop mic. Once you've found a
  delay that looks right by ear, click "Set offset…" once so mic results match it.

Both measure only the lag Chrome doesn't already correct for, which is the delay the video needs.

## Self-checks
`node test/find-chirp.test.js` checks the chirp detection.
`node test/pair-sync.test.js` checks the two-tab follower against fake videos.

For the frame delay, open `test/sync-test.html` in Chrome (drag the file into a tab), click **Start**.
It should print `PASS: overlay lags live video by ~200 ms`.
