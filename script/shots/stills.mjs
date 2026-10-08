/** Opt-in 0.4.0 posters, composed from production surfaces in preview.html. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { COLLECT, textReasons, USER } from './audit.mjs'

export const STILL_SCENES = {
  teams: { height: 744, ready: ['Needs you', 'Working', 'Ready to wrap'], caption: 'Teams grouped by project, with work that needs you first and settled work expanded.' },
  'project-sidebar': { height: 800, ready: ['Teams', 'Projects', 'Retry the checkout call on a 502'], caption: 'One project gathers linked checkout conversations and a Team with nested Seats.' },
  'run-timeline': { height: 1544, ready: ['Request changes', 'Cap the retry attempts', 'Decide whether the retry change ships'], caption: 'A Run records the first review, the repair and passing checks, then waits for a person.' },
  'run-flow': { height: 820, ready: ['Decide whether the retry change ships', 'Flow'], caption: 'The Run’s Flow shows the travelled repair loop and the person step waiting.' },
  'flow-start-preview': { height: 1672, ready: ['It opens 2 seats', 'It runs these commands', 'Start'], caption: 'The start preview shows the task, Seat choices, Edit and Read only ceilings, a named check and Start.' },
  'race-tiles': { height: 820, ready: ['Picked', 'Not kept', 'Browser'], caption: 'Two attempts share a composer; one shows its Browser, and the judge’s verdict marks Picked and Not kept.' },
  'run-picked': { height: 1224, ready: ['Picked', 'Not kept', 'Run'], caption: 'A comparison Run keeps both attempts and their checks, with the picked attempt distinguished from the one not kept.' },
  'dashboard-plans': { height: 960, ready: ['Paid', 'Value', 'unpriced', 'from its own API'], caption: 'An expanded plan shows Paid, an unpriced Value, the monthly fee and the source of its reading.' },
  'dashboard-hour': { height: 680, ready: ['By hour', 'known for 2 of 3 agents'], caption: 'Dashboard Activity by hour, with hours known for two of the three agents.' },
}

/** Protect images other documentation still uses; the brief permits only this pair. */
export const assertReplaceable = (root, filename) => {
  if (['flow-light.png', 'flow-dark.png'].includes(filename)) return
  if (!existsSync(join(root, 'docs/images/app', filename))) return
  const docs = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? docs(path) : /\.(?:md|mdx|html)$/.test(entry.name) ? [path] : []
  })
  const sources = [join(root, 'README.md'), ...docs(join(root, 'docs'))]
  if (sources.some(path => existsSync(path) && readFileSync(path, 'utf8').includes(filename))) {
    throw new Error(`${filename} is referenced by existing documentation; capture with a new name.`)
  }
}

export const auditSnapshots = snapshots => {
  const reasons = snapshots.flatMap(snapshot => textReasons(snapshot, { user: USER }))
  if (reasons.length) throw new Error(`Unpublishable frame: ${reasons.join('\n')}`)
}

export const shootStills = async ({ app, out, requested = [], themes = ['light', 'dark'] }) => {
  const names = requested.length ? requested : Object.keys(STILL_SCENES)
  for (const name of names) {
    if (!STILL_SCENES[name]) throw new Error(`No release still named ${name}`)
    for (const theme of themes) assertReplaceable(app, `${name}-${theme}.png`)
  }
  const require = createRequire(join(app, 'packages/ui/package.json'))
  const { createServer } = await import(pathToFileURL(require.resolve('vite')))
  const { chromium, expect } = await import('@playwright/test')
  let server, browser
  mkdirSync(out, { recursive: true })
  const frames = []
  try {
    server = await createServer({ root: join(app, 'packages/ui'), server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
    await server.listen()
    const origin = server.resolvedUrls.local[0]
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: 'reduce' })
    let errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    for (const name of names) {
      const scene = STILL_SCENES[name]
      for (const theme of themes) {
        for (const width of name === 'race-tiles' ? [960, 1280] : [960]) {
          await page.setViewportSize({ width, height: scene.height })
          errors = []
          await page.goto(`${origin}preview.html?release-stills=${name}&theme=${theme}`)
          const surface = page.locator('[data-release-still]')
          await expect(surface).toBeVisible()
          await expect(page.locator('body[data-hd-dark-theme]')).toHaveCount(theme === 'dark' ? 1 : 0)
          if (name === 'teams') await surface.getByRole('button', { name: /Ready to wrap/ }).click()
          if (name === 'project-sidebar') {
            await surface.getByRole('button', { name: 'Room Retry the checkout call on a 502', exact: true }).focus()
            await page.keyboard.press('ArrowRight')
            await expect(surface.getByRole('button', { name: /Hide the agents in.*Retry the checkout call/ })).toHaveAttribute('aria-expanded', 'true')
            await surface.getByRole('tab', { name: 'Overview', exact: true }).click()
          }
          if (name === 'dashboard-plans') {
            await surface.getByRole('radio', { name: 'Windows · 3', exact: true }).click()
            await surface.getByRole('button', { name: 'Details for shane@harnessdesk.app', exact: true }).last().click()
          }
          if (name === 'dashboard-hour') await surface.getByRole('radio', { name: 'By hour', exact: true }).click()
          for (const text of scene.ready) await expect(surface).toContainText(text)
          if (name === 'run-flow') await expect(surface.locator('[data-slot="flow-step"]').first()).toBeVisible()
          if (name === 'flow-start-preview') {
            const start = page.getByRole('button', { name: 'Start', exact: true })
            await expect(start).toBeEnabled()
            const box = await start.boundingBox()
            if (!box || box.y + box.height > scene.height) throw new Error('Start is outside the camera frame')
          }
          if (name === 'run-picked') {
            const person = surface.getByText('Read the evidence and choose the next step.', { exact: true })
            await expect(person).toBeVisible()
            const box = await person.boundingBox()
            if (!box || box.y + box.height > scene.height) throw new Error('The person step is outside the camera frame')
          }
          if (name === 'race-tiles') {
            await expect(surface.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
            await expect(surface.locator('[data-shared-composer]')).toBeVisible()
            await expect(surface.getByRole('radio', { name: 'Browser', exact: true }).first()).toHaveAttribute('aria-checked', 'true')
            await expect(page.frames()[1].getByRole('heading', { name: 'The daily planner' })).toBeVisible()
          }
          await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))) })
          auditSnapshots(await Promise.all(page.frames().map(frame => frame.evaluate(COLLECT))))
          if (errors.length) throw new Error(`${name}: the preview reported ${errors.length} rendering errors; no frame saved.`)
          const filename = `${name}${width === 1280 ? '-full' : ''}-${theme}.png`
          assertReplaceable(app, filename)
          await surface.screenshot({ path: join(out, filename), animations: 'disabled' })
          frames.push({ scene: name, theme, width, filename, caption: scene.caption })
          process.stdout.write(`Audited and captured ${filename}\n`)
        }
      }
    }
    writeFileSync(join(out, 'stills.json'), `${JSON.stringify(frames, null, 2)}\n`)
  } finally {
    await browser?.close()
    await server?.close()
  }
}
