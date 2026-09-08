/**
 * A promise that must answer, or say that it did not.
 *
 * `webContents.debugger.sendCommand` returns a promise Chromium may simply
 * never settle. `Page.captureScreenshot` against a guest that is not being
 * rasterised is the reliable way to see it, and a `<webview>` stops
 * rasterising the moment nobody is looking at it — which is a state a tool
 * call can genuinely find it in, because fronting the driven tab is fire and
 * forget while the CDP round trip is already in the air.
 *
 * Nothing above catches that: the plugin host awaits the command, the tool
 * gateway awaits the plugin host, and the agent's turn awaits the gateway. One
 * unanswered command holds a conversation open with a spinner and no way back
 * — seen twice in live recordings, both times an agent's `browser_open` never
 * returning. `docs/browser-control.md` promises "every operation carries a
 * mandatory timeout, because a hung page must not hang a turn"; this is where
 * that has to be kept.
 *
 * The timer is always cleared, including on the settled paths, because a
 * pending timer keeps the event loop alive and a shell that will not quit is
 * its own bug.
 */
export const answered = (what, sending, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `The page did not answer ${what} within ${Math.round(ms / 1000)} seconds. ` +
            'It may be busy, or the tab may not be on screen.',
        ),
      )
    }, ms)
    // `unref` where the runtime has it: a deadline should never be the reason
    // a process stays up, and Node's test runner is where that shows first.
    timer.unref?.()
    Promise.resolve(sending).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
