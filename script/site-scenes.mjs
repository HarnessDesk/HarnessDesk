/** Focused headless interaction proof and publishable frames of the real preview. */
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { SCENES } from '../packages/ui/site-demo/scenes.ts'
import { COLLECT, textReasons } from './shots/audit.mjs'
import { assertSiteIdentities } from './site-scenes-identities.mjs'

const app = resolve(import.meta.dirname, '..')
const out = join(app, '.lead-out/site-scenes')
mkdirSync(out, { recursive: true })
const require = createRequire(join(app, 'packages/ui/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const preview = await createServer({ root: join(app, 'packages/ui'), server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
const dist = join(app, 'packages/ui/dist-site-demo')
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
const bundle = files(dist).filter(file => extname(file) === '.js').map(file => readFileSync(file, 'utf8')).join('\n')
const addresses = assertSiteIdentities(bundle)
for (const address of ['shane@harnessdesk.app', 'olivia@harnessdesk.app']) assert.ok(addresses.includes(address), `Build lost demo persona: ${address}`)
console.log(`PASS built-bundle identity scan: ${addresses.join(', ')}`)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const built = httpServer((request, response) => {
  const file = resolve(dist, `.${new URL(request.url, 'http://localhost').pathname}`)
  try {
    if (file !== dist && !file.startsWith(`${dist}/`)) throw new Error('Outside the build')
    const target = file === dist ? join(dist, 'index.html') : file
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
  const stamp = new Date('2026-10-08T13:30:00-07:00')
  for (const [name, scene] of Object.entries(SCENES)) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: scene.width, height: scene.height }, timezoneId: 'America/Los_Angeles', colorScheme: theme })
    const errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => { if (![buildOrigin, previewOrigin].some(origin => request.url().startsWith(origin)) && !request.url().startsWith('data:')) external.push(request.url()) })
    await page.clock.install({ time: stamp })
    await page.clock.pauseAt(stamp)
    await page.clock.setFixedTime(stamp)
    const sceneBox = page.locator('[data-site-scene]')
    const cost = page.getByRole('region', { name: 'What it cost', exact: true })
    const breakdown = page.getByRole('region', { name: 'Where it went', exact: true })
    const accounts = page.getByRole('region', { name: 'What is left', exact: true })
    const year = page.getByRole('region', { name: 'When it ran', exact: true })
    const settle = async () => { await page.clock.runFor(64); await page.evaluate(() => new Promise(done => queueMicrotask(done))) }
    const geometry = async () => {
      await expect(sceneBox).toHaveAttribute('data-site-scene', name)
      const measured = await sceneBox.evaluate(box => {
        const rect = box.getBoundingClientRect()
        const bad = [...box.querySelectorAll('table, [data-section-head], [data-slot="chart-frame"], [role="group"]')].filter(node => {
          const one = node.getBoundingClientRect()
          return one.width && (one.x < rect.x || one.right > rect.right + 1)
        }).map(node => node.getBoundingClientRect().toJSON())
        return { width: rect.width, height: rect.height, scrollWidth: box.scrollWidth, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight, bad }
      })
      assert.deepEqual(measured, { width: scene.width, height: scene.height, scrollWidth: scene.width, pageWidth: scene.width, pageHeight: scene.height, bad: [] })
    }
    const scrollTo = async section => {
      await section.evaluate(node => {
        const box = node.closest('[data-site-scene]')
        const heading = node.getAttribute('aria-label') === 'What is left' ? node.previousElementSibling : node
        box.scrollTop += heading.getBoundingClientRect().top - box.getBoundingClientRect().top - 24
      })
      await settle()
    }
    const shot = async label => {
      await geometry()
      assert.deepEqual(textReasons(await page.evaluate(COLLECT)), [], `Unpublishable ${name}/${theme}/${label}`)
      await page.mouse.move(2, 2)
      await settle()
      const file = `${name}-${theme}-${label}.png`
      const buffer = await sceneBox.screenshot({ path: join(out, file), animations: 'disabled' })
      frames.push({ file, label: `${name} · ${theme} · ${label}`, width: scene.width, height: scene.height, buffer })
    }
    const exerciseDashboard = async capture => {
      await expect(cost).toBeVisible()
      assert.equal(await sceneBox.evaluate(box => box.scrollTop), 0, 'Must open at the top')
      await expect(sceneBox.locator('[data-scene-pointer]')).toHaveCount(0)
      await expect(cost.getByText('Rescan', { exact: true })).toHaveCount(0)
      await expect(cost).not.toContainText('days scanned')
      await expect(year.locator('[data-state="not-scanned"]')).toHaveCount(0)
      await expect(accounts).toContainText('shane@harnessdesk.app')
      await expect(accounts).toContainText('olivia@harnessdesk.app')
      await expect(accounts.locator('tbody > tr')).toHaveCount(6)
      assert.ok(await breakdown.locator('[data-slot="section-name"]').evaluate(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const title = range.getBoundingClientRect()
        const controls = node.closest('[data-section-head]').querySelector('[role="radiogroup"]').getBoundingClientRect()
        return title.bottom <= controls.top + 1 || title.right <= controls.left + 1
      }), 'Breakdown title must fit without clipping')
      const before = await cost.innerHTML()
      await cost.getByRole('radio', { name: 'Line', exact: true }).click()
      await expect(cost.getByRole('radio', { name: 'Line', exact: true })).toHaveAttribute('aria-checked', 'true')
      assert.notEqual(await cost.innerHTML(), before)
      await breakdown.getByRole('radio', { name: 'by model', exact: true }).click()
      await expect(breakdown).toContainText('claude-opus-5-5')
      await expect(breakdown).toContainText('Other · 34')
      await cost.getByRole('radio', { name: 'Bars', exact: true }).click()
      await settle()
      if (capture) await shot('top')
      // Hovering the actual plot shows its local day tooltip.
      const plot = cost.locator('[role="group"]').first()
      await plot.hover({ position: { x: 160, y: 70 } })
      await expect(cost.locator('[data-slot="chart-tip"]')).toBeVisible()
      await page.mouse.move(2, 2)
      await breakdown.getByRole('radio', { name: 'by project', exact: true }).click()
      await expect(breakdown).toContainText('storefront')
      await breakdown.getByRole('radio', { name: 'by agent', exact: true }).click()
      await expect(breakdown).toContainText('Claude Code')
      await cost.getByRole('radio', { name: '7d', exact: true }).click()
      await expect(cost).toContainText('Last 7 days')
      await cost.getByRole('radio', { name: '30d', exact: true }).click()
      const firstAccount = accounts.getByRole('button', { name: /Details for shane/ })
      await firstAccount.click()
      await expect(firstAccount).toHaveAttribute('aria-expanded', 'true')
      await expect(accounts).toContainText('Value')
      await expect(accounts).toContainText('$3,148')
      await expect(accounts).toContainText('runs out')
      await scrollTo(accounts)
      if (capture) await shot('accounts')
      const scrolled = await sceneBox.evaluate(box => box.scrollTop)
      assert.ok(scrolled > 0, 'Account controls must scroll the internal window')
      await firstAccount.click()
      await page.mouse.move(450, 480)
      const beforeWheel = await sceneBox.evaluate(box => box.scrollTop)
      await page.mouse.wheel(0, 700)
      await settle()
      await expect.poll(() => sceneBox.evaluate(box => box.scrollTop)).toBeGreaterThan(beforeWheel)
      assert.equal(await page.evaluate(() => scrollY), 0, 'Wheel must not scroll the parent page')
      await scrollTo(year)
      await expect(year.getByRole('radio', { name: 'Year', exact: true })).toHaveAttribute('aria-checked', 'true')
      await expect(year).toContainText('141.6B')
      await expect(year).toContainText('active of 365 scanned')
      await expect(year).toContainText('streak · best 61')
      const heat = year.getByRole('group', { name: 'Tokens or cost per day, this year', exact: true })
      const cell = await heat.locator('[data-level]').first().boundingBox()
      assert.ok(Math.abs(cell.width - cell.height) <= 1, 'Calendar cells must stay square')
      const lastLabel = heat.locator(':scope > span[aria-hidden="true"]').last()
      const labelBounds = await lastLabel.boundingBox(), heatBounds = await heat.boundingBox()
      assert.ok(labelBounds.x + labelBounds.width <= heatBounds.x + heatBounds.width + 1, 'Final month label must fit')
      if (capture) await shot('year')
      await year.getByRole('radio', { name: 'By agent', exact: true }).click()
      await expect(year.getByRole('group', { name: 'Tokens or cost per day, per agent, last 13 weeks', exact: true })).toBeVisible()
      await year.getByRole('radio', { name: 'By hour', exact: true }).click()
      await expect(year).toContainText('141.6B')
      await year.getByRole('radio', { name: 'Calls', exact: true }).click()
      await expect(year).toContainText('calls this year')
      await page.evaluate(() => postMessage({ type: 'visible', value: true }, '*'))
      await page.clock.fastForward(20_000)
      await expect(year.getByRole('radio', { name: 'By hour', exact: true })).toHaveAttribute('aria-checked', 'true')
      await page.evaluate(() => postMessage({ type: 'visible', value: false }, '*'))
      await year.getByRole('radio', { name: 'Year', exact: true }).click()
      await expect(year.getByRole('radio', { name: 'Year', exact: true })).toHaveAttribute('aria-checked', 'true')
    }
    const fit = async () => {
      await geometry()
      const height = await sceneBox.evaluate(box => ({ content: box.scrollHeight, panel: box.clientHeight }))
      assert.ok(height.content <= height.panel, `${name} must fit without vertical scrolling: ${height.content} > ${height.panel}`)
      assert.deepEqual(await sceneBox.locator('[role="group"]').evaluateAll(groups => groups.filter(group => group.scrollWidth > group.clientWidth + 1).map(group => group.getAttribute('aria-label'))), [], 'Plots must fit without horizontal scrolling')
    }
    const heatGeometry = async label => {
      await fit()
      const facts = await year.locator('[data-slot="chart-card"]').first().evaluate(card => [...card.children].map(node => node.getBoundingClientRect().top))
      assert.ok(facts.every(top => Math.abs(top - facts[0]) <= 1), 'Activity stats must fit on one row')
      const heat = year.getByRole('group', { name: label, exact: true })
      const bounds = await heat.boundingBox()
      assert.ok(bounds.x >= 20 && bounds.x + bounds.width <= scene.width - 20, 'Heatmap must keep the panel gutter')
      assert.ok(await heat.locator('[data-level]').evaluateAll(cells => cells.every(cell => {
        const rect = cell.getBoundingClientRect()
        return rect.width > 0 && Math.abs(rect.width - rect.height) <= 0.1
      })), 'Every heatmap cell must stay square')
      const labels = await heat.locator(':scope > span[aria-hidden="true"]').all()
      for (const label of labels) {
        const rect = await label.boundingBox()
        assert.ok(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width + 1, 'Heatmap labels must fit')
      }
    }
    const exerciseFocused = async capture => {
      assert.equal(await sceneBox.evaluate(box => box.scrollTop), 0, 'Must open at the top')
      await expect(sceneBox.locator('[data-scene-pointer]')).toHaveCount(0)
      assert.ok(await sceneBox.evaluate(box => {
        const style = getComputedStyle(box)
        return style.borderWidth === '0px' && style.borderRadius === '0px'
      }), 'The website owns the panel frame')
      const sections = await sceneBox.locator('section[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
      assert.deepEqual(sections, [name === 'dashboard-spend' ? 'What it cost' : name === 'dashboard-limits' ? 'What is left' : 'When it ran'])
      if (name === 'dashboard-spend') {
        await expect(cost.getByText('Rescan', { exact: true })).toHaveCount(0)
        await expect(cost).not.toContainText('days scanned')
        const before = await cost.innerHTML()
        await cost.getByRole('radio', { name: 'Line', exact: true }).click()
        await expect(cost.getByRole('radio', { name: 'Line', exact: true })).toHaveAttribute('aria-checked', 'true')
        assert.notEqual(await cost.innerHTML(), before)
        await fit()
        await cost.getByRole('radio', { name: 'Bars', exact: true }).click()
        for (const range of [7, 90, 30]) {
          await cost.getByRole('radio', { name: `${range}d`, exact: true }).click()
          await expect(cost).toContainText(`Last ${range} days`)
          await fit()
        }
        const plot = cost.locator('[role="group"]').first()
        await plot.hover({ position: { x: 160, y: 70 } })
        await expect(cost.locator('[data-slot="chart-tip"]')).toBeVisible()
      } else if (name === 'dashboard-limits') {
        await fit()
        await expect(accounts).toContainText('shane@harnessdesk.app')
        await expect(accounts).toContainText('olivia@harnessdesk.app')
        await expect(accounts.locator('tbody > tr')).toHaveCount(6)
        const firstAccount = accounts.getByRole('button', { name: /Details for shane/ })
        const before = await accounts.innerHTML()
        await firstAccount.click()
        await expect(firstAccount).toHaveAttribute('aria-expanded', 'true')
        assert.notEqual(await accounts.innerHTML(), before)
        await expect(accounts).toContainText('Value')
        await expect(accounts).toContainText('$3,148')
        await geometry()
        assert.ok(await sceneBox.evaluate(box => box.scrollHeight > box.clientHeight), 'Expanded account must scroll inside the panel')
        await page.mouse.move(scene.width / 2, scene.height - 40)
        await page.mouse.wheel(0, 300)
        await settle()
        await expect.poll(() => sceneBox.evaluate(box => box.scrollTop)).toBeGreaterThan(0)
        assert.equal(await page.evaluate(() => scrollY), 0, 'Wheel must not scroll the parent page')
        await sceneBox.evaluate(box => { box.scrollTop = 0 })
        await firstAccount.click()
        await expect(firstAccount).toHaveAttribute('aria-expanded', 'false')
        for (const filter of ['Windows', 'Allowances', 'Balances', 'All']) {
          await page.getByRole('radio', { name: new RegExp(`^${filter}\\b`) }).click()
        }
        await expect(accounts.locator('tbody > tr')).toHaveCount(6)
        await firstAccount.click()
      } else {
        await expect(year).toContainText('141.6B')
        await expect(year.locator('[data-state="not-scanned"]')).toHaveCount(0)
        await heatGeometry('Tokens or cost per day, this year')
        await year.getByRole('radio', { name: 'Cost', exact: true }).click()
        await heatGeometry('Tokens or cost per day, this year')
        const before = await year.innerHTML()
        await year.getByRole('radio', { name: 'By agent', exact: true }).click()
        assert.notEqual(await year.innerHTML(), before)
        await heatGeometry('Tokens or cost per day, per agent, last 13 weeks')
        await year.getByRole('radio', { name: 'By hour', exact: true }).click()
        await heatGeometry('Tokens or calls by local weekday and hour, this year')
        await year.getByRole('radio', { name: 'Calls', exact: true }).click()
        await expect(year).toContainText('calls this year')
        await heatGeometry('Tokens or calls by local weekday and hour, this year')
        await year.getByRole('radio', { name: 'Year', exact: true }).click()
        await year.getByRole('radio', { name: 'Tokens', exact: true }).click()
        const heat = year.getByRole('group', { name: 'Tokens or cost per day, this year', exact: true })
        await heat.locator('[data-level]').last().hover()
        await expect(year.locator('[data-slot="chart-tip"]')).toBeVisible()
      }
      if (capture) await shot('view')
    }
    for (const [origin, capture] of [[buildOrigin, false], [previewOrigin, true]]) {
      await page.goto(capture ? `${origin}preview.html?site-scene=${name}&theme=${theme}` : `${origin}?view=${name}&theme=${theme}`)
      await page.clock.runFor(600)
      await page.evaluate(() => document.fonts.ready)
      await (name === 'dashboard' ? exerciseDashboard : exerciseFocused)(capture)
      await page.evaluate(value => postMessage({ type: 'theme', value }, '*'), theme === 'light' ? 'dark' : 'light')
      await expect(page.locator('body[data-hd-dark-theme]')).toHaveCount(theme === 'light' ? 1 : 0)
    }
    for (const explicit of [true, false]) {
      await page.emulateMedia({ reducedMotion: explicit ? 'no-preference' : 'reduce' })
      await page.goto(`${buildOrigin}?view=${name}&theme=${theme}${explicit ? '&motion=reduce' : ''}`)
      await page.clock.runFor(600)
      await expect(sceneBox).toHaveAttribute('data-scene-motion', 'reduce')
      const control = name === 'dashboard-limits'
        ? accounts.getByRole('button', { name: /Details for shane/ })
        : name === 'dashboard-activity'
          ? year.getByRole('radio', { name: 'By agent', exact: true })
          : cost.getByRole('radio', { name: 'Line', exact: true })
      await control.click()
      await page.evaluate(() => postMessage({ type: 'visible', value: false }, '*'))
      await page.clock.fastForward(60_000)
      await expect(control).toHaveAttribute(name === 'dashboard-limits' ? 'aria-expanded' : 'aria-checked', 'true')
      if (name === 'dashboard') {
        await breakdown.getByRole('radio', { name: 'by model', exact: true }).click()
        await expect(breakdown).toContainText('claude-opus-5-5')
      } else if (name !== 'dashboard-limits') await fit()
    }
    assert.deepEqual(external, [], 'The embed made an external request')
    assert.deepEqual(errors, [], 'Scene errors')
    await page.close()
    console.log(`PASS ${name}/${theme}: build and preview controls, theme, reduced motion, geometry, local requests`)
  }
  for (const [name, scene] of Object.entries(SCENES)) {
    const scale = name === 'dashboard' ? .5 : 1
    const width = scene.width * scale, height = scene.height * scale
    const embed = await browser.newPage({ viewport: { width, height } })
    await embed.setContent(`<style>html,body{margin:0;overflow:hidden}iframe{width:${scene.width}px;height:${scene.height}px;border:0;transform:scale(${scale});transform-origin:0 0}</style><script>window.ready=false;addEventListener('message',event=>{if(event.data?.type==='hdDemoReady')window.ready=true})</script><iframe src="${buildOrigin}?view=${name}&motion=reduce"></iframe>`)
    await expect(embed.frameLocator('iframe').locator('[data-site-scene]')).toHaveCSS('width', `${scene.width}px`)
    await expect.poll(() => embed.evaluate(() => window.ready)).toBe(true)
    assert.deepEqual(await embed.locator('iframe').boundingBox(), { x: 0, y: 0, width, height })
    await embed.close()
  }
  const sheet = await browser.newPage({ viewport: { width: 1440, height: 672 } })
  await sheet.setContent(`<style>body{margin:0;background:#eee;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(3,480px)}figure{margin:0}figcaption{padding:8px;height:20px}img{width:480px;height:auto;display:block}</style><main>${frames.map(frame => `<figure><figcaption>${frame.label}</figcaption><img width="${frame.width}" height="${frame.height}" src="data:image/png;base64,${frame.buffer.toString('base64')}"></figure>`).join('')}</main>`)
  await sheet.screenshot({ path: join(out, 'sheet.png'), fullPage: true })
  writeFileSync(join(out, 'report.json'), JSON.stringify({ views: Object.keys(SCENES), themes: ['light', 'dark'], frames: frames.map(frame => frame.file), passed: true }, null, 2))
  console.log(`PASS iframe scaling; ${frames.length} frames and contact sheet written to .lead-out/site-scenes`)
} finally {
  await browser?.close()
  await preview.close()
  await new Promise(done => built.close(done))
}
