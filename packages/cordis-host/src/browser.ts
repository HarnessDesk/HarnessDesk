import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'

import { PAGE_HELPERS, callHelper } from './browser-page.js'
import type { HostRuntime } from './runtime.js'

/**
 * `ctx.browser` — a visible browser the plugin can drive, in as much of the
 * DevTools protocol as a page is worth asking.
 *
 * The engine is the user's own Chrome over CDP, or the desktop shell's own
 * pane: no bundled browser, no new dependency (Node's global WebSocket
 * carries CDP). The window is deliberately headed — the person watches the
 * agent work, which is the honest version of "view the results". It runs in
 * its own profile directory so the agent never touches the user's cookies
 * or sessions.
 *
 * This service began as six calls — navigate, screenshot, click, key,
 * evaluate, close — which is enough to *use* a page and not enough to
 * *debug* one. An agent that builds a web app and cannot read the console
 * it just filled with errors, or see the request that 500'd, is doing the
 * work with one eye shut. So the surface is now the protocol's own shape:
 * input, the DOM, console, network, emulation, and a passthrough for
 * everything not worth a method of its own.
 *
 * Two conventions are load-bearing:
 *
 * - **Screenshot pixels for coordinates, CSS pixels for references.** A
 *   screenshot comes back in *device* pixels and `Input.dispatchMouseEvent`
 *   takes *CSS* pixels, which on a Retina screen differ by two. A model
 *   clicking what it saw would land at half the distance, so `click` divides
 *   by the page's own ratio. A `ref_3` from `readPage` is resolved by the
 *   page itself and is already in CSS pixels — it must not be divided again.
 * - **Events are pulled, never pushed.** CDP pushes console and network
 *   events, but a plugin runs in a child process reached by request and
 *   reply. Rather than open a reverse notification lane and buffer at both
 *   ends, the engine keeps a ring and the service drains it on demand. One
 *   direction, one buffer, and a plugin that never asks costs nothing.
 *
 * Gated by the manifest permission `browser: true`, shown at install like
 * every other grant. Every operation carries a timeout: a hung page must
 * never hang an agent's turn.
 */

/**
 * The browsers that can be driven, in the order they are preferred.
 *
 * All Chromium: the DevTools protocol is the whole mechanism, so Safari and
 * Firefox are not candidates however popular they are — an option that
 * cannot be driven would be an option that fails after you choose it.
 */
const KNOWN_BROWSERS: readonly { name: string; path: string }[] = [
  { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { name: 'Google Chrome Canary', path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary' },
  { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
  { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { name: 'Arc', path: '/Applications/Arc.app/Contents/MacOS/Arc' },
  { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
  { name: 'Chromium', path: '/usr/bin/chromium' },
  { name: 'Chromium', path: '/usr/bin/chromium-browser' },
  { name: 'Brave', path: '/usr/bin/brave-browser' },
  { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
]

const CHROME_PATHS = KNOWN_BROWSERS.map((entry) => entry.path)

/** Which of them are actually here, for the setting that picks one. */
export const installedBrowsers = (): readonly { name: string; path: string }[] =>
  KNOWN_BROWSERS.filter((entry) => existsSync(entry.path))

const VIEWPORT = { width: 1024, height: 768 }
const CDP_TIMEOUT_MS = 15_000
/** How many raw events the service keeps. Enough for a page load, capped so a chatty page cannot grow without bound. */
const EVENT_CAP = 3_000
/** How many requests the network view remembers, oldest evicted first. */
const REQUEST_CAP = 500

interface CdpConnection {
  readonly socket: WebSocket
  readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  readonly events: CdpEvent[]
  nextId: number
}

export interface BrowserPage {
  readonly url: string
  readonly title: string
  /**
   * The page went to the default browser, which this cannot see into: there
   * is no title to report and no screenshot to take, and a tool that tried
   * would be refused by the setting it has just obeyed.
   */
  readonly handedOff?: true
}

/** One protocol event, exactly as the browser sent it. */
export interface CdpEvent {
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * Where the page the tools drive lives.
 *
 * The service only ever speaks DevTools Protocol — navigate, screenshot,
 * dispatch a mouse event, evaluate — and does not care who answers. The
 * headless host answers with the user's Chrome over a WebSocket (below);
 * the desktop app answers with the browser pane inside its own window,
 * through Electron's `webContents.debugger`, so the same tools drive the
 * page the person is looking at. An engine says how to reach the page and
 * how to let it go; everything else is shared.
 */
export interface CdpSender {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /**
   * The events buffered since the last drain, emptied by the reading.
   *
   * Optional because it is the one thing an engine may honestly not have:
   * a sender that can only round-trip a command cannot subscribe. Console
   * and network reads say so by name rather than returning an empty list,
   * which would read as "the page logged nothing".
   */
  drain?(): Promise<readonly CdpEvent[]>
}

export interface BrowserEngine {
  /** The page to drive, started or shown if need be, with `Page` and `Runtime` domains enabled. */
  ensure(): Promise<CdpSender>
  close(): Promise<void>
}

/**
 * Where the pages an agent opens are shown.
 *
 * - `pane` — inside HarnessDesk, in the Browser pane, which is also the
 *   page the person is watching. The desktop shell supplies that engine;
 *   with no window there is none, and this falls back to `window`.
 * - `window` — a separate Chrome, in a profile of HarnessDesk's own. The
 *   agent never sees the person's cookies, logins or extensions.
 * - `system` — the person's default browser, by handing the URL to the OS.
 *   Nothing is driven: no screenshot, no click, no reading the page. It is
 *   a hand-off, offered because sometimes that is all you want.
 *
 * There is deliberately no fourth option for "drive my own Chrome, with my
 * logins". Chrome has refused `--remote-debugging-port` on the default
 * profile since 136 precisely so that a local program cannot do this, and
 * an option that quietly did something else would be a lie.
 */
export type BrowserPlacement = 'pane' | 'window' | 'system'

export interface BrowserSettings {
  readonly placement: BrowserPlacement
  /** Which Chrome to start for `window`. Absent: the first one found. */
  readonly binary?: string | undefined
  /** Whether that profile survives a restart — its cookies and logins with it. */
  readonly keepProfile?: boolean
  /**
   * Where a kept profile lives. The host names a directory inside its own
   * state directory; absent, the default `~/.harnessdesk/browser-profile` —
   * which is the wrong desk whenever `HARNESSDESK_HOME` points elsewhere.
   */
  readonly profileDir?: string | undefined
}

const DEFAULT_SETTINGS: BrowserSettings = { placement: 'pane', keepProfile: true }

/**
 * One driven browser per plugin host. Module state rather than instance
 * fields for two reasons: cordis hands plugins a proxy of the service, which
 * native #private fields refuse — and two plugins each spawning a Chrome
 * against the same profile would fight anyway. The permission gate still
 * runs per calling plugin.
 */
const state: {
  child: ChildProcess | null
  connection: CdpConnection | null
  profileDir: string | null
  /** The throwaway profile of a browser that keeps nothing; removed when it closes. */
  disposableDir: string | null
  engine: BrowserEngine | null
  settings: BrowserSettings
  /** Raw events, drained from the engine and kept for whoever reads next. */
  events: CdpEvent[]
} = {
  child: null,
  connection: null,
  profileDir: null,
  disposableDir: null,
  engine: null,
  settings: DEFAULT_SETTINGS,
  events: [],
}

/** Replaces the Chrome engine — the desktop shell does, with its own pane. */
export const setBrowserEngine = (engine: BrowserEngine | null): void => {
  state.engine = engine
  state.events = []
}

/**
 * The user's answer to "where should pages open". Changing it does not
 * disturb a browser already open: the next call lands wherever the setting
 * now says, and whatever was running is left for its own owner to close.
 */
export const setBrowserSettings = (settings: Partial<BrowserSettings>): void => {
  state.settings = { ...state.settings, ...settings }
}

export const browserSettings = (): BrowserSettings => state.settings

/** The engine the setting asks for, or the nearest thing this process has. */
const engine = (): BrowserEngine => {
  switch (state.settings.placement) {
    case 'window':
      return chromeEngine
    case 'system':
      return systemEngine
    default:
      // No pane in a headless host or the web build; a window is the
      // closest thing to "in HarnessDesk" that such a process can offer.
      return state.engine ?? chromeEngine
  }
}

// ------------------------------------------------------------------ options

export interface ScreenshotOptions {
  /** The whole scrollable document rather than the viewport. */
  readonly fullPage?: boolean
  /** Just this element, from a `readPage` reference. */
  readonly ref?: string
}

export interface PointerOptions {
  readonly button?: 'left' | 'right' | 'middle'
  readonly count?: number
  readonly modifiers?: readonly string[]
}

/** Where a pointer goes: measured off a screenshot, or named by the page. */
export type PointerTarget = { readonly x: number; readonly y: number } | { readonly ref: string }

export interface ReadPageOptions {
  /** `tree` is the accessibility-shaped outline; `text` is what a person reads. */
  readonly format?: 'tree' | 'text'
  /** Keep only lines containing this, so a big page answers a small question. */
  readonly query?: string
  /** Every element, not only the ones worth acting on. */
  readonly filter?: 'interactive' | 'all'
  readonly maxChars?: number
}

export interface WaitOptions {
  readonly selector?: string
  readonly text?: string
  /** A selector that must *stop* matching — a spinner going away. */
  readonly gone?: string
  readonly timeoutMs?: number
}

export interface EmulateOptions {
  readonly width?: number
  readonly height?: number
  readonly deviceScaleFactor?: number
  readonly mobile?: boolean
  readonly userAgent?: string
  readonly colorScheme?: 'light' | 'dark'
  readonly offline?: boolean
  readonly touch?: boolean
  /** Drop every override and let the page be itself again. */
  readonly reset?: boolean
}

export interface ConsoleEntry {
  readonly level: string
  readonly text: string
  readonly url?: string
  readonly line?: number
}

export interface NetworkEntry {
  readonly requestId: string
  readonly method: string
  readonly url: string
  readonly resourceType?: string
  readonly status?: number
  readonly statusText?: string
  readonly mimeType?: string
  readonly bytes?: number
  readonly error?: string
}

// ------------------------------------------------------------------ service

/**
 * A page title made safe as a file name. Separators and control characters,
 * NUL and line breaks among them, become dashes (a colon is a separator to the
 * Finder), and a title that already ends in `.pdf` doesn't get a second one.
 * It's cut at 80 characters, counted as characters rather than UTF-16 units,
 * so an emoji at the cut isn't split into half of one, which the filesystem
 * stores as U+FFFD (review of #187, round 2). Then dots and spaces at either
 * end go: a leading dot hid the file, and the cut could end the name on a
 * space (round 1). A name with nothing left is `page`. What Windows forbids
 * besides is left alone: the desktop app ships for macOS only.
 */
const pdfName = (title: string | undefined): string => {
  const whole = String(title ?? '')
    .replace(/[\x00-\x1f/\\:]/g, '-')
    .trim()
    .replace(/\.pdf$/i, '')
  const clean = Array.from(whole)
    .slice(0, 80)
    .join('')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  return clean === '' ? 'page' : clean
}

/** The `hd-pdf-` folders this build can name an owner for. */
const PDF_OWNER = /^hd-pdf-(\d+)-/

/**
 * Whether a pid is a process right now.
 *
 * Signal 0 sends nothing; it asks. `ESRCH` is "no such process", and `EPERM`
 * is a process owned by somebody else — which is still a process, and the
 * answer that matters here is existence, not reachability.
 */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/**
 * The saved-PDF folders of desks that are no longer running.
 *
 * A folder lives as long as the plugin that asked for it, so it goes when that
 * plugin stops or the desk quits. A crash, a force quit, and a supervised
 * plugin child that is killed rather than shut down all run no disposer, and
 * the folder then stays until the OS clears its temp directory (#234).
 *
 * Sweeping every `hd-pdf-*` folder at start would be the wrong fix: several
 * desks run on one machine at once — the review desks do — and it would take a
 * live one's files while it was using them. So each folder is named for the
 * process that made it, and only the folders whose process is gone are
 * removed. A name no owner can be read out of is left alone: it belongs to a
 * build that named them differently, and guessing is the mistake this exists
 * to avoid.
 *
 * Returns what it removed, which is what a test can assert on.
 */
export const sweepAbandonedPdfFolders = (): string[] => {
  const swept: string[] = []
  const root = tmpdir()
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return swept
  }
  for (const entry of entries) {
    // A directory, and not a link to one: `isDirectory()` is false for a
    // symlink, so a link planted in the temp directory is never followed.
    if (!entry.isDirectory()) continue
    const owner = Number(PDF_OWNER.exec(entry.name)?.[1])
    if (!Number.isSafeInteger(owner) || owner <= 0 || running(owner)) continue
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true })
      swept.push(entry.name)
    } catch {
      // Another desk quitting at this moment is removing its own folder.
    }
  }
  return swept
}

/* Once per process rather than once per service: the sweep reads the whole
   temp directory, and a host installs this service once but a test suite
   builds many kernels. */
let swept = false

export class BrowserService extends Service {
  static [Service.tracker] = { associate: 'browser', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'browser')
    /* The disposer's promise is handed back rather than discarded. Cordis
       awaits what a disposer returns, so `void` here left `kernel.dispose()`
       nothing to wait for: both engines' `close()` happen to be synchronous
       today, and the first one that yields would outlive the quit — #212
       again, latent (round 3 of #244). */
    ctx.effect(() => () => this.close().catch(() => {}), 'browser-shutdown')
    /* And the folders left by a desk that never got to run that disposer.
       Here rather than at kernel start because this is the service that makes
       them, so the sweep cannot outlive the reason for it (#234). */
    if (!swept) {
      swept = true
      sweepAbandonedPdfFolders()
    }
  }

  /** The gate, then the page — the two lines every call below starts with. */
  private async reach(): Promise<CdpSender> {
    this.runtime.owner(this.ctx).gate.assertBrowser()
    const cdp = await engine().ensure()
    await pump(cdp)
    return cdp
  }

  /** Opens (starting the browser if needed) and waits for the load to settle. */
  async open(url: string): Promise<BrowserPage> {
    this.runtime.owner(this.ctx).gate.assertBrowser()
    // The system browser is a hand-off, not a session: there is nothing to
    // wait for and nothing to ask afterwards, so say so plainly.
    if (state.settings.placement === 'system') {
      await handToSystem(url)
      return { url, title: '', handedOff: true }
    }
    const cdp = await engine().ensure()
    // A fresh document is a fresh console and a fresh set of requests. Keeping
    // the previous page's would make "what did this page log" a question with
    // two pages in the answer.
    state.events = []
    await pump(cdp)
    state.events = []
    await cdp.send('Page.navigate', { url })
    await settle(1_500)
    return this.page()
  }

  async page(): Promise<BrowserPage> {
    const cdp = await this.reach()
    const result = (await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ url: location.href, title: document.title })',
      returnByValue: true,
    })) as { result?: { value?: string } }
    return JSON.parse(result.result?.value ?? '{}') as BrowserPage
  }

  /** A PNG of the viewport — or the document, or one element — as a data: URL. */
  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    const cdp = await this.reach()
    const params: Record<string, unknown> = { format: 'png' }
    if (options.ref) {
      const box = await this.locate(cdp, options.ref)
      // captureBeyondViewport lets a clip reach past the fold without
      // scrolling the page under the person watching it.
      params['clip'] = {
        x: box.x - box.width / 2,
        y: box.y - box.height / 2,
        width: box.width,
        height: box.height,
        scale: 1,
      }
      params['captureBeyondViewport'] = true
    } else if (options.fullPage) {
      const metrics = (await cdp.send('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
      }
      const size = metrics.cssContentSize ?? metrics.contentSize
      if (size) {
        params['clip'] = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
        params['captureBeyondViewport'] = true
      }
    }
    const result = (await cdp.send('Page.captureScreenshot', params)) as { data?: string }
    if (!result.data) throw new Error('The browser returned no screenshot data.')
    return `data:image/png;base64,${result.data}`
  }

  /**
   * The page as a PDF, which is `Page.printToPDF` and nothing more — except
   * that headed Chromium does not implement it (the pane answers it itself;
   * a separate Chrome window cannot), and the refusal has to say that
   * rather than "wasn't found".
   */
  async pdf(options: { landscape?: boolean; printBackground?: boolean } = {}): Promise<string> {
    const cdp = await this.reach()
    const result = (await cdp
      .send('Page.printToPDF', {
        printBackground: options.printBackground ?? true,
        landscape: options.landscape ?? false,
        transferMode: 'ReturnAsBase64',
      })
      .catch((error: unknown) => {
        const said = error instanceof Error ? error.message : String(error)
        if (/wasn't found|not implemented|not supported/i.test(said)) {
          throw new Error(
            'This browser cannot print to PDF — a separate Chrome window does not implement it. ' +
              'The Browser pane can: set Settings → Browser → Pages open to “In HarnessDesk”.',
          )
        }
        throw error
      })) as { data?: string }
    if (!result.data) throw new Error('The browser returned no PDF data.')
    return `data:application/pdf;base64,${result.data}`
  }

  /**
   * The page as a PDF file, in a folder of its own under the system's temp
   * directory, named for the page: the path, and the size. What an agent does
   * with a PDF is name it, open it or hand it on, and each of those takes a
   * path. As a data URL it went to the model as an image, which no model
   * reads (#51).
   */
  async savePdf(
    options: { landscape?: boolean; printBackground?: boolean; name?: string } = {},
  ): Promise<{ path: string; bytes: number }> {
    const url = await this.pdf(options)
    const data = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    /* The folder lives as long as the plugin that asked for it, which for a
       built-in is the desk: nothing else would remove it (review of #187,
       round 1). `this.ctx` is the caller's scope, the one the gate reads. The
       root's own effects don't run when the kernel stops its plugins. It's
       made inside the effect, so a scope that is already stopping refuses
       before anything is on disk rather than after, and says so (round 2). */
    let folder = ''
    try {
      this.ctx.effect(() => {
        /* Named for this process, so a folder a crash left behind can be told
           from a folder another live desk is still using (#234). */
        folder = mkdtempSync(join(tmpdir(), `hd-pdf-${process.pid}-`))
        return () => rmSync(folder, { recursive: true, force: true })
      }, 'pdf-folder')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'INACTIVE_EFFECT') throw error
      throw new Error('The PDF was not saved: the plugin that asked for it is stopping.')
    }
    const path = join(folder, `${pdfName(options.name)}.pdf`)
    writeFileSync(path, data)
    return { path, bytes: data.length }
  }

  /** A full click — move, press, release — at the screenshot's own pixels. */
  async click(x: number, y: number, options: PointerOptions = {}): Promise<void> {
    const cdp = await this.reach()
    const ratio = await deviceRatio(cdp)
    await this.pointerAt(cdp, x / ratio, y / ratio, options)
  }

  /** The same click, aimed by a reference the page handed out — already CSS pixels. */
  async clickRef(ref: string, options: PointerOptions = {}): Promise<void> {
    const cdp = await this.reach()
    const box = await this.locate(cdp, ref)
    await this.pointerAt(cdp, box.x, box.y, options)
  }

  /** Moves the pointer without pressing — menus and tooltips open on this alone. */
  async hover(target: PointerTarget): Promise<void> {
    const cdp = await this.reach()
    const point = await this.aim(cdp, target)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    await settle(200)
  }

  /**
   * A wheel scroll at a point. Wheel rather than `scrollTo`, because a page
   * that virtualises its list is listening for the wheel, not for a changed
   * `scrollTop`.
   */
  async scroll(deltaX: number, deltaY: number, target?: PointerTarget): Promise<void> {
    const cdp = await this.reach()
    const point = target ? await this.aim(cdp, target) : await this.centre(cdp)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
    })
    await settle(300)
  }

  /** Press at one point, move in steps, release at another. */
  async drag(from: PointerTarget, to: PointerTarget): Promise<void> {
    const cdp = await this.reach()
    const start = await this.aim(cdp, from)
    const end = await this.aim(cdp, to)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none' })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    })
    // Intermediate moves are not decoration: an HTML5 drag source and every
    // drag library start on movement, not on the press.
    const steps = 8
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: start.x + ((end.x - start.x) * step) / steps,
        y: start.y + ((end.y - start.y) * step) / steps,
        button: 'left',
      })
      await settle(16)
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      clickCount: 1,
    })
    await settle(300)
  }

  /** Presses a key (`Enter`, `ArrowLeft`, a single character…) `count` times. */
  async key(key: string, count = 1, modifiers: readonly string[] = []): Promise<void> {
    const cdp = await this.reach()
    const mask = modifierMask(modifiers)
    const spec = namedKey(key)
    for (let i = 0; i < Math.min(count, 50); i += 1) {
      if (spec) {
        const common = {
          // A caller types a *name*; a page listens for the *key*. `space`
          // and `' '` are one press, and only one of the two is what
          // `event.key` may read.
          key: spec.key,
          code: spec.code,
          windowsVirtualKeyCode: spec.keyCode,
          nativeVirtualKeyCode: spec.keyCode,
          ...(mask ? { modifiers: mask } : {}),
        }
        await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' })
        if (!mask && (spec.key === ' ' || spec.key === 'Enter')) {
          await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'char', text: spec.key === 'Enter' ? '\r' : ' ' })
        }
        await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' })
      } else if (key.length === 1) {
        // A modified character is a shortcut, not typing: ⌘A must arrive as a
        // key event or the page sees the letter and selects nothing.
        if (mask) {
          const physical = characterKey(key)
          const common = {
            key,
            // A character off the layout has no key a page could know it by.
            ...(physical
              ? { code: physical.code, windowsVirtualKeyCode: physical.keyCode, nativeVirtualKeyCode: physical.keyCode }
              : {}),
            modifiers: mask,
          }
          await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' })
          await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' })
        } else {
          await cdp.send('Input.insertText', { text: key })
        }
      } else {
        throw new Error(unknownKeyMessage(key))
      }
      await settle(60)
    }
    await settle(200)
  }

  /**
   * Types a whole string. `Input.insertText` rather than a key event per
   * character: it is one round trip instead of three per letter, and it is
   * what an IME does, so a field that only listens for `input` still fills.
   */
  async type(text: string, options: { ref?: string; submit?: boolean } = {}): Promise<void> {
    if (options.ref) {
      // A click, not `element.focus()`. `Input.insertText` goes to the
      // *frame's* focused element, and a page-side focus() sets
      // `document.activeElement` without focusing the frame — so on a guest
      // nobody has clicked yet, typing lands nowhere and reports success.
      // Observed in the Browser pane on 2026-08-24: a fresh pane took the
      // text silently and the field stayed empty. Clicking is what a person
      // does, and it is what makes the caret real.
      await this.clickRef(options.ref)
      await this.evaluateHelper(await this.reach(), `__hd.focus(${JSON.stringify(options.ref)})`)
    }
    const cdp = await this.reach()
    await cdp.send('Input.insertText', { text })
    await settle(120)
    if (options.submit) await this.key('Enter')
  }

  /** Sets a form control's value the way the page's own framework expects. */
  async fill(ref: string, value: string | boolean): Promise<unknown> {
    const cdp = await this.reach()
    return this.evaluateHelper(cdp, `__hd.fill(${JSON.stringify(ref)}, ${JSON.stringify(value)})`)
  }

  /** Hands a file input real files, which only the browser can do. */
  async upload(ref: string, files: readonly string[]): Promise<void> {
    const cdp = await this.reach()
    const missing = files.filter((file) => !existsSync(file))
    if (missing.length) throw new Error(`No file at ${missing.join(', ')}.`)
    await cdp.send('DOM.enable')
    const handle = (await cdp.send('Runtime.evaluate', {
      expression: `${PAGE_HELPERS} __hd.lookup(${JSON.stringify(ref)})`,
      returnByValue: false,
    })) as { result?: { objectId?: string }; exceptionDetails?: { text?: string } }
    if (!handle.result?.objectId) {
      throw new Error(handle.exceptionDetails?.text ?? `${ref} is not a file input on this page.`)
    }
    await cdp.send('DOM.setFileInputFiles', { files: [...files], objectId: handle.result.objectId })
    await settle(200)
  }

  /** Evaluates an expression in the page; the JSON value comes back. */
  async evaluate(expression: string): Promise<unknown> {
    const cdp = await this.reach()
    return evaluateValue(cdp, expression)
  }

  /**
   * What is on the page and what can be acted on, as indented lines with
   * `ref_N` handles — the question a model asks before every other one.
   */
  async readPage(options: ReadPageOptions = {}): Promise<string> {
    const cdp = await this.reach()
    const call =
      options.format === 'text'
        ? `__hd.text(${JSON.stringify({ maxChars: options.maxChars })})`
        : `__hd.tree(${JSON.stringify({
            filter: options.filter ?? 'interactive',
            query: options.query,
            maxChars: options.maxChars,
          })})`
    return String(await this.evaluateHelper(cdp, call))
  }

  /** Back, forward, or reload — the three buttons a browser has. */
  async history(direction: 'back' | 'forward' | 'reload'): Promise<BrowserPage> {
    const cdp = await this.reach()
    if (direction === 'reload') {
      await cdp.send('Page.reload')
    } else {
      const history = (await cdp.send('Page.getNavigationHistory')) as {
        currentIndex?: number
        entries?: { id: number }[]
      }
      const entries = history.entries ?? []
      const index = (history.currentIndex ?? 0) + (direction === 'back' ? -1 : 1)
      const entry = entries[index]
      if (!entry) throw new Error(`There is no page to go ${direction} to.`)
      await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    }
    await settle(1_200)
    return this.page()
  }

  /**
   * Waits for the page to reach a state, by asking it rather than sleeping.
   * A poll, not a lifecycle subscription: it is the same question in either
   * engine and it cannot miss an event that fired before the wait began.
   */
  async waitFor(options: WaitOptions = {}): Promise<boolean> {
    const cdp = await this.reach()
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    const call = `__hd.settled(${JSON.stringify({
      selector: options.selector,
      text: options.text,
      gone: options.gone,
    })})`
    for (;;) {
      if ((await this.evaluateHelper(cdp, call)) === true) return true
      if (Date.now() > deadline) return false
      await settle(250)
    }
  }

  /** Device metrics, user agent, colour scheme, and being offline. */
  async emulate(options: EmulateOptions = {}): Promise<void> {
    const cdp = await this.reach()
    if (options.reset) {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' })
      await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
      return
    }
    if (options.width || options.height) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: options.width ?? 0,
        height: options.height ?? 0,
        deviceScaleFactor: options.deviceScaleFactor ?? 0,
        mobile: options.mobile ?? false,
      })
    }
    if (options.userAgent) await cdp.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
    if (options.colorScheme) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: options.colorScheme }],
      })
    }
    if (options.touch !== undefined) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: options.touch })
    }
    if (options.offline !== undefined) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: options.offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
    }
    await settle(200)
  }

  /** What the page has logged, including what the browser logged about it. */
  async console(options: { limit?: number; onlyErrors?: boolean; pattern?: string } = {}): Promise<readonly ConsoleEntry[]> {
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'console messages')
    let entries = consoleFrom(state.events)
    if (options.onlyErrors) entries = entries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
    if (options.pattern) {
      const needle = options.pattern.toLowerCase()
      entries = entries.filter((entry) => entry.text.toLowerCase().includes(needle))
    }
    const limit = options.limit && options.limit > 0 ? options.limit : 100
    return entries.slice(-limit)
  }

  /** What the page asked for, and one answer in full when asked by id. */
  async network(
    options: { limit?: number; urlPattern?: string; requestId?: string } = {},
  ): Promise<readonly NetworkEntry[] | { body: string; base64: boolean }> {
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'network requests')
    if (options.requestId) {
      const body = (await cdp.send('Network.getResponseBody', { requestId: options.requestId })) as {
        body?: string
        base64Encoded?: boolean
      }
      return { body: body.body ?? '', base64: body.base64Encoded === true }
    }
    let entries = networkFrom(state.events)
    if (options.urlPattern) {
      const needle = options.urlPattern.toLowerCase()
      entries = entries.filter((entry) => entry.url.toLowerCase().includes(needle))
    }
    const limit = options.limit && options.limit > 0 ? options.limit : 100
    return entries.slice(-limit)
  }

  /**
   * Any DevTools method, with its own parameters — the escape hatch that
   * makes the rest of this file a convenience rather than a ceiling.
   *
   * This is not a hole in the permission model: everything above is the same
   * protocol, and a plugin that may click a page may already read it. What
   * it does mean is that `browser: true` grants the *browser*, which the
   * consent string says in those words.
   */
  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const cdp = await this.reach()
    const result = await cdp.send(method, params)
    await pump(cdp)
    return result ?? null
  }

  /** The raw event stream, for a domain the methods above do not model. */
  async events(options: { method?: string; limit?: number } = {}): Promise<readonly CdpEvent[]> {
    const cdp = await this.reach()
    this.assertSubscribable(cdp, 'protocol events')
    let kept = state.events
    if (options.method) {
      const prefix = options.method
      kept = kept.filter((event) => event.method === prefix || event.method.startsWith(`${prefix}.`))
    }
    const limit = options.limit && options.limit > 0 ? options.limit : 200
    return kept.slice(-limit)
  }

  async close(): Promise<void> {
    state.events = []
    await engine().close()
  }

  // ---------------------------------------------------------------- private

  /** An engine that cannot subscribe says so; an empty list would be a lie. */
  private assertSubscribable(cdp: CdpSender, what: string): void {
    if (!cdp.drain) {
      throw new Error(
        `This browser engine cannot report ${what} — it answers commands but does not deliver events. ` +
          'The Browser pane and a separate Chrome window both can.',
      )
    }
  }

  /** A helper call in the page, with its JSON parsed and its throw preserved. */
  private async evaluateHelper(cdp: CdpSender, call: string): Promise<unknown> {
    const raw = await evaluateValue(cdp, callHelper(call))
    if (typeof raw !== 'string') return raw
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }

  private async locate(
    cdp: CdpSender,
    ref: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = (await this.evaluateHelper(cdp, `__hd.rect(${JSON.stringify(ref)})`)) as {
      x?: number
      y?: number
      width?: number
      height?: number
    } | null
    if (!box || typeof box.x !== 'number' || typeof box.y !== 'number') {
      throw new Error(`${ref} could not be located on this page.`)
    }
    return { x: box.x, y: box.y, width: box.width ?? 0, height: box.height ?? 0 }
  }

  /** A target becomes a point: a ref through the page, pixels through the ratio. */
  private async aim(cdp: CdpSender, target: PointerTarget): Promise<{ x: number; y: number }> {
    if ('ref' in target) {
      const box = await this.locate(cdp, target.ref)
      return { x: box.x, y: box.y }
    }
    const ratio = await deviceRatio(cdp)
    return { x: target.x / ratio, y: target.y / ratio }
  }

  private async centre(cdp: CdpSender): Promise<{ x: number; y: number }> {
    const size = (await evaluateValue(
      cdp,
      'JSON.stringify({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })',
    )) as string
    try {
      return JSON.parse(size) as { x: number; y: number }
    } catch {
      return { x: 200, y: 200 }
    }
  }

  private async pointerAt(cdp: CdpSender, x: number, y: number, options: PointerOptions): Promise<void> {
    const button = options.button ?? 'left'
    const clickCount = Math.min(Math.max(options.count ?? 1, 1), 3)
    const mask = modifierMask(options.modifiers ?? [])
    const base = { x, y, button, clickCount, ...(mask ? { modifiers: mask } : {}) }
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', clickCount: 0 })
    // A double click is two full press/release pairs with a rising count,
    // not one event that says "2" — the page counts the pairs.
    for (let press = 1; press <= clickCount; press += 1) {
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount: press })
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount: press })
    }
    await settle(300)
  }
}

// ------------------------------------------------------------------- events

/** Drains whatever the engine has buffered into the service's own ring. */
async function pump(cdp: CdpSender): Promise<void> {
  if (!cdp.drain) return
  let fresh: readonly CdpEvent[] = []
  try {
    fresh = await cdp.drain()
  } catch {
    return // A drain that fails must not fail the call that triggered it.
  }
  if (!fresh.length) return
  state.events.push(...fresh)
  if (state.events.length > EVENT_CAP) state.events.splice(0, state.events.length - EVENT_CAP)
}

/** One `Runtime.consoleAPICalled` argument, as the text a person would read. */
const argumentText = (argument: Record<string, unknown>): string => {
  if ('value' in argument) return typeof argument['value'] === 'string' ? argument['value'] : JSON.stringify(argument['value'])
  const preview = argument['preview'] as { properties?: { name: string; value?: string }[] } | undefined
  if (preview?.properties) {
    return `{ ${preview.properties.map((property) => `${property.name}: ${property.value ?? '…'}`).join(', ')} }`
  }
  return String(argument['description'] ?? argument['type'] ?? '')
}

/**
 * The shell's own voice, which is not the page's.
 *
 * A guest inside the desktop pane is an Electron `<webview>`, and Electron
 * logs its security advice into that guest's console. Reporting it as
 * something the page said would send an agent looking for a Content-Security
 * -Policy bug in code that has none. Observed 2026-08-24 in the pane; the
 * source URL is the only thing that distinguishes it, and it is enough.
 */
const isShellNoise = (url: string | undefined): boolean => url?.startsWith('node:electron/') === true

/** The console view, derived from the raw ring rather than kept beside it. */
const consoleFrom = (events: readonly CdpEvent[]): ConsoleEntry[] => {
  const out: ConsoleEntry[] = []
  for (const event of events) {
    if (event.method === 'Runtime.consoleAPICalled') {
      const args = (event.params['args'] as Record<string, unknown>[] | undefined) ?? []
      const frame = (
        event.params['stackTrace'] as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined
      )?.callFrames?.[0]
      if (isShellNoise(frame?.url)) continue
      out.push({
        level: String(event.params['type'] ?? 'log'),
        text: args.map(argumentText).join(' '),
        ...(frame?.url ? { url: frame.url } : {}),
        ...(frame?.lineNumber !== undefined ? { line: frame.lineNumber + 1 } : {}),
      })
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params['exceptionDetails'] as
        | { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } }
        | undefined
      out.push({
        level: 'error',
        text: details?.exception?.description ?? details?.text ?? 'an uncaught exception',
        ...(details?.url ? { url: details.url } : {}),
        ...(details?.lineNumber !== undefined ? { line: details.lineNumber + 1 } : {}),
      })
    } else if (event.method === 'Log.entryAdded') {
      const entry = event.params['entry'] as
        | { level?: string; text?: string; url?: string; lineNumber?: number }
        | undefined
      if (isShellNoise(entry?.url)) continue
      // The browser's own log: a blocked mixed-content load, a CSP refusal, a
      // 404 for a stylesheet. None of it reaches `console.log`, and all of it
      // is what the page is actually complaining about.
      out.push({
        level: String(entry?.level ?? 'info'),
        text: String(entry?.text ?? ''),
        ...(entry?.url ? { url: entry.url } : {}),
        ...(entry?.lineNumber !== undefined ? { line: entry.lineNumber + 1 } : {}),
      })
    }
  }
  return out
}

/** The network view: one row per request, folded from its four events. */
/**
 * Parameter names that carry a credential rather than describe a request.
 *
 * A token in a query string is the page's own defect — it is in the address
 * bar, the server's access log and the referer header before this file ever
 * sees it. But `browser_network` is where it would land in a *transcript*,
 * which outlives all three, so the values go and the names stay: an agent
 * debugging a request needs to know the parameter was sent and which one it
 * was, never what it said. `code` is in the list because an OAuth
 * authorization code is one exchange away from a session; a country code
 * redacted by mistake costs a moment's confusion, the other way costs an
 * account.
 */
const SECRET_PARAM = new Set([
  'password', 'passwd', 'pwd', 'pass', 'secret', 'token', 'access_token', 'id_token',
  'refresh_token', 'auth', 'authorization', 'apikey', 'api_key', 'key', 'otp', 'code',
  'credential', 'credentials', 'session', 'sessionid', 'session_id', 'jwt', 'sig', 'signature',
])

const secretParam = (name: string): boolean => {
  const lower = name.toLowerCase()
  return SECRET_PARAM.has(lower) || /[_-](token|secret|key|password|pwd)$/.test(lower)
}

/** The same URL with any credential-shaped query value replaced. */
const scrubUrl = (raw: string): string => {
  if (!raw.includes('?')) return raw
  try {
    const url = new URL(raw)
    let touched = false
    for (const name of [...url.searchParams.keys()]) {
      if (!secretParam(name)) continue
      url.searchParams.set(name, '(hidden)')
      touched = true
    }
    // Only re-serialise when something was actually redacted: searchParams
    // re-encodes the whole query, and a URL that changed shape without
    // changing meaning is a URL an agent cannot match against its own logs.
    return touched ? url.toString() : raw
  } catch {
    // Not a URL this runtime can parse (a data: or blob: with a stray "?").
    return raw
  }
}

const networkFrom = (events: readonly CdpEvent[]): NetworkEntry[] => {
  const rows = new Map<string, NetworkEntry>()
  for (const event of events) {
    const id = String(event.params['requestId'] ?? '')
    if (!id) continue
    const existing = rows.get(id)
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params['request'] as { method?: string; url?: string } | undefined
      rows.set(id, {
        requestId: id,
        method: String(request?.method ?? 'GET'),
        url: scrubUrl(String(request?.url ?? '')),
        ...(event.params['type'] ? { resourceType: String(event.params['type']) } : {}),
      })
    } else if (event.method === 'Network.responseReceived' && existing) {
      const response = event.params['response'] as
        | { status?: number; statusText?: string; mimeType?: string }
        | undefined
      rows.set(id, {
        ...existing,
        ...(response?.status !== undefined ? { status: response.status } : {}),
        ...(response?.statusText ? { statusText: response.statusText } : {}),
        ...(response?.mimeType ? { mimeType: response.mimeType } : {}),
      })
    } else if (event.method === 'Network.loadingFinished' && existing) {
      rows.set(id, { ...existing, bytes: Number(event.params['encodedDataLength'] ?? 0) })
    } else if (event.method === 'Network.loadingFailed' && existing) {
      rows.set(id, { ...existing, error: String(event.params['errorText'] ?? 'failed') })
    }
  }
  const out = [...rows.values()]
  return out.length > REQUEST_CAP ? out.slice(out.length - REQUEST_CAP) : out
}

/**
 * The keys `key` takes by name, and what each must look like to the page.
 *
 * One list, and the error a wrong name gets is written from it — because
 * the two were written separately once and disagreed. The message told
 * callers to press `space`; the table held only the literal `' '`. An agent
 * that read the message and retried with the word it was handed failed
 * again, and again, with no third thing to try. Observed on 2026-09-07, on
 * a game whose start screen read "PRESS SPACE OR CLICK TO START".
 *
 * `key` is what the DOM sees, which is not always what the caller typed: a
 * page listening for `event.key === ' '` has to receive the space itself,
 * so a name is a spelling of a key and never reaches the page as one.
 */
/**
 * The US-layout key under each character that is not a letter or a digit. A
 * shifted character names the key it is typed on (`?` is `Slash`); whether
 * Shift is held is the caller's to say.
 */
const PUNCTUATION_KEYS: Readonly<Record<string, readonly [code: string, keyCode: number]>> = {
  ',': ['Comma', 188], '<': ['Comma', 188],
  '.': ['Period', 190], '>': ['Period', 190],
  '/': ['Slash', 191], '?': ['Slash', 191],
  ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221],
  '\\': ['Backslash', 220], '|': ['Backslash', 220],
  '-': ['Minus', 189], '_': ['Minus', 189],
  '=': ['Equal', 187], '+': ['Equal', 187],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], $: ['Digit4', 52], '%': ['Digit5', 53],
  '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
}

/**
 * The DOM `code` and virtual key code of the key a character is typed on, for
 * a shortcut. `Key${upper}` was right for letters alone: ⌘1 went out as `Key1`
 * and ⌘, as `Key,`, neither of which is a key, so a page reading `event.code`
 * never saw the shortcut (#44). Null for a character off the US layout.
 */
export const characterKey = (character: string): { readonly code: string; readonly keyCode: number } | null => {
  if (/^[a-z]$/i.test(character)) {
    const upper = character.toUpperCase()
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(character)) return { code: `Digit${character}`, keyCode: character.charCodeAt(0) }
  const known = PUNCTUATION_KEYS[character]
  return known ? { code: known[0], keyCode: known[1] } : null
}

const NAMED_KEYS: Readonly<Record<string, { key: string; keyCode: number; code: string }>> = {
  Enter: { key: 'Enter', keyCode: 13, code: 'Enter' },
  Tab: { key: 'Tab', keyCode: 9, code: 'Tab' },
  Escape: { key: 'Escape', keyCode: 27, code: 'Escape' },
  Backspace: { key: 'Backspace', keyCode: 8, code: 'Backspace' },
  Delete: { key: 'Delete', keyCode: 46, code: 'Delete' },
  Home: { key: 'Home', keyCode: 36, code: 'Home' },
  End: { key: 'End', keyCode: 35, code: 'End' },
  PageUp: { key: 'PageUp', keyCode: 33, code: 'PageUp' },
  PageDown: { key: 'PageDown', keyCode: 34, code: 'PageDown' },
  ArrowLeft: { key: 'ArrowLeft', keyCode: 37, code: 'ArrowLeft' },
  ArrowUp: { key: 'ArrowUp', keyCode: 38, code: 'ArrowUp' },
  ArrowRight: { key: 'ArrowRight', keyCode: 39, code: 'ArrowRight' },
  ArrowDown: { key: 'ArrowDown', keyCode: 40, code: 'ArrowDown' },
  space: { key: ' ', keyCode: 32, code: 'Space' },
}

/** Every name `key` answers to, in the order it offers them. */
export const KEY_NAMES: readonly string[] = Object.keys(NAMED_KEYS)

const KEY_BY_FOLDED_NAME = new Map(
  Object.entries(NAMED_KEYS).map(([name, spec]) => [name.toLowerCase(), spec] as const),
)

/**
 * A caller's name for a key, as the event the page has to receive.
 *
 * Case folds, the way `modifierMask` below already folds `Cmd` and `cmd`: a
 * name that differs from the offer by its case is the same key, and
 * answering it with "unknown" starts the retry loop this exists to end. The
 * space character resolves here rather than falling through to the
 * single-character path, so a page that only listens for keydown hears one.
 */
export const namedKey = (key: string): { key: string; keyCode: number; code: string } | undefined =>
  KEY_BY_FOLDED_NAME.get(key === ' ' ? 'space' : key.toLowerCase())

/** What a name nobody has is answered with: this table, spelled out in full. */
export const unknownKeyMessage = (key: string): string =>
  `Unknown key ${JSON.stringify(key)} — use ${KEY_NAMES.join(', ')}, or a single character.`

/** CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifierMask = (modifiers: readonly string[]): number => {
  let mask = 0
  for (const modifier of modifiers) {
    switch (modifier.toLowerCase()) {
      case 'alt':
      case 'option':
        mask |= 1
        break
      case 'ctrl':
      case 'control':
        mask |= 2
        break
      case 'meta':
      case 'cmd':
      case 'command':
        mask |= 4
        break
      case 'shift':
        mask |= 8
        break
      default:
        throw new Error(`Unknown modifier ${JSON.stringify(modifier)} — use Alt, Ctrl, Meta or Shift.`)
    }
  }
  return mask
}

/** `Runtime.evaluate`, with the page's own throw turned into ours. */
async function evaluateValue(cdp: CdpSender, expression: string): Promise<unknown> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: unknown; description?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'the expression threw',
    )
  }
  return result.result?.value
}

// ------------------------------------------------------------ system browser

/** `open` on macOS, `start` on Windows, `xdg-open` elsewhere. */
const handToSystem = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]]
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', (error: Error) => reject(new Error(`The default browser could not be opened: ${error.message}`)))
    child.unref()
    resolve()
  })

/**
 * The default browser, which cannot be driven. Every tool but `browser_open`
 * fails here, and the message says what to change rather than what broke —
 * this is a setting, not a fault.
 */
const systemEngine: BrowserEngine = {
  ensure() {
    return Promise.reject(
      new Error(
        'Pages are set to open in your default browser, which HarnessDesk cannot see into or click. ' +
          'Only opening a page works. For screenshots, clicks and reading the page, ' +
          'set Settings → Browser → Pages open to “In HarnessDesk” or “In a separate window”.',
      ),
    )
  },
  close() {
    return Promise.resolve()
  },
}

// ------------------------------------------------------------ Chrome engine

/**
 * SIGTERM, then SIGKILL, then give up — resolving when the child is gone.
 *
 * The wait is the point. `close()` used to hang its profile sweep off the
 * child's `exit` event and return before that event, and both quit paths end
 * the process a moment later: `bin.ts` exits after the log flush, and the
 * desktop's `before-quit` calls `app.quit()`. Chrome takes longer to go than a
 * log flush takes, so the event reached a process that was no longer there and
 * the throwaway profile stayed on disk — exactly what "not kept" promises will
 * not happen (#243).
 *
 * Bounded twice, because a quit must not hang on a browser. The escalation to
 * SIGKILL is the one this already had; the second timer is for the case SIGKILL
 * cannot answer — a process wedged in uninterruptible I/O — after which the
 * sweep runs anyway, which is no worse than the old behaviour and no longer
 * the normal path.
 */
const stopped = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(escalate)
      clearTimeout(abandon)
      resolve()
    }
    child.once('exit', finish)
    const escalate = setTimeout(() => child.kill('SIGKILL'), 3_000)
    const abandon = setTimeout(finish, 5_000)
    escalate.unref()
    abandon.unref()
    child.kill('SIGTERM')
  })

/**
 * Test hook: the Chrome the next `close()` acts on, without starting one.
 *
 * `ensureChrome` fills these in for real. A test that wants to prove what
 * `close()` *waits* for cannot start a browser — a CI runner has none — and the
 * question is about the child's lifetime, which any child process can stand in
 * for.
 */
export const setChromeProcess = (child: ChildProcess | null, disposableDir: string | null): void => {
  state.child = child
  state.disposableDir = disposableDir
  state.profileDir = disposableDir
}

/** The user's own Chrome, headed, in a profile of its own — the headless host's engine. */
export const chromeEngine: BrowserEngine = {
  async ensure() {
    await ensureChrome()
    return {
      send: (method, params) => send(method, params ?? {}),
      drain: () => Promise.resolve(state.connection?.events.splice(0) ?? []),
    }
  },
  async close() {
    const child = state.child
    state.connection?.socket.close()
    state.connection = null
    state.child = null
    if (state.profileDir) rmSync(join(state.profileDir, 'DevToolsActivePort'), { force: true })
    // A profile that is not kept goes with the browser: nothing an agent
    // signed into outlives the session, which is what "not kept" promises.
    const disposable = state.disposableDir
    state.disposableDir = null
    /* Awaited, not hung off `exit` and forgotten. A browser that had already
       died resolves at once, which is the case the old code special-cased; the
       one it got wrong was the browser still running, because nothing waited
       for it and the process removing the profile was about to end (#243). */
    if (child) await stopped(child)
    if (disposable) rmSync(disposable, { recursive: true, force: true })
  },
}

async function ensureChrome(): Promise<void> {
    if (state.connection && state.connection.socket.readyState === WebSocket.OPEN) return
    state.connection = null

    // A browser the user *named* is not a hint. If it is not there, that is
    // the error — falling back to whatever else is installed would start a
    // different browser than the one they asked for and say nothing.
    // The messages name the rows as Settings › Browser draws them — "Which
    // browser", "Pages open" — because a person reads them to find the row.
    const chosen = process.env['HARNESSDESK_BROWSER_BINARY'] ?? state.settings.binary?.trim()
    if (chosen && !existsSync(chosen)) {
      throw new Error(
        `No browser was found at ${chosen}. Check Settings → Browser → Which browser.`,
      )
    }
    const binary = chosen ?? CHROME_PATHS.find((path) => existsSync(path))
    if (!binary) {
      throw new Error(
        'No Chrome or Chromium was found on this machine. Install Google Chrome, ' +
          'or name one under Settings → Browser → Which browser.',
      )
    }

    // A kept profile is the agent's own standing browser — its logins
    // survive a restart, and none of them are the person's. A profile that
    // is not kept is thrown away with the process, so nothing an agent
    // signs into outlives the session.
    // Kept: the desk's standing profile. Not kept: a directory made for this
    // browser and removed with it — its own, never the kept one, which used
    // to be reused whenever a kept browser had run first in the same host.
    const profile = join(
      process.env['HARNESSDESK_BROWSER_PROFILE'] ??
        (state.settings.keepProfile === false
          ? (state.disposableDir ??= disposableProfile())
          : (state.settings.profileDir ?? join(homedir(), '.harnessdesk', 'browser-profile'))),
    )
    mkdirSync(profile, { recursive: true })
    rmSync(join(profile, 'DevToolsActivePort'), { force: true })
    state.profileDir = profile

    if (!state.child || state.child.exitCode !== null) {
      state.child = spawn(
        binary,
        [
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          `--window-size=${VIEWPORT.width},${VIEWPORT.height + 88}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'ignore'], detached: false },
      )
      state.child.on('exit', () => {
        state.child = null
        state.connection = null
      })
    }

    // Chrome writes DevToolsActivePort once the debugger is listening.
    const port = await awaitPort(profile)
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string
      webSocketDebuggerUrl?: string
    }[]
    const target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome exposed no page to attach to.')

    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome did not accept the DevTools connection.')), CDP_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('The DevTools connection failed.'))
      })
    })

    const connection: CdpConnection = { socket, pending: new Map(), events: [], nextId: 0 }
    socket.addEventListener('message', (event) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      // No id and a method: this is the browser talking, not answering.
      if (message.id === undefined) {
        if (!message.method) return
        connection.events.push({ method: message.method, params: message.params ?? {} })
        if (connection.events.length > EVENT_CAP) connection.events.splice(0, connection.events.length - EVENT_CAP)
        return
      }
      const waiter = connection.pending.get(message.id)
      if (!waiter) return
      connection.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP error'))
      else waiter.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const waiter of connection.pending.values()) waiter.reject(new Error('Chrome closed the connection.'))
      connection.pending.clear()
      if (state.connection === connection) state.connection = null
    })
    state.connection = connection
    await send('Page.enable', {})
    await send('Runtime.enable', {})
    // Console and network are what makes this a debugger rather than a
    // remote control. A browser that refuses either still drives.
    await enableQuietly(['Log.enable', 'Network.enable'])
  }

/** Domains whose absence is a smaller loss than a failed `browser_open`. */
async function enableQuietly(methods: readonly string[]): Promise<void> {
  for (const method of methods) {
    try {
      await send(method, {})
    } catch {
      // An engine without this domain reports it at the read, by name.
    }
  }
}

async function awaitPort(profile: string): Promise<number> {
    const file = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + CDP_TIMEOUT_MS
    for (;;) {
      try {
        const port = Number(readFileSync(file, 'utf8').split('\n')[0])
        if (Number.isFinite(port) && port > 0) return port
      } catch {
        // not written yet
      }
      if (Date.now() > deadline) throw new Error('Chrome did not start its DevTools listener in time.')
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

function send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = state.connection
    if (!connection) return Promise.reject(new Error('No browser is open.'))
    const id = ++connection.nextId
    connection.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id)
        reject(new Error(`${method} timed out after ${CDP_TIMEOUT_MS}ms.`))
      }, CDP_TIMEOUT_MS)
      connection.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

/**
 * Device pixels per CSS pixel, asked of the page itself.
 *
 * Not cached: the browser pane's device presets change it under us, and a
 * stale ratio is a click in the wrong place — the failure this exists to
 * prevent. A page that will not answer is treated as 1, which is what every
 * non-Retina display reports anyway.
 */
async function deviceRatio(cdp: CdpSender): Promise<number> {
  try {
    const result = (await cdp.send('Runtime.evaluate', {
      expression: 'window.devicePixelRatio',
      returnByValue: true,
    })) as { result?: { value?: unknown } }
    const ratio = Number(result.result?.value)
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  } catch {
    return 1
  }
}

/** A short breath for the page to react; never a load-event wait that can hang. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Test hook: a throwaway profile under tmp, cleaned by the caller. */
export const disposableProfile = (): string =>
  // `mkdtemp`, not a timestamp: two browsers started in the same millisecond
  // were handed the same directory, and a profile shared by two Chromes is
  // one Chrome refusing to start.
  mkdtempSync(join(tmpdir(), 'hd-browser-'))
