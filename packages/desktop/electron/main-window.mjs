import { parsePromptLink, promptLinkFromArgv } from './prompt-link.mjs'

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

/**
 * A protocol launch is a focus hint, never an authentication message.
 *
 * One route is the exception: `harnessdesk://new`, a prompt link, which only
 * fills a draft (`prompt-link.mjs`). It is parsed, put in `promptLinks` for
 * the renderer to take, and the window is brought forward as for any other
 * launch. Every other URL and every other argv element is still never read.
 */
export const attachAppProtocol = ({ app, currentWindow, platform = process.platform, argv = [], promptLinks = null }) => {
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
  // Tokens and codes are polled by the host; nothing supplied by an OS launch
  // can authenticate the desk. Only a prompt link is read, and only by its
  // own strict parser, which ignores everything that is not one.
  const offer = link => { if (link && promptLinks) promptLinks.offer(link) }
  // Windows and Linux: a cold start carries the link in this process's argv.
  if (promptLinks) offer(promptLinkFromArgv(argv))
  app.on('second-instance', (_event, secondArgv) => {
    if (promptLinks) offer(promptLinkFromArgv(secondArgv))
    focus()
  })
  if (platform === 'darwin') app.on('open-url', (event, url) => {
    event.preventDefault()
    if (promptLinks && typeof url === 'string' && url.startsWith('harnessdesk://new')) offer(parsePromptLink(url))
    focus()
  })
  return true
}
