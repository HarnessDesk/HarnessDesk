/** Publish native app-window authority before its renderer starts, and release only that identity. */
export const loadMainWindow = async ({ window, url, currentWindow, setCurrentWindow }) => {
  setCurrentWindow(window)
  const release = () => { if (currentWindow() === window) setCurrentWindow(null) }
  window.on('closed', release)
  try {
    await window.loadURL(url)
  } catch (error) {
    release()
    throw error
  }
  return window
}

/** A protocol return is a focus hint, never an authentication message. */
export const attachAppProtocol = ({ app, currentWindow, platform = process.platform }) => {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }

  // A development or isolated rig must not replace the installed app's handler.
  // The packaged bundle also declares this scheme in CFBundleURLTypes.
  if (app.isPackaged) app.setAsDefaultProtocolClient('harnessdesk')

  const focus = () => {
    const window = currentWindow()
    if (!window || window.isDestroyed()) return
    app.focus({ steal: true })
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  // Deliberately accept neither argv nor a URL. Tokens and codes are polled
  // by the host; nothing supplied by an OS launch can authenticate the desk.
  app.on('second-instance', focus)
  if (platform === 'darwin') app.on('open-url', event => {
    event.preventDefault()
    focus()
  })
  return true
}
