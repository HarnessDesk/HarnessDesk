import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: Browser and Conversation tiles clear the shared dock together`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    // Independent preview stores default to the system theme too.
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?side-by-side')
    await page.locator('label').filter({ hasText: /^theme/ }).locator('select').first().selectOption(theme)
    const frame = page.locator('[data-frame-id="side-by-side-browsers"]')
    const grid = frame.locator('[data-slot="side-by-side-grid"]')
    await frame.locator('[data-side-by-side-container]').evaluate(node => {
      const grid = node.querySelector('[data-slot="side-by-side-grid"]')!
      const delta = 1200 - grid.getBoundingClientRect().width
      ;(node as HTMLElement).style.width = `${node.getBoundingClientRect().width + delta}px`
      ;(node as HTMLElement).style.maxWidth = 'none'
    })
    await expect.poll(async () => (await grid.boundingBox())?.width).toBe(1200)
    const tiles = grid.locator('[data-slot="side-by-side-tile"]')
    await tiles.nth(1).getByRole('radio', { name: 'Conversation', exact: true }).click()
    await expect(tiles.nth(0).locator('iframe')).toBeVisible()
    await expect(tiles.nth(1).locator('[data-live-transcript]')).toBeVisible()
    const dock = grid.locator('[data-shared-composer]')
    const box = dock.locator('[data-slot="composer-text"]')
    for (const draft of ['Compare the retry budget.', 'Compare the retry budget.\n'.repeat(24)]) {
      await box.fill(draft)
      // The whole browser surface, including any footer controls, must end
      // above the dock. Both bodies inherit the same measured clearance.
      await expect.poll(() => grid.evaluate(node => {
        const dock = node.querySelector('[data-shared-composer]')!
        const tiles = [...node.querySelectorAll('[data-slot="side-by-side-tile"]')]
        const browser = tiles[0]!.querySelector('iframe')!.closest('[data-slot="tool-pane"]')!
        const bodies = tiles.map(tile => tile.querySelector('[data-clear-composer]')!)
        const height = dock.getBoundingClientRect().height
        return browser.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top + 1
          && bodies.every(body => Math.abs(parseFloat(getComputedStyle(body).getPropertyValue('--shared-composer-h')) - height) <= 1)
      })).toBe(true)
      if (process.env.HD_MERGED_FRAMES && !draft.includes('\n')) {
        mkdirSync(process.env.HD_MERGED_FRAMES, { recursive: true })
        await grid.scrollIntoViewIfNeeded()
        await page.evaluate(async () => { await document.fonts.ready })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
        await grid.screenshot({ path: join(process.env.HD_MERGED_FRAMES, `merged-main-${theme}.png`), animations: 'disabled' })
      }
    }
    await tiles.nth(0).getByRole('button', { name: 'Expand Alpha', exact: true }).click()
    await expect(dock).toBeHidden()
    await expect.poll(() => tiles.nth(0).evaluate(tile => {
      const browser = tile.querySelector('iframe')!.closest('[data-slot="tool-pane"]')!
      return Math.abs(browser.getBoundingClientRect().bottom - tile.getBoundingClientRect().bottom)
    })).toBeLessThanOrEqual(1)
    await tiles.nth(0).getByRole('button', { name: 'Collapse Alpha', exact: true }).click()
    await expect(dock).toBeVisible()
    await expect(box).toHaveValue('Compare the retry budget.\n'.repeat(24))
  })

  test(`${theme}: Settings dismisses shared recipients and still answers Escape`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 })
    await page.route('**/src/preview/main.tsx*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('preview React module import was not found')
      await route.fulfill({ response, body: `${source}
        import pickerReact from ${JSON.stringify(reactUrl)};
        import { Mount as PickerMount } from '/src/preview/harness.tsx';
        import { Settings as PickerSettings } from '/src/components/Settings.tsx';
        import { AppWindowMode as PickerWindowMode } from '/src/components/AppWindow.tsx';
        const pickerHost = document.createElement('div');
        pickerHost.setAttribute('data-picker-settings', '');
        document.body.append(pickerHost);
        const h = pickerReact.createElement;
        function PickerSettingsRig() {
          const [opened, setOpened] = pickerReact.useState(false);
          window.__openPickerSettings = () => setOpened(true);
          return opened ? h(PickerMount, null, h(PickerWindowMode.Provider, { value: 'modal' }, h(PickerSettings, {
            section: 'general',
            onSection: () => {}, onSignIn: () => {}, onClose: () => setOpened(false),
          }))) : null;
        }
        createRoot(pickerHost).render(h(PickerSettingsRig));
      ` })
    })
    await page.goto('/preview.html?side-by-side')
    await page.locator('label').filter({ hasText: /^theme/ }).locator('select').first().selectOption(theme)
    const frame = page.locator('[data-frame-id="side-by-side-two"]')
    const box = frame.locator('[data-shared-composer] [data-slot="composer-text"]')
    const draft = 'Compare the retry budget. @'
    await box.fill(draft)
    const picker = page.locator('[data-slot="popover-surface"][role="listbox"][data-width="trigger"]')
    await expect(picker).toBeVisible()
    await expect(box).toBeFocused()
    // Open through the fixture without an outside pointer press dismissing
    // the picker first; this isolates Settings' global dismissal contract.
    await page.evaluate(() => (window as unknown as { __openPickerSettings: () => void }).__openPickerSettings())
    const search = page.locator('[data-picker-settings]').getByRole('searchbox', { name: 'Search settings', exact: true })
    await expect(search).toBeVisible()
    if (process.env.HD_DISMISS_FRAMES) {
      mkdirSync(process.env.HD_DISMISS_FRAMES, { recursive: true })
      await page.evaluate(async () => { await document.fonts.ready })
      await page.screenshot({ path: join(process.env.HD_DISMISS_FRAMES, `settings-${theme}.png`), animations: 'disabled' })
    }
    await expect(picker).toHaveCount(0)
    await expect(box).toHaveValue(draft)
    await search.focus()
    await search.press('Escape')
    await expect(search).toHaveCount(0)
    await expect(box).toHaveValue(draft)
    await box.focus()
    await box.press('End')
    await box.press('a')
    await expect(picker).toBeVisible()
    await box.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(box).toHaveValue(`${draft}a`)
  })

  for (const draft of ['short', 'tall'] as const) {
    test(`${theme}: shared composer recipients remain clickable with a ${draft} draft`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 800 })
      await page.goto('/preview.html?side-by-side')
      const frame = page.locator('[data-frame-id="side-by-side-two"]')
      const grid = frame.locator('[data-slot="side-by-side-grid"]')
      await expect(grid).toBeVisible()
      await page.locator('label').filter({ hasText: /^theme/ }).locator('select').first().selectOption(theme)
      await frame.locator('[data-side-by-side-container]').evaluate(node => {
        const grid = node.querySelector('[data-slot="side-by-side-grid"]')!
        const delta = 1200 - grid.getBoundingClientRect().width
        ;(node as HTMLElement).style.width = `${node.getBoundingClientRect().width + delta}px`
        ;(node as HTMLElement).style.maxWidth = 'none'
      })
      await expect.poll(async () => (await grid.boundingBox())?.width).toBe(1200)
      const dock = grid.locator('[data-shared-composer]')
      const box = dock.locator('[data-slot="composer-text"]')
      await box.fill(draft === 'short' ? '@' : `${'Compare the retry budget.\n'.repeat(24)}@`)
      const recipient = page.getByRole('option', { name: /Alpha.*Retry the checkout call when the service is unavailable/ }).last()
      await expect(recipient).toBeVisible()
      await box.scrollIntoViewIfNeeded()
      await page.evaluate(async () => { await document.fonts.ready })
      if (process.env.HD_PICKER_FRAMES) {
        mkdirSync(process.env.HD_PICKER_FRAMES, { recursive: true })
        await grid.screenshot({ path: join(process.env.HD_PICKER_FRAMES, `${draft}-${theme}.png`), animations: 'disabled' })
      }
      // DOM visibility alone misses an ancestor's scrolling clip. The row's
      // full height must receive a pointer, including a partly clipped row.
      await expect.poll(() => recipient.evaluate(node => {
        const rect = node.getBoundingClientRect()
        return [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].every(y =>
          node.contains(document.elementFromPoint(rect.left + rect.width / 2, y)),
        )
      })).toBe(true)
      await recipient.click({ timeout: 5000 })
      await expect(dock.locator('[data-slot="composer-chip"]')).toContainText('Alpha')
      await expect(box).toBeFocused()
      expect(await dock.evaluate(node => node.getBoundingClientRect().height))
        .toBeLessThanOrEqual((await grid.boundingBox())!.height / 2 + 1)
    })
  }
}
