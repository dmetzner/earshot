# Windows 11 memory and CPU audit, October 2026

A follow-up to the macOS audit of 2026-10-11, which shipped as #27. That audit already ruled out a Qt port,
`wc.reload()` as a way to free memory, in-process GPU, `renderer-process-limit`,
low-end-device mode and the V8 size flags, so none of them are repeated here. This one asks
what is different on Windows.

## Method

- Machine: Windows 11 Pro, 20 logical cores. Six services: Google Chat, Gmail ×2, Slack,
  WhatsApp, Discord.
- Measured the **installed** app as it was running, about 2 h 20 min after a cold start. Nothing
  was restarted or logged out.
- Memory comes from `Win32_PerfRawData_PerfProc_Process` (`WorkingSetPrivate`, `PrivateBytes`).
  The plain Windows "Working Set" counts shared DLL pages in every process, about 60 MB per
  renderer here, so it is listed only for comparison.
- Mapping renderers to services: each service view passes `--service-id=<id>` through
  `additionalArguments`, and that flag shows up on the renderer's command line
  (`Win32_Process.CommandLine`). The mapping below is exact, not guessed.
- CPU: the change in `TotalProcessorTime` for every process over 120 s.
- The window was **visible but behind other windows** (not minimized, not in front). That is a
  normal state on Windows, and it matters for finding 2.

## Footprint

| Process | Private WS (MB) | Private bytes (MB) | Working set (MB) | CPU over 120 s (% of one core) |
|---|---:|---:|---:|---:|
| WhatsApp renderer | 282 | 317 | 378 | 0.86 |
| Slack renderer | 226 | 246 | 301 | 0.01 |
| Discord renderer | 220 | 269 | 315 | 0.08 |
| Main (browser) process | 120 | 132 | 216 | 0.72 |
| Google Chat renderer | 90 | 103 | 170 | 0.04 |
| Gmail (private) renderer | 47 | 59 | 123 | 0.00 |
| Gmail (work) renderer | 46 | 58 | 122 | 0.00 |
| Renderer with no service id (probably a service worker) | 41 | 52 | 99 | 0.13 |
| Network service | 29 | 34 | 75 | 0.01 |
| GPU process (software compositing) | 26 | 34 | 104 | 0.01 |
| Sidebar renderer / the window's own blank renderer | 16 + 13 | 26 + 21 | 71 + 54 | 0.03 |
| Video capture service | 7 | 14 | 105 | 0.00 |
| Audio service | 6 | 10 | 99 | 0.00 |
| **Total** | **≈1,170** | **≈1,375** | (double-counted) | **1.89** |

Idle CPU comes to 1.9 % of one core in total, or about 0.1 % of the machine. That matches the
macOS figure of about 2 % of one core after #21. CPU is not the problem; memory and the issues below are.

On disk, `userData` takes 549 MB. Slack's `Service Worker` folder alone is 387 MB, and
WhatsApp's is 53 MB. The HTTP cache cap works: no partition's `Cache` is above 6 MB.

## Findings

1. **The installed build is stale.** It was built on 2026-09-09 with Electron 44.2.0, and it
   lacks #21 (skip the tray, sidebar and state-file work when a count did not change), #23
   (sweep service-worker CacheStorage), #27 (recycle the biggest view first) and #29 (redirect
   gate). Without #21, every 4 s poll of every view repaints the tray (three bitmaps and a shell
   update) and rewrites `unread.json`. During measurement the file was rewritten at least 10
   times in 20 s, where current `main` does it once every 30 s. That work is most of the main
   process's 0.72 % (an estimate: a current build was not measured on this machine). The missing #23 is why Slack's service-worker store has reached 387 MB.
2. **On Windows, "away" never starts while the window is visible but covered.** `isAway()`
   requires `!win.isVisible()`. A window left open behind other windows counts as visible, so
   none of the following happen: the poll never slows from 4 s to 15 s, no view is recycled, and
   the daily cache sweep never runs. That is the state the app was in during measurement. The
   macOS habit of putting the window away does not carry over to Windows.
3. **The window owns a renderer it never uses.** `new BrowserWindow(...)` creates its own
   `webContents`, which stays on `about:blank` because all content lives in child
   `WebContentsView`s. That costs one renderer. Of the two renderers without a service id and
   with no load (sidebar and blank window), the smaller one is 21 MB private bytes.
4. **The recycle threshold measures something different on Windows.** `RECYCLE_ABOVE_KB`
   is compared with `getAppMetrics().memory.workingSetSize`. On Windows that value includes about
   60 MB of shared pages per renderer, so the 400 MB line works out to roughly 340 MB of private
   memory. `memory.privateBytes` exists on Windows only and is the better-matched number there.
   This is a correctness detail. It does not save anything by itself.
5. **The video capture and audio services are running.** They started a few seconds after the
   renderers, probably because a page enumerated media devices (not traced to a page). Together the two services take 24 MB private bytes. Denying media permissions would
   prevent that, but it would also break calls and voice notes, so it is not worth doing.

What is fine on Windows:

- **GPU process.** It stays at 34 MB even with hardware acceleration off, because it is the
  software compositor. Moving it in-process gave nothing on macOS.
- **Spellchecker.** No `.bdic` dictionary has been downloaded into any partition, so there is
  nothing to save here.
- **Two Gmail instances.** About 58 MB private each, because a hidden Gmail is cheap.
- **`backgroundThrottling: false`.** All hidden renderers together use about 1 % of one core,
  mostly WhatsApp at 0.86 %. Turning throttling on would save at most that, and intensive timer
  throttling could hold back a title-driven count by up to a minute. It is not worth the risk.

## Ranked improvements

| # | Change | Expected saving | Risk | Touches |
|---|---|---|---|---|
| 1 | Reinstall from current `main` (`npm run build:win`) | Estimated: main process ≈0.6 % of a core → ≈0.05 %; state-file writes drop from tens of thousands a day to about 2,900; daily sweep frees up to ≈440 MB of service-worker storage (the CacheStorage part of it) (once 2 is fixed); picks up the #29 security fix | None. Sessions live in `userData`, which an install does not touch. Earshot has to be quit for the install. | Nothing (operational) |
| 2 | Count "not focused for 30 min" as away, not only "hidden" (track `blur`/`focus` and `minimize`/`restore` as well as `hide`) | Turns on recycling and the cache sweep for a window that is left open. Today WhatsApp, Discord and Slack sit at 250–320 MB private after 2 h. On macOS a view grew to 432 MB by 13 h, so expect 100–300 MB back over a day. Poll cost −70 % while away. | Low. The active view stays exempt from recycling, and hidden views are not attached, so a recycle cannot be seen. | `main.js` |
| 3 | `BaseWindow` instead of `BrowserWindow` for the hub window | ≈21 MB private bytes, one fewer renderer process | Low. Everything visible already lives in child views. Check that `show`/`hide`/`maximize` and the close handler behave the same. | `main.js` |
| 4 | Compare the recycle threshold against `privateBytes` on Windows | Accuracy, not MB. The 400 MB line then means the same thing on both platforms. | Low | `main.js` |
| 5 | Pause a rarely used service (the context menu in progress) | One whole renderer each: Discord 269 MB, WhatsApp 317 MB private bytes | None while paused. The cost is that the service shows no counts while paused. | `main.js`, `sidebar.html` (in progress elsewhere) |

The two biggest code wins are 2 and 3, and both need `main.js`. Because `main.js` is being
changed concurrently, this audit only writes them up. Number 1 needs no code at all.
