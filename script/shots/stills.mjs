/** Opt-in 0.4.0 posters, composed from production surfaces in preview.html. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { COLLECT, textReasons, USER } from './audit.mjs'

export const STILL_SCENES = {
  'teams-table': { height: 900, scale: 2, pad: 12, crop: '[data-slot="teams-board"]', ready: ['Needs you', 'Working', 'Ready to wrap'], caption: 'Active Teams in columns: the ones that need you, the ones working and the ones ready to wrap.' },
  'run-short': { height: 1400, scale: 2, crop: '[aria-label="Run timeline"]', ready: ['Request changes', '1 finding', 'Cap the retry attempts', 'Approve', 'Decide whether the change ships'], caption: 'Write, review, repair, approve, and a decision for the person.' },
  'race-run': { height: 1100, scale: 2, crop: '[aria-label="Run timeline"]', ready: ['Picked', 'Not kept', 'Round 2 · judge', 'Decide whether the change ships'], caption: 'Two attempts, the judge’s pick, and the person’s decision.' },
  'browser-tile': { width: 672, height: 640, scale: 2, crop: '[data-slot="side-by-side-tile"]', cropEnd: 'iframe', url: 'https://acme.dev/storefront', ready: ['Assistant A', 'Working'], caption: 'A Seat’s Browser visits an isolated Storefront fixture at acme.dev.' },
  'handoff-dialog': { height: 740, scale: 2, crop: '[role="dialog"]', ready: ['Hand off to Reviewer'], caption: 'Choose how much of a conversation travels to the next agent.' },
  'start-preview': { height: 1100, scale: 2, crop: '[data-site-start]', ready: ['Brief', 'Attach a file…', 'Task', 'It opens 3 seats', 'Implementer — write, isolated', 'Code reviewer — review, isolated', 'Picked', 'Start'], caption: 'The start preview’s brief, task, Agent identities, Seat candidates and Start.' },
  'dash-plans': { height: 1400, scale: 2, crop: '[data-slot="plans-table"]', ready: ['dev@example.com', 'Value', '6%'], caption: 'Five placeholder accounts, with one plan near its limit and its reset time.' },
  'dash-hour': { height: 740, scale: 2, crop: '[aria-label="When it ran"] [data-slot="chart-frame"]', ready: ['Tokens, last 12 months', 'Busiest hour'], caption: 'A year of work by local weekday and hour, including quiet mornings and weekends.' },
  'dash-year': { width: 1120, height: 740, scale: 2, crop: '[aria-label="When it ran"] [data-slot="chart-frame"]', ready: ['Last 12 months', 'Active days', '365 days scanned'], caption: 'A whole synthetic year, with weekends, days off and a holiday week.' },
  'dash-spend': { height: 1000, scale: 2, crop: '[aria-label="What it cost"] [data-slot="chart-frame"]', ready: ['public API rates. Not a bill.', '90 of 90 days with usage'], caption: 'Estimated spend across agents over 90 days.' },
  'dash-agents': { height: 1000, scale: 2, pad: 12, crop: '[aria-label="Where it went"]', ready: ['Where it went', 'Share', 'Cost'], caption: 'The same total split by agent.' },
  library: { height: 360, ready: ['Library', 'brainstorming', 'code-review', 'design-review', 'Update available'], caption: 'Library lists each skill with the runtimes that load it, and flags the one with an update available.' },
  'plugin-permissions': { height: 744, ready: ['Project docs', 'Access', 'Read files in the open project', 'Reach docs.acme.dev'], caption: 'Project docs holds access to read the open project and reach docs.acme.dev.' },
  teams: { height: 744, ready: ['Needs you', 'Working', 'Ready to wrap', 'Wrapped · 1', 'Keep the invoice rounding change'], caption: 'Teams in columns, with work that needs you first and the wrapped receipts folded below.' },
  'project-sidebar': { height: 800, ready: ['Teams', 'Projects', 'Retry the checkout call on a 502', 'Seats', 'Alpha', 'Beta'], caption: 'One project gathers linked checkout conversations and a Team, with the Team’s Seats beside it.' },
  'run-timeline': { height: 860, ready: ['Decide whether the retry change ships', 'Posted to #42', 'Request changes', 'The retry loop needs a ceiling', 'Cap the attempts.', 'Waiting for you'], caption: 'A Run records the first review, the repair and passing checks, then waits for a person; the selected review shows its verdict and finding.' },
  'run-flow': { height: 820, ready: ['Decide whether the retry change ships', 'Flow'], caption: 'The Run’s Flow shows the travelled repair loop and the person step waiting.' },
  'flow-start-preview': { height: 1920, ready: ['It opens 3 seats', 'reviewer · Seat 2', 'It runs these commands', 'Start'], caption: 'The start preview shows the task, Seat choices, Edit and Read only ceilings, a named check and Start.' },
  'race-tiles': { height: 820, ready: ['Picked', 'Not kept', 'Merge A into main'], caption: 'Two attempts share a composer; one shows its Browser, and the judge’s verdict marks Picked and Not kept.' },
  'run-picked': { height: 900, ready: ['Merge the picked change', 'Picked', 'Not kept', 'Waiting for you'], caption: 'A comparison Run keeps both attempts and their checks; the selected judge step shows the picked attempt and the one not kept.' },
  'dashboard-plans': { height: 960, ready: ['Paid', 'Value', 'unpriced', 'from its own API'], caption: 'An expanded plan shows Paid, an unpriced Value, the monthly fee and the source of its reading.' },
  'dashboard-hour': { height: 680, ready: ['By hour', 'known for 2 of 3 runtimes'], caption: 'Dashboard Activity by hour, with hours known for two of the three runtimes.' },
}

/** Protect images other documentation still uses; the brief permits only this pair. */
export const assertReplaceable = (root, filename, out = join(root, 'docs/images/app')) => {
  if (['flow-light.png', 'flow-dark.png'].includes(filename)) return
  const protectedFile = join(root, 'docs/images/app', filename)
  const destination = join(out, filename)
  if (!existsSync(protectedFile) || !existsSync(destination) || realpathSync(destination) !== realpathSync(protectedFile)) return
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
  const names = requested.length ? requested : Object.keys(STILL_SCENES).filter(name => !STILL_SCENES[name].crop)
  for (const name of names) {
    if (!STILL_SCENES[name]) throw new Error(`No release still named ${name}`)
    for (const theme of themes) assertReplaceable(app, `${name}-${theme}.png`, out)
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
    for (const name of names) {
      const scene = STILL_SCENES[name]
      const page = await browser.newPage({ deviceScaleFactor: scene.scale ?? 1, reducedMotion: 'reduce', timezoneId: 'America/Los_Angeles' })
      let errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
      if (scene.scale === 2) await page.clock.setFixedTime(new Date('2026-09-30T17:00:00Z'))
      if (scene.url) await page.route('https://acme.dev/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(app, 'script/shots/fixtures/acme-storefront.html'), 'utf8') }))
      for (const theme of themes) {
        for (const width of name === 'race-tiles' ? [960, 1280] : [scene.width ?? 960]) {
          await page.setViewportSize({ width, height: scene.height })
          errors = []
          await page.emulateMedia({ colorScheme: theme })
          await page.goto(`${origin}preview.html?release-stills=${name}&theme=${theme}`)
          const surface = page.locator('[data-release-still]')
          await expect(surface).toBeVisible()
          await expect(page.locator('body[data-hd-dark-theme]')).toHaveCount(theme === 'dark' ? 1 : 0)
          if (name === 'teams') await surface.getByRole('button', { name: /^Wrapped/ }).click()
          if (name === 'plugin-permissions') await surface.getByRole('button', { name: /Project docs Find reference/ }).click()
          if (name === 'project-sidebar') await surface.getByRole('tab', { name: 'Overview', exact: true }).click()
          if (name === 'run-timeline') await surface.getByRole('button', { name: /^Review Agent/ }).first().click()
          if (name === 'run-picked') await surface.getByRole('button', { name: /^Judge Agent/ }).click()
          if (name === 'run-timeline' || name === 'run-picked') await page.mouse.move(0, 0)
          if (name === 'dashboard-plans') {
            await surface.getByRole('radio', { name: 'Windows · 3', exact: true }).click()
            await surface.getByRole('button', { name: 'Details for shane@harnessdesk.app', exact: true }).last().click()
          }
          if (name === 'dashboard-hour' || name === 'dash-hour') await surface.getByRole('combobox', { name: 'Show by', exact: true }).selectOption('hour')
          if (name === 'dash-plans') await surface.getByRole('button', { name: 'Details for dev@example.com', exact: true }).first().click()
          if (name === 'dash-spend' || name === 'dash-agents') await surface.getByRole('combobox', { name: 'How far back', exact: true }).selectOption('90')
          for (const text of scene.ready) await expect(name === 'handoff-dialog' ? page.locator('[role="dialog"]') : surface).toContainText(text)
          if (name === 'plugin-permissions') {
            const last = surface.getByText('Reach docs.acme.dev', { exact: true })
            const box = await last.boundingBox()
            if (!box || box.y + box.height > scene.height) throw new Error(`${name}: the last required row is outside the camera frame`)
          }
          if (name === 'run-flow') await expect(surface.locator('[data-slot="flow-step"]').first()).toBeVisible()
          if (name === 'flow-start-preview') {
            const start = page.getByRole('button', { name: 'Start', exact: true })
            await expect(start).toBeEnabled()
            const box = await start.boundingBox()
            if (!box || box.y + box.height > scene.height) throw new Error('Start is outside the camera frame')
          }
          if (name === 'run-picked') {
            const person = surface.getByRole('button', { name: /^Merge Person/ })
            await expect(person).toBeVisible()
            const box = await person.boundingBox()
            if (!box || box.y + box.height > scene.height) throw new Error('The person step is outside the camera frame')
          }
          if (name === 'race-tiles') {
            await expect(surface.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
            await expect(surface.locator('[data-shared-composer]')).toBeVisible()
            await expect(surface.getByRole('button', { name: 'Back to the conversation' })).toHaveCount(1)
            await expect(surface.getByRole('button', { name: 'Show the browser' })).toHaveCount(1)
            await expect(page.frames()[1].getByRole('heading', { name: 'The daily planner' })).toBeVisible()
          }
          if (name === 'browser-tile') {
            await expect(page.locator('iframe')).toHaveAttribute('src', scene.url)
            await expect(page.frameLocator('iframe').getByRole('heading', { name: 'A calmer checkout.' })).toBeVisible()
            const guest = page.frames().find(frame => frame.url() === scene.url)
            if (!guest) throw new Error('The Browser did not load its acme.dev fixture')
            await expect(guest.getByRole('heading', { name: 'A calmer checkout.' })).toBeVisible()
            await expect(surface.locator('input').filter({ visible: true }).first()).toHaveValue(scene.url)
          }
          if (name === 'start-preview') await expect(surface.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
          await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))) })
          auditSnapshots(await Promise.all(page.frames().map(frame => frame.evaluate(COLLECT))))
          if (errors.length) throw new Error(`${name}: the preview reported ${errors.length} rendering errors; no frame saved.`)
          const filename = `${name}${width === 1280 ? '-full' : ''}-${theme}.png`
          assertReplaceable(app, filename, out)
          const content = scene.crop ? page.locator(scene.crop).first() : surface
          await expect(content).toBeVisible()
          if (scene.crop) for (const text of scene.ready) await expect(content).toContainText(text)
          if (name === 'dash-year') await expect.poll(() => content.getByRole('group').evaluate(grid => {
            const scroller = grid.parentElement
            return scroller.scrollWidth <= scroller.clientWidth + 1
          })).toBe(true)
          const box = await content.boundingBox()
          if (box && scene.cropEnd) {
            const end = await content.locator(scene.cropEnd).boundingBox()
            if (!end) throw new Error(`${name}: the last content edge is unavailable`)
            box.height = end.y + end.height - box.y
          }
          if (!box || box.height > scene.height || box.y < 0 || box.y + box.height > scene.height) throw new Error(`${name}: the content edge does not fit the camera`)
          if (scene.pad) { box.x -= scene.pad; box.y -= scene.pad; box.width += 2 * scene.pad; box.height += 2 * scene.pad }
          if (scene.cropEnd || scene.pad) await page.screenshot({ path: join(out, filename), clip: box, animations: 'disabled' })
          else await content.screenshot({ path: join(out, filename), animations: 'disabled' })
          frames.push({ scene: name, theme, width: Math.round(box.width), height: Math.round(box.height), scale: scene.scale ?? 1, filename, caption: scene.caption })
          process.stdout.write(`Audited and captured ${filename}\n`)
        }
      }
      await page.close()
    }
    writeFileSync(join(out, 'stills.json'), `${JSON.stringify(frames, null, 2)}\n`)
  } finally {
    await browser?.close()
    await server?.close()
  }
}
