import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`the decision scrolls long recorded text above the shared composer in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?comparison-verdict=long-reason')
    await page.getByRole('combobox', {name:'theme', exact:true}).selectOption(theme)
    const frame = page.locator('[data-frame-id="comparison-long-reason"]')
    const decision = frame.locator('[data-slot="comparison-decision"]')
    await expect(decision).toContainText('The judge picked A')
    const grid = frame.locator('[data-slot="side-by-side-grid"]')
    const top = (await grid.boundingBox())!.y
    const words = decision.getByLabel('Judge reason')
    await expect(words).toHaveAttribute('tabindex','0')
    expect(await words.evaluate(node => {node.scrollTop=node.scrollHeight;return node.scrollHeight>node.clientHeight&&node.scrollTop>0})).toBe(true)
    await expect(decision.getByRole('button',{name:'Merge A into main'})).toBeVisible()
    expect((await grid.boundingBox())!.y).toBe(top)
    const textarea = frame.locator('[data-shared-composer] textarea')
    expect((await decision.boundingBox())!.y+(await decision.boundingBox())!.height).toBeLessThan((await textarea.boundingBox())!.y)
    const dock = frame.locator('[data-shared-composer]')
    expect(await dock.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true)
    const send = dock.getByRole('button', {name:'Send',exact:true})
    expect((await send.boundingBox())!.y+(await send.boundingBox())!.height).toBeLessThanOrEqual((await grid.boundingBox())!.y+(await grid.boundingBox())!.height)
  })
  test(`a browser tile reaches the bottom under the floating decision and composer in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?comparison-verdict=combined')
    await page.getByRole('combobox',{name:'theme',exact:true}).selectOption(theme)
    const frame=page.locator('[data-frame-id="comparison-combined"]')
    for(const width of [1200,841]) {
      await frame.locator('[data-side-by-side-container]').evaluate((node,px)=>{node.style.width=`${px}px`},width)
      const tiles=frame.locator('[data-slot="side-by-side-tile"]')
      await expect(tiles.nth(0).getByRole('button',{name:'Back to the conversation',exact:true})).toBeVisible()
      await expect(tiles.nth(0).locator('iframe')).toBeVisible()
      await expect(tiles.nth(0).locator(':scope > header')).toContainText('Picked')
      await expect(tiles.nth(1).locator(':scope > header')).toContainText('Not kept')
      await expect(tiles.nth(0).locator('[data-slot="tool-pane-header"]')).toHaveCount(0)
      await expect(tiles.nth(0).locator('[data-variant="address-slim"]')).toBeVisible()
      await expect.poll(() => tiles.nth(0).evaluate(tile => {
        const browser = tile.querySelector('iframe')!.closest('[data-slot="tool-pane"]')!
        return Math.abs(browser.getBoundingClientRect().bottom - tile.getBoundingClientRect().bottom)
      })).toBeLessThanOrEqual(1)
      await expect.poll(() => frame.evaluate(node =>
        node.querySelector('[data-mode="browser"]')!.getBoundingClientRect().bottom
          - node.querySelector('[data-shared-composer]')!.getBoundingClientRect().top,
      )).toBeGreaterThan(1)
      await frame.scrollIntoViewIfNeeded()
      expect(await frame.evaluate(node => {
        const dock = node.querySelector('[data-shared-composer]')!
        const decision = dock.querySelector('[data-slot="comparison-decision"]')!
        const shell = dock.querySelector('[data-slot="composer"]')!
        const grid = dock.parentElement!.getBoundingClientRect()
        const card = decision.getBoundingClientRect()
        const box = shell.getBoundingClientRect()
        const probe = document.createElement('div')
        probe.style.backgroundColor = 'var(--hd-card)'
        dock.append(probe)
        const surface = getComputedStyle(probe).backgroundColor
        probe.remove()
        const through = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y)
          return hit !== null && !dock.contains(hit)
        }
        const onCard = (element: Element) => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
        }
        return {
          decisionSurface: getComputedStyle(decision).backgroundColor === surface,
          composerSurface: getComputedStyle(shell).backgroundColor === surface,
          opaque: surface !== 'rgba(0, 0, 0, 0)',
          besideBrowser: through(grid.left + 10, box.top + box.height / 2),
          besideTranscript: through(grid.right - 10, box.top + box.height / 2),
          gap: box.top > card.bottom && through(card.left + card.width / 2, (card.bottom + box.top) / 2),
          decisionHit: onCard(decision),
          composerHit: onCard(shell),
        }
      })).toEqual({ decisionSurface: true, composerSurface: true, opaque: true, besideBrowser: true, besideTranscript: true, gap: true, decisionHit: true, composerHit: true })
      if (width === 1200) {
        await tiles.nth(0).frameLocator('iframe').getByRole('button', { name: 'Add a note' }).click()
        await expect(tiles.nth(0).frameLocator('iframe').getByText('1 note saved')).toBeVisible()
        await frame.locator('[data-shared-composer] textarea').fill('Compare the retry budget.')
        await tiles.nth(1).evaluate(tile => tile.addEventListener('click', () => tile.setAttribute('data-clicked-through-dock', ''), { once: true }))
        const point = await frame.evaluate(node => {
          const tile = node.querySelectorAll('[data-slot="side-by-side-tile"]')[1]!.getBoundingClientRect()
          const shell = node.querySelector('[data-shared-composer] [data-slot="composer"]')!.getBoundingClientRect()
          return { x: tile.right - 10, y: shell.top + shell.height / 2 }
        })
        await page.mouse.click(point.x, point.y)
        await expect(tiles.nth(1)).toHaveAttribute('data-clicked-through-dock', '')
      }
    }
    await frame.getByRole('button',{name:'Keep B instead'}).click()
    await expect(frame.locator('[data-slot="comparison-decision"]')).toContainText('You picked B')
    await expect(frame.getByRole('button',{name:'Merge B into main'})).toBeEnabled()
  })
  test(`the tile header stays one line with its state and actions in ${theme}`, async ({ page }) => {
    await page.goto('/preview.html?comparison-verdict=approval')
    await page.getByRole('combobox',{name:'theme',exact:true}).selectOption(theme)
    const frame=page.locator('[data-frame-id="comparison-approval"]')
    await frame.locator('[data-side-by-side-container]').evaluate(node=>{node.style.width='841px'})
    const header=frame.locator('[data-slot="side-by-side-tile"]').nth(1).locator(':scope > header')
    await expect(header).toContainText('Waiting')
    await expect(header).toContainText('Not kept')
    await expect(header.getByRole('button',{name:'Show the browser',exact:true})).toBeVisible()
    expect(await header.evaluate(bar=>{
      const own=bar.getBoundingClientRect()
      return [...bar.querySelectorAll('[data-slot="chip"],button,[data-role="row"]')].every(node=>{const rect=node.getBoundingClientRect();return rect.top>=own.top&&rect.bottom<=own.bottom&&rect.right<=own.right})
    })).toBe(true)
  })
  test(`a saved merge becomes a summary and attempts can be restored in ${theme}`,async({page})=>{
    await page.goto('/preview.html?comparison-verdict=merged')
    await page.getByRole('combobox',{name:'theme',exact:true}).selectOption(theme)
    const frame=page.locator('[data-frame-id="comparison-merged"]')
    await expect(frame.locator('[data-slot="comparison-summary"]')).toContainText('A is in main')
    await expect(frame.locator('[data-slot="side-by-side-grid"]')).toHaveCount(0)
    await frame.getByRole('button',{name:'Show the attempts'}).click()
    await expect(frame.locator('[data-slot="side-by-side-grid"]')).toBeVisible()
    await expect(frame.locator('[data-slot="comparison-decision"]')).toHaveCount(0)
  })
  test(`a stopped Run cannot merge or change its pick in ${theme}`,async({page})=>{
    await page.goto('/preview.html?comparison-verdict=stopped')
    await page.getByRole('combobox',{name:'theme',exact:true}).selectOption(theme)
    const decision=page.locator('[data-slot="comparison-decision"]')
    await expect(decision).toContainText('The judge picked A')
    await expect(decision.getByRole('button',{name:/^Merge /})).toHaveCount(0)
    await expect(decision.getByRole('button',{name:'Refresh merge destination'})).toHaveCount(0)
    await expect(decision.getByRole('button',{name:'Compare changes'})).toBeEnabled()
    await expect(decision.getByRole('button',{name:'Keep B instead'})).toHaveCount(0)
  })
}
