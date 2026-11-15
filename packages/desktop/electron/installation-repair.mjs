/** The same download destination the project's installer instructions name. */
export const DOWNLOAD_PAGE = 'https://github.com/HarnessDesk/HarnessDesk/releases/latest'

/** Keep a packaged app with no interface open until the person leaves or installs an update. */
export const repairMissingInterface = async ({ updates, showDialog, openExternal, quit, stopped = () => false, status = () => null, onCheck = () => {} }) => {
  while (!stopped()) {
    const menu = updates.menu()
    const action = menu?.action === 'install' ? 'install' : menu?.enabled ? 'check' : menu ? 'status' : null
    const outcome = status()
    const buttons = ['Open Downloads', ...(action ? [action === 'install' ? 'Restart to Update' : action === 'check' ? 'Check for Updates' : 'Update Status'] : []), 'Quit']
    const choice = await showDialog({
      type: 'error', message: 'HarnessDesk needs to be reinstalled.',
      detail: menu ? `The installation is missing its interface. ${outcome === 'failed' ? 'The update check failed. Try again or open Downloads.' : outcome === 'up-to-date' ? 'No newer update is available. Open Downloads for a fresh copy.' : menu.label}` : 'The installation is missing its interface. Download a fresh copy to repair it.',
      buttons, defaultId: 0, cancelId: buttons.length - 1,
    })
    if (stopped()) return 'stopped'
    if (choice === 0) {
      try { await openExternal(DOWNLOAD_PAGE) }
      catch { if (!stopped()) await showDialog({ type: 'error', message: 'Could not open Downloads.', detail: `Open ${DOWNLOAD_PAGE} in your browser and install a fresh copy.`, buttons: ['OK'] }) }
    } else if (action && choice === 1) {
      if (action === 'install') { menu.click(); return 'install' }
      if (action === 'check') {
        try { onCheck(); updates.check(false) }
        catch { if (!stopped()) await showDialog({ type: 'error', message: 'The update check failed.', detail: 'Try again or open Downloads.', buttons: ['OK'] }) }
      }
    } else { quit(); return 'quit' }
  }
  return 'stopped'
}
