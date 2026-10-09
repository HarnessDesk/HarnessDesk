/** Focused, headless embedding proof and publishable frames of the real preview. */
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { SCENES } from '../packages/ui/site-demo/scenes.ts'
import { COLLECT, textReasons } from './shots/audit.mjs'

const app = resolve(import.meta.dirname, '..')
const out = join(app, '.lead-out/site-scenes')
mkdirSync(out, { recursive: true })
const require = createRequire(join(app, 'packages/ui/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const preview = await createServer({ root: join(app, 'packages/ui'), server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
const dist = join(app, 'packages/ui/dist-site-demo')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const built = httpServer((request, response) => {
  const file = resolve(dist, `.${new URL(request.url, 'http://localhost').pathname}`)
  try {
    if (file !== dist && !file.startsWith(`${dist}/`)) throw new Error('Outside the build')
    const target = file === dist || file === `${dist}/` ? join(dist, 'index.html') : file
    response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream' })
    response.end(readFileSync(target))
  } catch { response.writeHead(404); response.end() }
})
let browser
const frames = []
try {
  await preview.listen()
  await new Promise(done => built.listen(0, '127.0.0.1', done))
  const previewOrigin = preview.resolvedUrls.local[0]
  const buildOrigin = `http://127.0.0.1:${built.address().port}/`
  browser = await chromium.launch({ headless: true })
  const stamp = new Date('2026-10-08T17:00:00Z')
  for (const [name, scene] of Object.entries(SCENES)) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: scene.width, height: scene.height }, timezoneId: 'America/Los_Angeles', colorScheme: theme })
    const errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => { if (!request.url().startsWith(buildOrigin) && !request.url().startsWith(previewOrigin) && !request.url().startsWith('data:')) external.push(request.url()) })
    await page.clock.install({ time: stamp })
    await page.clock.pauseAt(stamp)
    await page.clock.setFixedTime(stamp)
    const sceneBox = page.locator('[data-site-scene]')
    const stage = page.locator('[data-scene-stage]')
    const settle = async () => { await page.evaluate(() => new Promise(done => queueMicrotask(done))); await page.clock.runFor(32) }
    const geometry = async () => {
      const measured = await sceneBox.evaluate(box => {
        const rect = box.getBoundingClientRect()
        const bad = [...box.querySelectorAll('[data-slot="chart-frame"], table, [role="radiogroup"]')].filter(node => {
          const one = node.getBoundingClientRect()
          return one.width && (one.x < rect.x || one.right > rect.right + 1 || one.bottom > rect.bottom + 1)
        }).map(node => ({ label: node.getAttribute('aria-label') ?? node.tagName, rect: node.getBoundingClientRect().toJSON() }))
        return { width: rect.width, height: rect.height, scrollX, scrollY, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight, bad }
      })
      if (measured.bad.length) await sceneBox.screenshot({ path: join(out, 'geometry-failure.png') })
      assert.deepEqual(measured, { width: scene.width, height: scene.height, scrollX: 0, scrollY: 0, pageWidth: scene.width, pageHeight: scene.height, bad: [] })
    }
    const shot = async label => {
      await geometry()
      const reasons = textReasons(await page.evaluate(COLLECT))
      assert.deepEqual(reasons, [], `Unpublishable ${name}/${theme}/${label}`)
      const file = `${name}-${theme}-${label}.png`
      const buffer = await sceneBox.screenshot({ path: join(out, file), animations: 'disabled' })
      frames.push({ file, label: `${theme} · ${label}`, buffer })
      return buffer
    }
    // Test the production build, then photograph the identical preview harness scene.
    await page.goto(`${buildOrigin}?view=${name}&theme=${theme}`)
    await page.clock.runFor(600)
    assert.deepEqual(errors, [], 'Build boot errors')
    await expect(stage).toHaveAttribute('data-scene-stage', 'limits')
    await settle()
    await geometry()
    await page.clock.fastForward(5000)
    await expect(stage).toHaveAttribute('data-scene-stage', 'limits')
    await page.evaluate(() => postMessage({ type: 'visible', value: true }, '*'))
    await page.clock.runFor(4500)
    await expect(stage).toHaveAttribute('data-scene-stage', 'spend')
    await page.evaluate(() => postMessage({ type: 'visible', value: false }, '*'))
    await settle()
    const paused = await sceneBox.screenshot()
    await page.clock.fastForward(20_000)
    assert.ok(paused.equals(await sceneBox.screenshot()), 'Hidden scenes must freeze')
    await page.evaluate(value => postMessage({ type: 'theme', value }, '*'), theme === 'light' ? 'dark' : 'light')
    await expect(page.locator('body[data-hd-dark-theme]')).toHaveCount(theme === 'light' ? 1 : 0)

    await page.goto(`${previewOrigin}preview.html?site-scene=${name}&theme=${theme}`)
    await page.clock.runFor(600)
    assert.deepEqual(errors, [], 'Preview boot errors')
    await expect(stage).toHaveAttribute('data-scene-stage', 'limits')
    await settle()
    const first = await shot('first')
    await page.evaluate(() => postMessage({ type: 'visible', value: true }, '*'))
    await page.clock.runFor(4600)
    await expect(stage).toHaveAttribute('data-scene-stage', 'spend')
    const spend = await shot('spend')
    assert.ok(!first.equals(spend), 'Scene must change over time')
    await page.clock.runFor(4400)
    await expect(stage).toHaveAttribute('data-scene-stage', 'agents')
    await expect(sceneBox.getByRole('radio', { name: 'By agent', exact: true })).toHaveAttribute('aria-checked', 'true')
    await shot('middle')
    await page.clock.runFor(4000)
    await expect(sceneBox.getByRole('radio', { name: 'Year', exact: true })).toHaveAttribute('aria-checked', 'true')
    await shot('last')
    // Screenshot settling also advances animation frames. Measure the scene
    // position rather than treating capture time as part of the script's delay.
    const position = Number(await sceneBox.getAttribute('data-scene-time'))
    await page.clock.runFor(scene.duration - position + 64)
    await expect(stage).toHaveAttribute('data-scene-stage', 'limits')
    await page.evaluate(() => postMessage({ type: 'visible', value: false }, '*'))
    await settle()
    const loop = await sceneBox.screenshot({ animations: 'disabled' })
    if (!first.equals(loop)) {
      writeFileSync(join(out, `${name}-${theme}-loop-failure.png`), loop)
      console.error(`Loop capture at ${await sceneBox.getAttribute('data-scene-time')} ms`)
    }
    assert.ok(first.equals(loop), 'The loop must return to the first frame')

    for (const explicit of [true, false]) {
      await page.emulateMedia({ reducedMotion: explicit ? 'no-preference' : 'reduce' })
      await page.goto(`${buildOrigin}?view=${name}&theme=${theme}${explicit ? '&motion=reduce' : ''}`)
      await page.clock.runFor(600)
      await expect(stage).toHaveAttribute('data-scene-stage', 'year')
      await settle()
      const still = await sceneBox.screenshot()
      await page.evaluate(() => postMessage({ type: 'visible', value: true }, '*'))
      await page.clock.fastForward(60_000)
      assert.ok(still.equals(await sceneBox.screenshot()), 'Reduced motion must stay static')
    }
    assert.deepEqual(external, [], 'The embed made an external request')
    assert.deepEqual(errors, [], 'Scene boot or playback errors')
    await page.close()
    console.log(`PASS ${name}/${theme}: paused boot, theme, change, loop, static reduced motion, geometry, local requests`)
  }

  // A small parent checks the page-owned transform without changing the logical viewport.
  const embed = await browser.newPage({ viewport: { width: 480, height: 300 } })
  await embed.setContent(`<style>html,body{margin:0;overflow:hidden}iframe{width:960px;height:600px;border:0;transform:scale(.5);transform-origin:0 0}</style><iframe src="${buildOrigin}?view=dashboard&motion=reduce"></iframe>`)
  await expect(embed.frameLocator('iframe').locator('[data-site-scene]')).toHaveCSS('width', '960px')
  assert.deepEqual(await embed.locator('iframe').boundingBox(), { x: 0, y: 0, width: 480, height: 300 })
  await embed.close()
  const sheet = await browser.newPage({ viewport: { width: 1440, height: 692 } })
  await sheet.setContent(`<style>body{margin:0;background:#eee;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(3,480px)}figure{margin:0}figcaption{padding:8px;height:20px}img{width:480px;height:300px;display:block}</style><main>${frames.filter(frame => !frame.file.includes('-spend')).map(frame => `<figure><figcaption>${frame.label}</figcaption><img src="data:image/png;base64,${frame.buffer.toString('base64')}"></figure>`).join('')}</main>`)
  await sheet.screenshot({ path: join(out, 'sheet.png') })
  writeFileSync(join(out, 'report.json'), JSON.stringify({ views: Object.keys(SCENES), themes: ['light', 'dark'], frames: frames.map(frame => frame.file), passed: true }, null, 2))
  console.log('PASS iframe scaling; contact sheet and frames written to .lead-out/site-scenes')
} finally {
  await browser?.close()
  await preview.close()
  await new Promise(done => built.close(done))
}
