/** Deterministic website loops. The camera and pointer live only in this recorder. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { COLLECT } from './audit.mjs'
import { auditSnapshots } from './stills.mjs'

const role = (role, name) => ({ role, name })
const css = selector => ({ selector })
const move = (at, target) => ({ at, kind: 'move', target })
const click = (at, target) => ({ at, kind: 'click', target })
const stage = (at, value) => ({ at, kind: 'stage', value })
const reset = { at: 7000, kind: 'reset' }
const scene = (preview, caption, actions) => ({ preview, width: 800, height: 500, scale: 2, duration: 8, fps: 24, caption, actions: [...actions, reset] })

export const CLIP_SCENES = {
  teams: scene('teams-table',
    'Teams settle, then the start preview shows the Brief, Task and three Seats.', [
      move(600, role('button', 'Open Retry the checkout call on a 502')), click(1400, role('button', 'Open Retry the checkout call on a 502')),
      move(2100, css('[data-site-start] textarea')), { at: 3300, kind: 'pan', value: true },
      move(4700, role('button', 'Start')), move(6000, role('button', 'Back to Teams')),
    ]),
  run: scene('run-short',
    'Write, review, request changes, repair, approve, then the person decides.', [stage(1100, 1), stage(2400, 2), stage(3600, 3), stage(4900, 4)]),
  race: scene('race-run',
    'Two attempts progress; the judge records Picked and Not kept.', [stage(2200, 1), stage(4200, 2)]),
  browser: scene('browser-tile',
    'A Seat’s Browser loads the local Acme storefront, scrolls and follows a link.', [
      { at: 900, kind: 'scroll', value: 20 }, move(2100, { ...role('link', 'Our story'), guest: true }),
      click(3100, { ...role('link', 'Our story'), guest: true }), { at: 4500, kind: 'scroll', value: 0 },
      move(5200, { ...role('link', 'Shop'), guest: true }), click(6200, { ...role('link', 'Shop'), guest: true }),
    ]),
  handoff: scene('handoff-dialog',
    'Choose Summary, Full transcript or Files changed, then rest on Hand off.', [
      move(600, role('radio', 'Full transcript')), click(1400, role('radio', 'Full transcript')),
      move(2400, role('radio', 'Files changed only')), click(3200, role('radio', 'Files changed only')),
      move(4200, role('radio', 'Summary')), click(5000, role('radio', 'Summary')), move(5600, role('button', 'Hand off to Reviewer')),
    ]),
  library: scene('library',
    'Select a skill to read its definition and see the agents that load it.', [
      move(800, css('button[aria-expanded]:has-text("code-review")')), click(1600, css('button[aria-expanded]:has-text("code-review")')),
      move(2700, role('button', 'Read the definition')), click(3500, role('button', 'Read the definition')),
      { at: 4300, kind: 'read' }, move(5700, role('button', 'Close')), click(6500, role('button', 'Close')),
    ]),
  permissions: scene('plugin-permissions',
    'Project docs shows its Tools and Access; the plugin is turned off and back on.', [
      move(900, role('switch', 'Disable Project docs')), click(1700, role('switch', 'Disable Project docs')),
      move(3700, role('switch', 'Enable Project docs')), click(4500, role('switch', 'Enable Project docs')),
    ]),
  dashboard: scene('dash-plans',
    'Plan limits, Spend, By agent and Year share the same placeholder history.', [
      { at: 1500, kind: 'cut', value: 'Spend' },
      { at: 3400, kind: 'cut', value: 'Activity' },
      { at: 4500, kind: 'select', value: 'By agent' },
      { at: 5900, kind: 'select', value: 'Year' },
    ]),
}

export const frameTimes = (duration, fps) => Array.from({ length: Math.round(duration * fps) }, (_, i) => i * 1000 / fps)
export const assertLoopClosed = (first, last) => {
  if (!first.equals(last)) throw new Error('The clip loop does not close: first and last frames differ.')
}
export const assertClipLimits = (clip, duration) => {
  if (!(clip.width === 1600 && clip.height === 1000 && clip.bytes > 0 && clip.bytes <= 1_500_000)
    || Math.abs(clip.duration - duration) > 1 / 24 || clip.codec !== 'h264' || clip.pixelFormat !== 'yuv420p' || clip.audio) {
    throw new Error(`The encoded clip exceeds its contract: ${JSON.stringify(clip)}`)
  }
}
export const assertTargetInCamera = (camera, box) => {
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  if (x < camera.x || x >= camera.x + camera.width || y < camera.y || y >= camera.y + camera.height) {
    throw new Error(`The real pointer target is outside the camera: ${JSON.stringify({ camera, box })}`)
  }
}

/** Guest DOM rects are in the iframe's CSS pixels, before the camera's zoom. */
export const guestTargetBox = (iframe, viewport, box) => ({
  x: iframe.x + box.x * iframe.width / viewport.width,
  y: iframe.y + box.y * iframe.height / viewport.height,
  width: box.width * iframe.width / viewport.width,
  height: box.height * iframe.height / viewport.height,
})

const targetBox = async (page, target) => {
  const element = locator(page, target)
  if (!target.guest) return element.boundingBox()
  const guest = await element.evaluate(node => ({ box: node.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight } }))
  return guestTargetBox(await page.locator('iframe').boundingBox(), guest.viewport, guest.box)
}

/** Protect any existing referenced asset, regardless of extension or directory alias. */
export const assertClipDestination = (app, destination) => {
  if (!existsSync(destination)) return
  const path = realpathSync(destination)
  const sources = directory => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? sources(file) : /\.(md|mdx|html)$/.test(entry.name) ? [file] : []
  }) : []
  for (const source of [join(app, 'README.md'), ...sources(join(app, 'docs'))]) {
    if (!existsSync(source)) continue
    const text = readFileSync(source, 'utf8')
    const refs = [
      ...[...text.matchAll(/(?:src|srcset|poster)=["']([^"']+)["']/g)].flatMap(match => match[1].split(/[\s,]+/)),
      ...[...text.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)].map(match => match[1] ?? match[2]),
      ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(match => match[1] ?? match[2]),
    ]
    for (const ref of refs) {
      const target = ref.split(/[?#]/)[0]
      const local = target.startsWith('/') ? resolve(app, `.${target}`) : resolve(dirname(source), target)
      if (existsSync(local) && realpathSync(local) === path) throw new Error(`${relative(app, path)} is referenced; capture with a new name.`)
      // Absolute public URLs also refer to committed images by repository path.
      if (/^https?:/.test(ref) && ref.includes(relative(app, path).replaceAll('\\', '/'))) throw new Error(`${relative(app, path)} is referenced; capture with a new name.`)
    }
  }
}

const ffmpegPath = () => process.env.HD_SHOTS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const ffmpeg = args => {
  try { return execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-threads', '1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { throw new Error(`ffmpeg failed: ${error.stderr?.toString() ?? error.message}`) }
}
const probe = file => JSON.parse(execFileSync(process.env.HD_SHOTS_FFPROBE ?? join(dirname(ffmpegPath()), 'ffprobe'),
  ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))
const locator = (page, target) => {
  const root = target.guest ? page.frameLocator('iframe') : page
  return target.selector ? root.locator(target.selector).first() : root.getByRole(target.role, { name: target.name, exact: true }).first()
}
const settle = async page => {
  // Promise effects settle outside the clock; rAF, layout and transitions are clock-owned.
  await page.evaluate(async () => { await document.fonts.ready })
  await page.clock.runFor(50)
}
const stagePage = (page, value) => page.evaluate(value => window.dispatchEvent(new CustomEvent('site-clip-stage', { detail: value })), value)

const prepare = async (page, name) => {
  if (name === 'library') await page.getByRole('radio', { name: 'Matrix', exact: true }).click()
  if (name === 'permissions') await page.getByRole('button', { name: /Project docs Find reference/ }).click()
  if (name === 'browser') await page.frameLocator('iframe').getByRole('heading', { name: 'A calmer checkout.' }).waitFor()
  await settle(page)
}
const restore = async (page, name) => {
  if (name === 'teams' && await page.getByRole('button', { name: 'Back to Teams', exact: true }).count()) await page.getByRole('button', { name: 'Back to Teams', exact: true }).click()
  if (name === 'run' || name === 'race') await stagePage(page, 0)
  if (name === 'library') {
    if (await page.getByRole('button', { name: 'Close', exact: true }).count()) await page.getByRole('button', { name: 'Close', exact: true }).click()
    const skill = page.locator('button[aria-expanded]:has-text("code-review")').first()
    if (await skill.getAttribute('aria-expanded') === 'true') await skill.evaluate(node => node.click())
  }
  if (name === 'permissions' && await page.getByRole('switch', { name: 'Enable Project docs', exact: true }).count()) await page.getByRole('switch', { name: 'Enable Project docs', exact: true }).click()
  if (name === 'dashboard') {
    await page.getByRole('button', { name: 'Plans', exact: true, includeHidden: true }).evaluate(node => node.click())
  }
  if (name === 'browser') await page.frames()[1].evaluate(() => { history.replaceState(null, '', '/storefront'); window.scrollTo(0, 0) })
  if (name === 'handoff') await page.getByRole('radio', { name: 'Summary', exact: true }).click()
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await settle(page)
}

const action = async (page, name, event) => {
  if (event.kind === 'read') await page.getByRole('heading', { name: 'Code review', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
  if (event.kind === 'select') await page.getByRole('radio', { name: event.value, exact: true, includeHidden: true }).evaluate(node => node.click())
  if (event.kind === 'cut') await page.getByRole('button', { name: event.value, exact: true, includeHidden: true }).evaluate(node => node.click())
  if (event.kind === 'stage') await stagePage(page, event.value)
  if (event.kind === 'click') {
    const target = locator(page, event.target)
    const box = await targetBox(page, event.target)
    if (!box || !await target.isVisible() || !await target.isEnabled()) throw new Error(`${name}: a click target is unavailable`)
    if (event.target.guest) assertTargetInCamera(await page.locator('iframe').boundingBox(), box)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    if (event.target.guest) {
      const href = await target.getAttribute('href')
      await page.frames()[1].waitForURL(url => url.hash === href)
    }
  }
  if (event.kind === 'scroll') {
    await page.frames()[1].evaluate(value => window.scrollTo(0, value), event.value)
    if (event.value > 0 && await page.frames()[1].evaluate(() => scrollY) === 0) throw new Error('The Browser fixture did not scroll')
  }
  if (event.kind === 'reset') await restore(page, name)
}

/** A fixed landscape camera; only the recorded surface is zoomed, never the app UI. */
export const setupCamera = async (page, name) => {
  await page.evaluate(name => { document.body.dataset.clipScene = name }, name)
  await page.addStyleTag({ content: `
    html, body { overflow: hidden !important; }
    [data-release-still], [data-slot="dialog-overlay"] { visibility: hidden; }
    [data-slot="app-window"] > div { grid-template-columns: minmax(0, 1fr) !important; }
    [data-slot="app-window-page"] { overflow: visible !important; }
    [aria-label="Window navigation"] { display: none !important; }
    [data-clip-surface] { position: fixed !important; margin: 0 !important; max-width: none !important;
      max-height: none !important; height: auto !important; transform: none !important; overflow: visible !important; }
    [data-clip-surface], [data-clip-surface] * { visibility: visible; }
    body[data-clip-scene="library"] [data-clip-surface] table { min-width: 0; table-layout: fixed; }
    body[data-clip-scene="library"] [data-clip-surface] th { width: 110px; }
    body[data-clip-scene="library"] [data-clip-surface] th:first-child { width: 230px; }
    body[data-clip-scene="library"] [data-clip-surface] th button { width: 210px; }
    body[data-clip-scene="permissions"] [data-clip-surface] [data-slot="form-stack"] { gap: 12px; }
    [data-clip-omit], [data-clip-omit] * { visibility: hidden !important; }
    body[data-clip-scene="dashboard"] [data-clip-surface] [role="group"][aria-label^="Tokens or cost per day"] { min-width: 0; }
    body[data-clip-scene="dashboard"] [data-clip-surface] [role="group"][aria-label*="per agent"] { height: 216px; }
    body[data-clip-scene="dashboard"] [data-clip-surface] [role="group"][aria-label$="this year"] { height: 254px; }
    body[data-clip-scene="dashboard"] [data-clip-surface] [role="group"][aria-label^="Tokens or cost per day"] :is([data-level], [data-state]) { aspect-ratio: auto; height: 100%; }
  ` })
  if (name === 'permissions') await page.getByText('About', { exact: true }).evaluate(node => node.closest('[data-section-head]')?.setAttribute('data-clip-omit', ''))
  // Widen the Teams page before measuring so the real responsive table is mounted.
  if (name === 'teams') await page.locator('[data-slot="teams-page"]').evaluate(node => { node.style.width = '736px' })
  await settle(page)
  if (name === 'teams') await page.locator('[data-slot="teams-page"] [data-slot="table-container"]').waitFor({ state: 'attached' })
}

export const focusCamera = async (page, name, pan, panToEnd = false) => {
  let selector, width = 600, zoom = 1.28, follow = false
  const dialogSelector = '[role="dialog"]:not([data-slot="app-window"])'
  const dialog = page.locator(dialogSelector)
  if (name === 'run' || name === 'race') {
    selector = '[aria-label="Run timeline"]'; width = name === 'run' ? 410 : 490; zoom = name === 'run' ? 1.85 : 1.55; follow = true
  } else if (name === 'teams') {
    selector = await dialog.count() ? dialogSelector : '[data-slot="teams-page"] [data-slot="table-container"]'
    width = 580; zoom = 1.32; follow = !!await dialog.count() && panToEnd
  } else if (name === 'library') {
    selector = await dialog.count() ? dialogSelector : '[data-release-still] [data-slot="table-container"]'
    follow = !await dialog.count()
  } else if (name === 'handoff') { selector = dialogSelector; width = 710; zoom = 1.08 }
  else if (name === 'permissions') { selector = '[data-release-still] [data-slot="pane-column"]'; width = 710; zoom = 1.08 }
  else if (name === 'browser') { selector = '[data-slot="side-by-side-tile"]'; width = 710; zoom = 1.08 }
  else {
    selector = await page.locator('[data-slot="plans-table"]').count() ? '[data-slot="plans-table"]'
      : await page.locator('[aria-label="What it cost"] [data-slot="chart-frame"]').count()
        ? '[aria-label="What it cost"] [data-slot="chart-frame"]' : '[aria-label="When it ran"] [data-slot="chart-frame"]'
    width = 680; zoom = 1.12
  }
  const target = page.locator(selector).first()
  if (!await target.count()) throw new Error(`${name}: missing camera subject: ${selector}`)
  return target.evaluate((node, { width, zoom, follow, pan, name }) => {
    for (const old of document.querySelectorAll('[data-clip-surface]')) if (old !== node) {
      old.removeAttribute('data-clip-surface'); old.removeAttribute('style')
    }
    const changed = !node.hasAttribute('data-clip-surface')
    node.setAttribute('data-clip-surface', '')
    Object.assign(node.style, { width: `${width}px`, zoom: String(zoom), left: `${(800 - width * zoom) / 2 / zoom}px` })
    if (node.matches('[data-slot="side-by-side-tile"]')) node.style.setProperty('height', `${468 / zoom}px`, 'important')
    if (name === 'library' && node.getAttribute('role') === 'dialog') node.style.setProperty('height', `${468 / zoom}px`, 'important')
    // Dialog content is normally bounded to the viewport by its own scroller.
    for (const child of node.querySelectorAll('[data-slot="modal-dialog-body"]')) child.style.maxHeight = 'none'
    const height = node.getBoundingClientRect().height
    const destination = follow ? Math.max(0, height - 468) : 0
    const offset = changed || pan === null ? destination : pan + (destination - pan) * 0.12
    node.style.top = `${(16 - offset - (document.body.dataset.clipScene === 'permissions' ? 60 : 0)) / zoom}px`
    return offset
  }, { width, zoom, follow, pan, name })
}

/** A temporary recording and its destination may be on different filesystems. */
export const publishClipFile = (source, destination, rename = renameSync) => {
  try { rename(source, destination) }
  catch (error) {
    if (error.code !== 'EXDEV') throw error
    copyFileSync(source, destination)
    rmSync(source)
  }
}

const pointer = async page => page.evaluate(() => {
  const pointer = document.createElement('div')
  pointer.dataset.clipPointer = ''
  pointer.setAttribute('aria-hidden', 'true')
  Object.assign(pointer.style, { position: 'fixed', width: '14px', height: '14px', borderRadius: '50%', background: '#fafafa',
    border: '1px solid #525252', boxShadow: '0 1px 3px #0003', pointerEvents: 'none', zIndex: '2147483647', transform: 'translate(-50%, -50%)' })
  document.body.append(pointer)
})
const pointAt = async (page, point) => {
  await page.mouse.move(point.x, point.y)
  await page.locator('[data-clip-pointer]').evaluate((node, point) => Object.assign(node.style, { left: `${point.x}px`, top: `${point.y}px` }), point)
}
const ease = t => t * t * (3 - 2 * t)

export const shootClips = async ({ app, out, requested = [], themes = ['light', 'dark'] }) => {
  const names = requested.length ? requested : Object.keys(CLIP_SCENES)
  if (themes.some(theme => !['light', 'dark'].includes(theme))) throw new Error('Clip theme must be light or dark')
  for (const name of names) {
    if (!CLIP_SCENES[name]) throw new Error(`No website clip named ${name}`)
    for (const theme of themes) for (const ext of ['mp4', 'webp', 'jpg']) assertClipDestination(app, join(out, `${name}-${theme}.${ext}`))
  }
  for (const file of ['clips.json', 'sheet.png']) assertClipDestination(app, join(out, file))
  const require = createRequire(join(app, 'packages/ui/package.json'))
  const { createServer } = await import(pathToFileURL(require.resolve('vite')))
  const { chromium, expect } = await import('@playwright/test')
  const scratch = mkdtempSync(join(tmpdir(), 'hd-site-clips-'))
  const results = [], contact = []
  let server, browser
  mkdirSync(out, { recursive: true })
  try {
    server = await createServer({ root: join(app, 'packages/ui'), server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
    await server.listen()
    const origin = server.resolvedUrls.local[0]
    browser = await chromium.launch({ headless: true })
    for (const name of names) for (const theme of themes) {
      const scene = CLIP_SCENES[name]
      const take = `${name}-${theme}`, frames = join(scratch, take)
      mkdirSync(frames)
      const page = await browser.newPage({ deviceScaleFactor: scene.scale, viewport: { width: scene.width, height: scene.height }, reducedMotion: 'reduce', timezoneId: 'America/Los_Angeles' })
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
      await page.route('**/*', route => {
        const url = route.request().url()
        if (url.startsWith(origin)) return route.continue()
        if (url.startsWith('https://acme.dev/')) return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(app, 'script/shots/fixtures/acme-storefront.html'), 'utf8') })
        return route.abort('blockedbyclient')
      })
      await page.clock.install({ time: new Date('2026-09-30T17:00:00Z') })
      await page.clock.pauseAt(new Date('2026-09-30T17:00:00Z'))
      await page.clock.setFixedTime(new Date('2026-09-30T17:00:00Z'))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${origin}preview.html?release-stills=${scene.preview}&site-clip&theme=${theme}`)
      await expect(page.locator('[data-release-still]')).toBeVisible()
      await expect(page.locator('body[data-hd-dark-theme]')).toHaveCount(theme === 'dark' ? 1 : 0)
      await prepare(page, name)
      process.stdout.write(`Prepared ${take}\n`)
      await setupCamera(page, name)
      let panToEnd = false
      let pan = await focusCamera(page, name, null)
      const clip = { x: 0, y: 0, width: scene.width, height: scene.height }
      process.stdout.write(`Camera ${take}: ${clip.width}×${clip.height}\n`)
      await pointer(page)
      const rest = { x: clip.x + clip.width - 20, y: clip.y + clip.height - 20 }
      let point = rest, path = null, next = 0, previous = 0
      await pointAt(page, rest)
      const times = frameTimes(scene.duration, scene.fps)
      let first, last
      for (const [index, time] of times.entries()) {
        await page.clock.runFor(time - previous)
        previous = time
        while (next < scene.actions.length && scene.actions[next].at <= time) {
          const event = scene.actions[next++]
          if (event.kind === 'move') {
            const box = await targetBox(page, event.target)
            if (!box) throw new Error(`${take}: pointer target is absent`)
            try { assertTargetInCamera(clip, box) } catch (error) { throw new Error(`${take} at ${event.at}: ${JSON.stringify(event.target)}: ${error.message}`) }
            if (event.target.guest) assertTargetInCamera(await page.locator('iframe').boundingBox(), box)
            path = { at: time, from: point, to: { x: box.x + box.width / 2, y: box.y + box.height / 2 } }
          } else {
            if (event.kind === 'pan') panToEnd = event.value
            if (event.kind === 'reset') panToEnd = false
            if (event.kind === 'click') assertTargetInCamera(clip, await targetBox(page, event.target))
            await action(page, name, event)
            pan = await focusCamera(page, name, event.kind === 'reset' ? null : pan, panToEnd)
            if (event.kind === 'reset') path = { at: time, from: point, to: rest }
          }
        }
        // The closing hold reconstructs the exact opening camera after React settles.
        pan = await focusCamera(page, name, time >= scene.actions.at(-1).at ? null : pan, panToEnd)
        if (path) {
          const t = ease(Math.min(1, (time - path.at) / 600))
          point = { x: path.from.x + (path.to.x - path.from.x) * t, y: path.from.y + (path.to.y - path.from.y) * t }
          await pointAt(page, point)
        }
        auditSnapshots(await Promise.all(page.frames().map(frame => frame.evaluate(COLLECT))))
        if (errors.length) throw new Error(`${take}: preview rendering errors; no frame saved: ${errors.join('; ')}`)
        const pixels = await page.screenshot({ clip, animations: 'disabled' })
        if (index === 0) first = pixels
        last = pixels
        writeFileSync(join(frames, `${String(index).padStart(4, '0')}.png`), pixels)
      }
      assertLoopClosed(first, last)
      const video = join(frames, `${take}.mp4`)
      ffmpeg(['-framerate', String(scene.fps), '-i', join(frames, '%04d.png'), '-vf', 'scale=min(1600\\,iw):-2',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', video])
      const info = probe(video), stream = info.streams.find(stream => stream.codec_type === 'video')
      const bytes = statSync(video).size, duration = Number(info.format.duration)
      assertClipLimits({ width: stream.width, height: stream.height, bytes, duration, codec: stream.codec_name, pixelFormat: stream.pix_fmt, audio: info.streams.some(stream => stream.codec_type === 'audio') }, scene.duration)
      ffmpeg(['-i', join(frames, '0000.png'), '-vf', 'scale=min(1600\\,iw):-2', '-frames:v', '1', '-q:v', '2', join(frames, `${take}.jpg`)])
      ffmpeg(['-i', join(frames, '0000.png'), '-vf', 'scale=min(1600\\,iw):-2', '-frames:v', '1', join(frames, 'poster.png')])
      // The supplied ffmpeg build has no WebP encoder; use the installed WebP tool.
      execFileSync(process.env.HD_SHOTS_CWEBP ?? '/opt/homebrew/bin/cwebp', ['-quiet', '-q', '86', join(frames, 'poster.png'), '-o', join(frames, `${take}.webp`)])
      for (const ext of ['mp4', 'webp', 'jpg']) {
        const destination = join(out, `${take}.${ext}`)
        assertClipDestination(app, destination)
        publishClipFile(join(frames, `${take}.${ext}`), destination)
      }
      for (const [label, index] of [['first', 0], ['middle', Math.floor(times.length / 2)], ['last', times.length - 1]]) {
        contact.push({ take, label, pixels: readFileSync(join(frames, `${String(index).padStart(4, '0')}.png`)).toString('base64') })
      }
      results.push({ scene: name, theme, logicalSize: { width: clip.width, height: clip.height }, scale: scene.scale, fps: scene.fps,
        duration, width: stream.width, height: stream.height, bytes, caption: scene.caption,
        loop: { first: createHash('sha256').update(first).digest('hex'), last: createHash('sha256').update(last).digest('hex') } })
      process.stdout.write(`Audited ${take}: ${stream.width}×${stream.height}, ${duration}s, ${bytes} bytes; loop closed\n`)
      await page.close()
      rmSync(frames, { recursive: true, force: true })
    }
    const sheet = await browser.newPage({ viewport: { width: 960, height: 800 }, deviceScaleFactor: 1 })
    await sheet.setContent(`<style>body{margin:0;background:white;color:#333;font:13px system-ui}main{display:grid;grid-template-columns:repeat(3,320px)}figure{margin:0;padding:8px;height:244px;box-sizing:border-box;border:1px solid #ddd}figcaption{height:20px}img{width:304px;height:208px;object-fit:contain}</style><main>${contact.map(frame => `<figure><figcaption>${frame.take} · ${frame.label}</figcaption><img src="data:image/png;base64,${frame.pixels}"></figure>`).join('')}</main>`)
    auditSnapshots([await sheet.evaluate(COLLECT)])
    await sheet.screenshot({ path: join(scratch, 'sheet.png'), fullPage: true })
    await sheet.close()
    assertClipDestination(app, join(out, 'sheet.png'))
    publishClipFile(join(scratch, 'sheet.png'), join(out, 'sheet.png'))
    assertClipDestination(app, join(out, 'clips.json'))
    writeFileSync(join(out, 'clips.json'), `${JSON.stringify(results, null, 2)}\n`)
    return results
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}
