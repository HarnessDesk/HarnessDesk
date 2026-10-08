import { chromium, expect, test } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 390]) {
  test(`Overview, person answer and Run Flow in ${theme} at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/?view=flow&stage=you&theme=${theme}`)
    await expect(page.getByText('The numbers are staged; the surface is not.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeVisible()
    await expect(page.getByText('Posted to #42', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Merged', exact: true }).click()
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'done')
    await expect(page.getByRole('button', { name: 'Merged', exact: true })).toHaveCount(0)
    // The Run link on the Overview works without the rail at narrow widths.
    await page.getByRole('button', { name: 'Write, review, land', exact: true }).click()
    for (const round of [3, 6]) await expect(page.locator(`[data-kind="card"][data-row^="card-${round}-"]`).filter({ hasText: 'Posted to #42' })).toHaveCount(2)
    await page.getByRole('radio', { name: 'Flow', exact: true }).click()
    await expect(page.locator('[data-slot="flow-graph"]')).toBeVisible()
    await expect(page.locator('[data-step-row="you"]')).toHaveAttribute('data-state', 'done')
    await expect(page.locator('[data-step-row="you"]')).toContainText('Merged')
    await expect(page.getByText('Loading plan…', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
  test(`poster in ${theme} at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 720 })
    await page.goto(`/?view=poster&theme=${theme}`)
    await expect(page.locator('[data-slot="run-time-bar"]')).toBeVisible()
    expect(await page.locator('[data-slot="run-time-bar"] [data-ms]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-ms'))))).toEqual([660000, 180000, 360000, 120000])
    if (width === 390) await expect(page.locator('[data-step-row="fix"]')).toContainText('Working')
    else await expect(page.locator('[data-slot="flow-step"][data-step="fix"]')).toHaveAttribute('data-state', 'working')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
    expect(errors).toEqual([])
  })
  test(`staged stop refusal in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/?view=flow&stage=fix&theme=${theme}`)
    await page.getByRole('button', { name: 'Write, review, land', exact: true }).click()
    await page.getByRole('button', { name: 'Stop run…', exact: true }).click()
    await page.getByRole('button', { name: 'Stop run', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toContainText('Stopping is not available in this staged Run.')
    await page.getByRole('button', { name: 'Keep running', exact: true }).click()
    await page.getByRole('button', { name: 'Next step', exact: true }).click()
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check-again')
  })
}

test('the built demo carries only placeholder account identities', async () => {
  const folder = 'packages/ui/dist-site-demo'
  const files = await readdir(folder, { recursive: true })
  for (const file of files.filter(file => /\.(js|html|css)$/.test(file))) {
    const text = await readFile(`${folder}/${file}`, 'utf8')
    expect(text.match(/\b[\w.+-]+@harnessdesk\.app\b/g) ?? [], file).toEqual([])
    expect(text.match(/\/Users\/(?!jane(?:\/|["']))[^/"'\s]+/g) ?? [], file).toEqual([])
  }
})

for (const width of [1280, 390]) test(`the Run's person inspector answers locally at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/?view=flow&stage=you&theme=light')
  await page.getByRole('button', { name: 'Write, review, land', exact: true }).click()
  await page.getByRole('button', { name: 'Answer…', exact: true }).click()
  await page.getByRole('button', { name: 'Dropped', exact: true }).click()
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'done')
  await expect(page.getByRole('button', { name: 'Dropped', exact: true })).toHaveCount(0)
})

for (const view of ['flow', 'poster']) test(`the embedded ${view} signals readiness after drawing once`, async ({ page, baseURL }) => {
  await page.goto('/?view=poster')
  await page.setContent('')
  await page.evaluate(src => {
    const frame = document.createElement('iframe')
    frame.title = 'Staged Run'
    const messages: boolean[] = []
    ;(window as unknown as { readyFrames: boolean[] }).readyFrames = messages
    window.addEventListener('message', event => {
      if (event.source === frame.contentWindow && event.data?.type === 'hdDemoReady') {
        messages.push(Boolean(frame.contentDocument?.querySelector('[data-slot="site-run-demo"]')?.getBoundingClientRect().height))
      }
    })
    frame.src = src
    document.body.append(frame)
  }, `${baseURL}/?view=${view}&stage=write&theme=light`)
  const ready = () => page.evaluate(() => (window as unknown as { readyFrames: boolean[] }).readyFrames)
  await expect.poll(ready).toEqual([true])
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ hdTheme: 'dark' }, '*'))
  await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  expect(await ready()).toEqual([true])
})

test('reduced motion waits for Next step; the posted review survives the fix loop', async ({ page }) => {
  await page.goto('/?view=flow')
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'write')
  await page.waitForTimeout(3800)
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'write')
  for (const stage of ['check', 'changes', 'fix', 'check-again', 'approve', 'land', 'you']) {
    await page.getByRole('button', { name: 'Next step', exact: true }).click()
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', stage)
  }
  await expect(page.getByText('Posted to #42', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Merged', exact: true })).toBeVisible()
})

test('the poster keeps its text alternative between the page and graph breakpoints', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await page.goto('/?view=poster&theme=light')
  await expect(page.locator('[data-step-row="fix"]')).toBeVisible()
})

test('the embedding page can change either scene’s theme', async ({ page }) => {
  for (const view of ['flow', 'poster']) {
    await page.goto(`/?view=${view}&theme=light`)
    await expect(page.locator('[data-slot="site-run-demo"]')).toBeVisible()
    await page.evaluate(() => window.postMessage({ hdTheme: 'dark' }, '*'))
    await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    await page.evaluate(() => window.postMessage({ hdTheme: 'light' }, '*'))
    await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme')
  }
})

test('visible playback advances and can be paused and resumed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/?view=flow')
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click()
  await page.waitForTimeout(3800)
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check')
  await page.getByRole('button', { name: 'Play demo', exact: true }).click()
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'changes', { timeout: 10_000 })
})

test('cached-page lifecycle pauses hidden playback and restores automatic and manual advancement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/?view=flow')
  await expect(page.getByRole('button', { name: 'Pause demo', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  await page.waitForTimeout(3800)
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'write')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click()
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await page.waitForTimeout(3800)
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check')
  await page.getByRole('button', { name: 'Next step', exact: true }).click()
  await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'changes')
})

test('Next step survives an actual back/forward cache restoration', async ({ baseURL }) => {
  // The default headless shell excludes cached returns; full headless Chromium supports them.
  const browser = await chromium.launch({ channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] })
  try {
    const page = await browser.newPage({ baseURL, reducedMotion: 'reduce' })
    await page.goto('/?view=flow&stage=write')
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'write')
    await page.evaluate(() => window.addEventListener('pageshow', event => {
      document.body.dataset.cacheRestored = String(event.persisted)
    }))
    await page.goto('/?view=poster')
    await expect(page.locator('[data-slot="site-poster"]')).toBeVisible()
    await page.goBack({ waitUntil: 'commit' })
    await expect(page.locator('body')).toHaveAttribute('data-cache-restored', 'true')
    await page.getByRole('button', { name: 'Next step', exact: true }).click()
    await expect(page.locator('[data-slot="site-run-demo"]')).toHaveAttribute('data-stage', 'check')
  } finally { await browser.close() }
})
