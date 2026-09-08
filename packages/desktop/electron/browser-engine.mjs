import { ipcMain, webContents } from 'electron'

import { answered } from './deadline.mjs'
import { printOptions, printResult } from './pdf.mjs'

/**
 * The browser engine for the desktop shell: the browser pane inside the
 * window, driven over the DevTools protocol through `webContents.debugger`.
 *
 * The plugin host's browser service speaks CDP and nothing else — navigate,
 * screenshot, dispatch a click, evaluate — so giving it a sender backed by
 * the pane's `<webview>` makes every browser tool drive the page the person
 * is looking at, with no change to the tools. Headless, the same service
 * spawns Chrome instead; this file is what makes the desktop different.
 *
 * The pane owns the `<webview>`s — one per tab — and names the **driven**
 * one by id whenever it changes or re-attaches, so this file still has a
 * single guest to talk to and the six tools still know nothing about tabs.
 * If no pane is open when a tool needs one, main asks the renderer to show
 * it and waits. A pane the person closes is simply gone — the next tool call
 * opens it again.
 *
 * Every command first asks the pane to bring the driven tab to the front.
 * That is not politeness: Chromium suspends timers and stops rasterising a
 * `<webview>` nobody is looking at, so a screenshot of a backgrounded tab
 * comes back stale or blank. Fronting it keeps the pane's original promise —
 * what the agent drives is what the person sees.
 */

const READY_TIMEOUT_MS = 10_000
/** How many events one guest may bank before the oldest are dropped. */
const EVENT_CAP = 3_000

export const createInlineBrowserEngine = ({ window: currentWindow, show }) => {
  /** @type {import('electron').WebContents | null} */
  let guest = null
  /** @type {((wc: import('electron').WebContents) => void)[]} */
  let waiting = []
  /**
   * Every guest the pane has ever named, so a request to photograph one can
   * be checked against the pane's own tabs rather than against any
   * `webContents` id the renderer cares to send.
   * @type {Set<number>}
   */
  const known = new Set()

  ipcMain.on('harnessdesk:browser-ready', (_event, id) => {
    const found = Number.isInteger(id) ? webContents.fromId(id) : null
    if (!found) return
    guest = found
    // The pane names the same guest again whenever any tab attaches, so the
    // farewell is registered once per guest — every re-announcement used to
    // add another listener until Node warned about the leak.
    if (!known.has(found.id)) {
      known.add(found.id)
      found.once('destroyed', () => {
        known.delete(found.id)
        if (guest === found) guest = null
      })
    }
    const resolvers = waiting
    waiting = []
    for (const resolve of resolvers) resolve(found)
  })
  ipcMain.on('harnessdesk:browser-gone', () => {
    guest = null
  })

  /** Asks the pane to show the tab the tools drive. Fire and forget: the
   *  renderer switches while the CDP round trip is still in the air. */
  const front = () => {
    const window = currentWindow()
    if (window && !window.isDestroyed()) window.webContents.send('harnessdesk:browser-focus')
  }

  /**
   * What each guest has said since it was last asked.
   *
   * The debugger delivers console and network events by callback, and the
   * plugin host reads them by request — so they are banked here and handed
   * over on `drain`. Per guest, keyed weakly: a closed tab's backlog goes
   * with the tab rather than being reported against its replacement.
   * @type {WeakMap<import('electron').WebContents, {method: string, params: object}[]>}
   */
  const banked = new WeakMap()

  const attached = async (wc) => {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      const events = []
      banked.set(wc, events)
      wc.debugger.on('message', (_event, method, params) => {
        events.push({ method, params: params ?? {} })
        if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP)
      })
      await answered('Page.enable', wc.debugger.sendCommand('Page.enable'))
      await answered('Runtime.enable', wc.debugger.sendCommand('Runtime.enable'))
      // A guest that refuses either of these still drives; the read says so
      // by name rather than reporting an empty console.
      for (const domain of ['Log.enable', 'Network.enable']) {
        try {
          await answered(domain, wc.debugger.sendCommand(domain))
        } catch {
          /* the domain is absent, not the browser */
        }
      }
    }
    return {
      /**
       * Before input, the guest is the window's focused view — the same
       * promise as fronting the driven tab, one level down. It is not the
       * whole story: renderer focus inside the guest comes from a real
       * click, which is why `type` clicks before it inserts.
       *
       * Only for `Input.*`, and never on `ensure`: a screenshot must not
       * take the caret out of the person's composer.
       */
      send: async (method, params) => {
        if (method.startsWith('Input.')) wc.focus()
        // Headed Chromium has no `Page.printToPDF`; the guest prints itself
        // and answers in the protocol's shape, so the tool never learns
        // which engine it was talking to. See `pdf.mjs`.
        if (method === 'Page.printToPDF') {
          return printResult(await answered(method, wc.printToPDF(printOptions(params ?? {}))))
        }
        return answered(method, wc.debugger.sendCommand(method, params ?? {}))
      },
      drain: async () => (banked.get(wc) ?? []).splice(0),
    }
  }

  return {
    /** The guests the pane has named — what `capture` will photograph. */
    knows: (id) => known.has(id),

    /** A PNG of one of the pane's own tabs, for *Save screenshot*. */
    async capture(id) {
      const wc = known.has(id) ? webContents.fromId(id) : null
      if (!wc || wc.isDestroyed()) throw new Error('That page is no longer open.')
      const sender = await attached(wc)
      const shot = await sender.send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(shot.data, 'base64')
    },

    async ensure() {
      if (guest && !guest.isDestroyed()) {
        front()
        return attached(guest)
      }
      const window = (await show()) ?? currentWindow()
      if (!window) throw new Error('HarnessDesk has no window to show a browser in.')
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = waiting.filter((entry) => entry !== resolve)
          reject(new Error('The browser pane did not open in time.'))
        }, READY_TIMEOUT_MS)
        waiting.push((wc) => {
          clearTimeout(timer)
          resolve(wc)
        })
      })
      window.webContents.send('harnessdesk:browser-show', { url: 'about:blank' })
      return attached(await ready)
    },

    async close() {
      if (guest && !guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach()
      guest = null
      currentWindow()?.webContents.send('harnessdesk:browser-close')
    },
  }
}
