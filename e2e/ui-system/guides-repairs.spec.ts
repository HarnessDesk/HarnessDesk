import { expect, test, type Page } from '@playwright/test'

// A small real document isolates the guide's geometry and lifecycle from app animation.
const open = async (page: Page) => {
  await page.route('**/guides-repair', route => route.fulfill({ contentType: 'text/html', body: `
    <style>
      body { margin: 0; --hd-space-3: 12px; --hd-text: 14px; --hd-accent: #123456 }
      body.dark, html.dark body { --hd-accent: #654321 }
      #root { width: 600px; height: 400px; padding: 20px; font-size: 14px }
      #box { width: 120px; height: 60px; padding-left: 7px; }
      #child { display: block; width: 200px; height: 20px; padding-left: 7px; border-radius: 5px; }
    </style>
    <main id="root" data-frame-id="repair"><div id="box" data-slot="card"><span id="child" data-slot="text">A wide child</span></div></main>
  ` }))
  await page.goto('/guides-repair')
}

test('fixes keep reporting overflow on a child whose spacing was corrected', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async () => {
    const { mountGuides, previewFixes, guidesReport } = await import('/src/design/explorer/guides.ts' as string)
    const root = document.querySelector('#root')!
    const cleanup = mountGuides(() => [root], 'lines')
    await new Promise(requestAnimationFrame)
    const before = guidesReport.current.flatMap((one: { overflow: string[] }) => one.overflow)
    previewFixes([root])
    window.dispatchEvent(new Event('resize'))
    await new Promise(requestAnimationFrame)
    const after = guidesReport.current.flatMap((one: { overflow: string[] }) => one.overflow)
    cleanup()
    return { before, after, padding: (document.querySelector('#child') as HTMLElement).style.paddingLeft }
  })
  expect(result.padding).toBe('var(--hd-space-3)')
  expect(result.before.some((one: string) => one.includes('div') && one.endsWith('spills'))).toBe(true)
  expect(result.after.some((one: string) => one.includes('div') && one.endsWith('spills'))).toBe(true)
})

for (const themeRoot of ['body', 'html']) test(`palette refresh settles after a ${themeRoot} theme mutation`, async ({ page }) => {
  await open(page)
  await page.clock.install()
  await page.evaluate(async () => {
    const { mountGuides } = await import('/src/design/explorer/guides.ts' as string)
    const original = CanvasRenderingContext2D.prototype.clearRect
    ;(window as any).draws = 0
    ;(window as any).edges = []
    CanvasRenderingContext2D.prototype.clearRect = function (...args) { (window as any).draws++; original.apply(this, args) }
    const stroke = CanvasRenderingContext2D.prototype.strokeRect
    CanvasRenderingContext2D.prototype.strokeRect = function (...args) { (window as any).edges.push(this.strokeStyle); stroke.apply(this, args) }
    mountGuides(() => [document.querySelector('#root')!], 'lines')
  })
  await page.clock.runFor(200)
  await page.locator(themeRoot).evaluate(el => el.classList.add('dark'))
  await page.clock.runFor(500)
  expect(await page.evaluate(() => (window as any).edges)).toContain('#654321')
  const settled = await page.evaluate(() => (window as any).draws)
  expect(settled).toBeGreaterThan(0)
  await page.clock.runFor(600)
  expect(await page.evaluate(() => (window as any).draws)).toBe(settled)
  await page.locator(themeRoot).evaluate(el => el.classList.remove('dark'))
  await page.clock.runFor(500)
  expect(await page.evaluate(() => (window as any).edges.at(-1))).toBe('#123456')
})

// Appearance preferences can change without touching class or style. Exercise
// both roots, including removal back to defaults, without resize/pointer redraws.
for (const appearanceRoot of ['body', 'html']) {
  for (const attribute of ['data-hd-dark-theme', 'data-hd-palette', 'data-hd-accent', 'data-hd-corners', 'data-hd-faces', 'data-hd-interface']) {
    test(`palette and tokens settle after ${appearanceRoot} ${attribute} changes`, async ({ page }) => {
      await open(page)
      await page.addStyleTag({ content: `
        body { --hd-radius: 5px }
        body[${attribute}], html[${attribute}] body { --hd-accent: #abcdef; --hd-radius: 9px }
        #child { border-radius: var(--hd-radius) }
      ` })
      await page.clock.install()
      await page.evaluate(async () => {
        const { mountGuides } = await import('/src/design/explorer/guides.ts' as string)
        const clear = CanvasRenderingContext2D.prototype.clearRect
        const stroke = CanvasRenderingContext2D.prototype.strokeRect
        ;(window as any).draws = 0
        ;(window as any).edges = []
        CanvasRenderingContext2D.prototype.clearRect = function (...args) { (window as any).draws++; clear.apply(this, args) }
        CanvasRenderingContext2D.prototype.strokeRect = function (...args) { (window as any).edges.push(this.strokeStyle); stroke.apply(this, args) }
        mountGuides(() => [document.querySelector('#root')!], 'lines')
      })
      await page.clock.runFor(200)
      const check = async (color: string) => {
        expect(await page.evaluate(() => (window as any).edges.at(-1))).toBe(color)
        const offScale = await page.evaluate(async () => {
          const { guidesReport } = await import('/src/design/explorer/guides.ts' as string)
          return guidesReport.current.flatMap((one: { offScale: string[] }) => one.offScale)
        })
        expect(offScale.some((one: string) => one.includes('radius'))).toBe(false)
        const settled = await page.evaluate(() => (window as any).draws)
        await page.clock.runFor(600)
        expect(await page.evaluate(() => (window as any).draws)).toBe(settled)
      }
      await check('#123456')
      await page.locator(appearanceRoot).evaluate((el, attr) => el.setAttribute(attr, 'custom'), attribute)
      await page.clock.runFor(500)
      await check('#abcdef')
      await page.locator(appearanceRoot).evaluate((el, attr) => el.removeAttribute(attr), attribute)
      await page.clock.runFor(500)
      await check('#123456')
    })
  }
}

for (const waitingForScene of [false, true]) {
  test(`as is cancels a pending fix pass${waitingForScene ? ' waiting for scene steps' : ''}`, async ({ page }) => {
    await open(page)
    await page.clock.install()
    await page.evaluate(async waiting => {
      const { setFixPreview } = await import('/src/design/explorer/guides.ts' as string)
      if (waiting) document.documentElement.dataset.sceneSteps = 'running'
      const roots = () => [document.querySelector('#root')!]
      ;(window as any).pendingFix = setFixPreview(true, roots)
      await setFixPreview(false, roots)
      document.documentElement.dataset.sceneSteps = 'done'
    }, waitingForScene)
    await page.clock.runFor(1000)
    expect(await page.evaluate(async () => (await (window as any).pendingFix)?.length ?? 0)).toBe(0)
    expect(await page.locator('#child').getAttribute('style')).toBeNull()
  })
}

test('canvas off-scale tally counts the same element signatures as the report', async ({ page }) => {
  await open(page)
  const result = await page.evaluate(async () => {
    const { mountGuides, guidesReport } = await import('/src/design/explorer/guides.ts' as string)
    const labels: string[] = []
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { labels.push(text); original.call(this, text, ...args) }
    const cleanup = mountGuides(() => [document.querySelector('#root')!], 'lines')
    await new Promise(requestAnimationFrame)
    cleanup()
    return { labels, count: guidesReport.current[0].offScale.length }
  })
  expect(result.labels.some(label => label.includes(`${result.count} off-scale`))).toBe(true)
})
