import { expect, test } from '@playwright/test'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame, expectTrailingChildGaps, expectSubmenuChevrons } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) for (const width of [1440, 720]) {
  test(`Frame transcript overflow stays inside main at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-overflow=1', theme, width)
    const main = page.locator('[data-slot="workbench-main"]')
    const longToken = 'x'.repeat(600)
    await expect(main).toContainText(longToken)
    expect(await main.evaluate(node => node.scrollWidth)).toBe(await main.evaluate(node => node.clientWidth))
  })
}

// Frame fix: transcript, composer and right-panel owner findings.
for (const theme of WALL_THEMES) {
  test(`Frame fix 2 project view uses one submenu chevron size and ink in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme, 1280)
    await page.getByRole('button', { name: 'How this list is shown', exact: true }).click()
    const menu = page.locator('[role="menu"]:visible').last()
    const submenus = menu.locator('[data-slot="dropdown-menu-sub-trigger"]')
    await expect(submenus).toHaveCount(2)
    await expect(submenus.nth(0)).toContainText('Recency')
    await expect(submenus.nth(1)).toContainText('All agents')
    await expectSubmenuChevrons(page, menu)
  })

  test(`Frame fix 2 Work in separates a selected value from its check in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft&frame-work-in=linked', theme, 1280)
    const track = page.locator('[data-composer-track="work-in"]')
    await track.getByRole('button').click()
    const menu = page.locator('[data-popup-kind]:visible').last()
    const main = menu.locator('[data-menu-row]').filter({ hasText: 'Main checkout' })
    await expect(main.locator('[data-menu-trailing]')).toContainText('main')
    await expect(main.locator('[data-menu-trailing] svg')).toBeVisible()
    await expectTrailingChildGaps(page, menu)
  })

  test(`Frame composer keeps short control values whole at 1280 in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft&frame-composer-labels=1', theme, 1280)
    const tools = page.locator('[data-slot="composer-tools"]:visible').last()
    for (const [trackName, value] of [['permissions', 'Workspace'], ['mode', 'Default']] as const) {
      const track = tools.locator(`[data-composer-track="${trackName}"]`)
      const trigger = track.getByRole('button')
      if (trackName === 'mode') {
        // Composer selected values: a folded draft Mode is a mark, never a lone initial.
        await expect(track).toHaveAttribute('data-folded', 'true')
        await expect(trigger).toHaveAccessibleName('Default — Mode')
        await expect(trigger).toHaveAttribute('title', 'Default — Mode')
        await expect(trigger.locator('svg').first()).toBeVisible()
        await expect(trigger.locator('[data-slot="text"][data-role="row"]')).toHaveCount(0)
      } else {
        await expect(trigger).toContainText(value)
        const label = trigger.locator('[data-slot="text"][data-role="row"]')
        const dimensions = await label.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }))
        expect(dimensions.scroll, `${trackName} label should fit without ellipsis`).toBeLessThanOrEqual(dimensions.width)
      }
    }
    await openFrame(page, 'frame-wall=conversation&frame-composer-values=1', theme, 1280)
    const mode = page.locator('[data-composer-track="mode"]:visible').last()
    await expect(mode).toContainText('Default')
    const label = mode.locator('[data-slot="chip-words"] > span:not(.sr-only)')
    const dimensions = await label.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }))
    expect(dimensions.scroll, 'a live Mode retains its whole selected value').toBeLessThanOrEqual(dimensions.width)
  })

  test(`Frame empty conversation state centers its heading and sentence in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft', theme)
    const empty = page.locator('[data-slot="conversation-empty-state"]:visible').first()
    const centers = await empty.evaluate(node => {
      const read = (selector: string) => {
        const target = node.querySelector(selector)!
        const range = document.createRange(); range.selectNodeContents(target)
        const box = range.getBoundingClientRect()
        return box.left + box.width / 2
      }
      return { heading: read('[data-role="page"]'), sentence: read('[data-role="prose"]') }
    })
    expect(Math.abs(centers.heading - centers.sentence)).toBeLessThanOrEqual(1)
    expect(await empty.locator('[data-role="prose"]').evaluate(node => getComputedStyle(node).textAlign)).toBe('center')
  })

  test(`Frame message actions rest hidden and appear on message hover or focus in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-conversation-actions=1', theme)
    const userMessage = page.locator('[data-part="prompt"] [data-slot="message"]').first()
    const userActions = page.locator('[data-message-actions="user"]').first()
    const answerMessage = page.locator('[data-part="answer"] [data-slot="message"]').first()
    const answerActions = page.locator('[data-message-actions="assistant"]').last()
    await expect(userActions).toHaveCSS('opacity', '0')
    await expect(answerActions).toHaveCSS('opacity', '0')
    const userBox = (await userMessage.boundingBox())!
    await page.mouse.move(userBox.x + userBox.width / 2, userBox.y + userBox.height / 2)
    await expect(userActions).toHaveCSS('opacity', '1')
    const answerButton = answerActions.getByRole('button').first()
    await answerButton.focus()
    await expect(answerActions).toHaveCSS('opacity', '1')
    const answerBox = (await answerMessage.boundingBox())!
    await page.mouse.move(answerBox.x + answerBox.width / 2, answerBox.y + answerBox.height / 2)
    await expect(answerActions).toHaveCSS('opacity', '1')
  })

  test(`Frame floating Details panel leaves main content and Send clear at 1100 and 720 in ${theme}`, async ({ page }) => {
    for (const width of [1100, 720]) {
      await openFrame(page, 'frame-wall=conversation', theme, width)
      const top = page.locator('[data-slot="top-bar"]:visible')
      await top.getByRole('button', { name: 'Details', exact: true }).click()
      const mainContent = page.locator('[data-frame-region="main"] [data-pane-id]:visible').last()
      const transcript = page.locator('[data-live-transcript]:visible').last()
      const composer = page.locator('[data-slot="composer"]:visible').last()
      const send = composer.locator('[data-slot="composer-send"]')
      const panel = page.locator('[data-frame-region="right"]:visible')
      await expect(panel).toBeVisible()
      await expect(page.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-panel-floats', 'true')
      const panelX = (await panel.boundingBox())!.x
      for (const content of [mainContent, transcript, composer, send]) {
        const box = (await content.boundingBox())!
        expect(box.x + box.width, `${await content.getAttribute('data-slot') ?? 'main content'} must stop before the float`).toBeLessThanOrEqual(panelX + 1)
      }
    }
  })

  test(`Frame Details caveats use the Run note column and type in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft', theme)
    await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Details', exact: true }).click()
    const panel = page.locator('[data-slot="tool-body"]:visible')
    const note = panel.locator('[data-slot="tool-prose"]').filter({ hasText: 'Not recorded for this draft:' }).first()
    await expect(note).toBeVisible()
    const geometry = await note.evaluate(node => {
      const text = node.querySelector<HTMLElement>('[data-slot="text"]')!, style = getComputedStyle(text)
      const key = node.parentElement!.querySelector('dt')!
      const probe = document.createElement('span'); probe.style.color = 'var(--hd-secondary-foreground)'; node.append(probe)
      const secondaryColor = getComputedStyle(probe).color; probe.remove()
      return { x: text.getBoundingClientRect().x, keyX: key.getBoundingClientRect().x, size: parseFloat(style.fontSize), color: style.color, secondaryColor }
    })
    expect(geometry.size).toBe(12)
    expect(geometry.x).toBe(geometry.keyX)
    expect(geometry.color).toBe(geometry.secondaryColor)
    const planNote = panel.locator('[data-slot="tool-prose"]').filter({ hasText: 'No plan yet.' })
    await expect(planNote).toBeVisible()
    const planStyle = await planNote.locator('[data-slot="text"]').evaluate(node => {
      const probe = document.createElement('span'); probe.style.color = 'var(--hd-secondary-foreground)'; node.append(probe)
      const secondaryColor = getComputedStyle(probe).color; probe.remove()
      const style = getComputedStyle(node)
      return { size: parseFloat(style.fontSize), color: style.color, secondaryColor }
    })
    expect(planStyle.size).toBe(12)
    expect(planStyle.color).toBe(planStyle.secondaryColor)
  })

  test(`Frame empty right panel tools have no rest-state footer facts in ${theme}`, async ({ page }) => {
    for (const tool of ['changes', 'agents', 'activity', 'trajectory'] as const) {
      await openFrame(page, `frame-wall=conversation&frame-tool=${tool}`, theme)
      const footer = page.locator('[data-slot="tool-footer"]:visible, [data-slot="content-footer"]:visible')
      const footerText = (await footer.allTextContents()).join(' ')
      expect(footerText).not.toMatch(/0 started|0 files(?:\s*·\s*against main)?|0 events|0 sessions|0m measured/i)
    }
    await openFrame(page, 'frame-wall=conversation', theme)
    const top = page.locator('[data-slot="top-bar"]:visible')
    await top.getByRole('button', { name: 'Browser', exact: true }).click()
    const browserFooter = page.locator('[data-slot="tool-footer"]:visible, [data-slot="content-footer"]:visible')
    const browserFooterText = (await browserFooter.allTextContents()).join(' ')
    expect(browserFooterText).not.toMatch(/Idle|Never your own browser profile/i)
  })

  test(`Frame usage ring is named once in its empty popover in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft', theme)
    const tools = page.locator('[data-slot="composer-tools"]:visible').last()
    const usage = tools.getByRole('button', { name: 'Usage', exact: true })
    await expect(usage).toContainText('Usage')
    await usage.click()
    const card = page.locator('[data-popup-kind="info-card"]:visible').last()
    await expect(card.getByText('Usage', { exact: true })).toHaveCount(1)
    await expect(card.getByText('No usage yet', { exact: true })).toHaveCount(1)
  })
}
