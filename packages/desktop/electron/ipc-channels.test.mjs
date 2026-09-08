import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * The renderer bridge is a wire with two ends in different files, and
 * nothing type-checks across it: a channel renamed in `main.mjs` but not in
 * `preload.cjs` compiles, ships, and simply never fires. The browser pane
 * alone runs seven channels through it — the driven guest, the request to
 * front a tab, a screenshot, clearing data, a link a page tried to open —
 * and each silent failure looks like a different bug.
 *
 * So both ends are read as text and matched. This is a spelling test, not a
 * behaviour test; the behaviour needs a real Electron and belongs to the
 * app, not to `node --test`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, name), 'utf8')

const main = [read('main.mjs'), read('browser-engine.mjs')].join('\n')
const preload = read('preload.cjs')

const found = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]).sort()
const unique = (list) => [...new Set(list)]

const mainReceives = unique(found(main, /ipcMain\.(?:on|handle)\('([^']+)'/g))
const mainSends = unique(found(main, /webContents\.send\('([^']+)'/g))
const preloadSends = unique(found(preload, /ipcRenderer\.(?:send|invoke)\('([^']+)'/g))
const preloadReceives = unique(found(preload, /ipcRenderer\.on\('([^']+)'/g))

test('every channel the renderer speaks on is one the shell listens to', () => {
  assert.deepEqual(preloadSends, mainReceives)
})

test('every channel the shell speaks on is one the renderer listens to', () => {
  assert.deepEqual(mainSends, preloadReceives)
})

test('the browser pane’s own channels are all present', () => {
  // Named rather than counted, so removing one is a failing test and not a
  // quietly smaller number.
  for (const channel of ['harnessdesk:browser-ready', 'harnessdesk:browser-gone', 'harnessdesk:browser-links']) {
    assert.ok(mainReceives.includes(channel), `${channel} is not handled in the shell`)
  }
  for (const channel of ['harnessdesk:browser-save-screenshot', 'harnessdesk:browser-clear-data']) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `${channel} must answer, not just listen`)
  }
  for (const channel of ['harnessdesk:browser-show', 'harnessdesk:browser-close', 'harnessdesk:browser-focus', 'harnessdesk:browser-open-tab', 'harnessdesk:browser-download']) {
    assert.ok(mainSends.includes(channel), `${channel} is never sent`)
  }
  // A page's download is caught, not dropped: the guest sessions are watched
  // on attach, and the renderer may only reveal a file the shell saved.
  assert.match(main, /will-download/)
  assert.match(main.slice(main.indexOf("ipcMain.on('harnessdesk:browser-reveal-download'")), /downloadedPaths\.has\(path\)/)
})

test('the shell fronts the driven tab before it drives it', () => {
  // Chromium stops rasterising a <webview> nobody is looking at, so a driven
  // tab left behind another screenshots stale. `ensure` is the one place
  // every tool command passes through.
  const engine = read('browser-engine.mjs')
  const ensure = engine.slice(engine.indexOf('async ensure()'))
  assert.match(ensure.slice(0, 200), /front\(\)/, 'ensure() must front the driven tab')
})

test('a screenshot can only be taken of a tab the pane itself named', () => {
  // Otherwise the renderer could point the debugger at the app's own window.
  const shell = read('main.mjs')
  const handler = shell.slice(shell.indexOf("ipcMain.handle('harnessdesk:browser-save-screenshot'"))
  assert.match(handler.slice(0, 400), /browserEngine\.knows\(id\)/)
})

/**
 * The window-drag region, from the renderer's side.
 *
 * `-webkit-app-region: drag` is what lets a person move the window by its
 * chrome, and Electron computes it geometrically rather than by ancestry:
 * the header contributes one draggable rectangle, and *anything* drawn over
 * that rectangle is visible but inert unless it declares its own `no-drag`.
 * A right-click menu on a browser tab opened, looked right, and did nothing
 * for exactly this reason. The rule lives in the renderer's stylesheets but
 * the consequence is the shell's, so it is checked here, where the shell's
 * other window concerns are.
 */
const ui = join(here, '..', '..', 'ui', 'src', 'components')

test('floating panels opt out of the window-drag region', () => {
  for (const [file, rule] of [
    ['Popover.module.css', '.panel'],
    ['Menu.module.css', '.surface'],
  ]) {
    const css = readFileSync(join(ui, file), 'utf8')
    const from = css.indexOf(rule)
    assert.ok(from !== -1, `${file} has no ${rule}`)
    const block = css.slice(from, css.indexOf('}', from))
    assert.match(block, /-webkit-app-region:\s*no-drag/, `${file} ${rule} must be no-drag`)
  }
})

test('the browser pane puts its tab strip in a no-drag box', () => {
  // The strip sits where a pane title would, inside the drag region.
  const header = readFileSync(join(ui, 'ToolPaneHeader.tsx'), 'utf8')
  assert.match(header, /lead \?[\s\S]{0,120}hd-no-drag/, 'a header lead must be wrapped in hd-no-drag')
})
