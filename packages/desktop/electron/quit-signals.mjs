/** Let the shell dispose its host and detached runtimes before it exits. */
export const attachQuitSignals = (app, signals = process) => {
  let quitting = false
  app.on('before-quit', () => { quitting = true })
  const quit = () => {
    // A launcher may forward a signal the app has already received. A second
    // app.quit() must not overtake the asynchronous before-quit disposal.
    if (quitting) return
    quitting = true
    app.quit()
  }
  signals.on('SIGTERM', quit)
  signals.on('SIGINT', quit)
}
