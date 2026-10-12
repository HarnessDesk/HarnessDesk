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
