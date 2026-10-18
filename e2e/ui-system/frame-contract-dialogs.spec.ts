import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


test('S18 every dialog preview uses the same title, inset, close, and footer anatomy', async ({ page }) => {
  const footers: number[] = []
  const inspect = async (kind: 'dialog' | 'alertdialog') => {
    const surface = page.getByRole(kind).last()
    await expect(surface).toBeVisible()

    const title = surface.locator('[data-slot="dialog-title"], [data-slot="alert-dialog-title"]').first()
    const titleStyle = await title.evaluate(node => ({
      fontSize: getComputedStyle(node).fontSize,
      fontWeight: getComputedStyle(node).fontWeight,
    }))
    expect(titleStyle).toEqual({ fontSize: '16px', fontWeight: '580' })

    const surfaceBox = (await surface.boundingBox())!
    await expect(surface.locator('[data-slot="dialog-head"] button:not([aria-label="Close"])')).toHaveCount(0)
    const close = surface.locator('button[aria-label="Close"]')
    await expect(close).toBeVisible()
    const closeBox = (await close.boundingBox())!
    expect(Math.abs(surfaceBox.x + surfaceBox.width - closeBox.x - closeBox.width - 24)).toBeLessThanOrEqual(1)
    expect(Math.abs(closeBox.y - surfaceBox.y - 24)).toBeLessThanOrEqual(1)
    await expect(surface.locator('[data-slot="dialog-head"] [data-slot="icon-tile"]')).toHaveCount(0)

    const body = surface.locator('[data-slot="modal-dialog-body"], [data-slot="confirm-body"]').first()
    const bodyPadding = await body.evaluate(node => {
      const style = getComputedStyle(node)
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    })
    expect(bodyPadding).toEqual(['24px', '24px', '24px', '24px'])

    const footer = surface.locator('[data-slot="dialog-footer"]')
    await expect(footer).toHaveCount(1)
    const footerMetrics = await footer.evaluate(node => {
      const style = getComputedStyle(node)
      const button = node.querySelector('button')
      const contentHeight = 2 * Number.parseFloat(style.paddingTop) +
        (button?.getBoundingClientRect().height ?? 0) +
        Number.parseFloat(style.borderTopWidth)
      return {
        height: node.getBoundingClientRect().height,
        expected: Math.max(Number.parseFloat(style.minHeight), contentHeight),
      }
    })
    expect(Math.abs(footerMetrics.height - footerMetrics.expected)).toBeLessThanOrEqual(1)
    footers.push(footerMetrics.height)

    const actions = footer.locator('[data-slot="dialog-footer-actions"]')
    if (await actions.count()) {
      const [footerBox, actionsBox] = await Promise.all([footer.boundingBox(), actions.boundingBox()])
      expect(Math.abs(actionsBox!.x + actionsBox!.width - footerBox!.x - footerBox!.width + 24)).toBeLessThanOrEqual(1)
      const buttons = await actions.locator('button').all()
      if (buttons.length > 1) {
        const [proceed, keep] = await Promise.all(buttons.slice(0, 2).map(button => button.boundingBox()))
        expect(proceed!.x).toBeGreaterThan(keep!.x)
      }
    }
    return { surface, footer }
  }

  await page.goto('/preview.html?team-start=picker')
  let opened = await inspect('dialog')
  await expect(opened.footer.locator('[data-slot="dialog-footer-navigation"]')).toBeVisible()
  const teamSearch = opened.surface.locator('[data-slot="search"]')
  await expect(teamSearch.locator('svg')).toHaveCount(1)
  await expect(teamSearch.locator('input[type="search"]')).toHaveAttribute('placeholder', 'Search Flows…')
  await expect(opened.surface.getByLabel('What should they do?')).toBeVisible()
  await expect(opened.footer.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
  await opened.surface.getByRole('button', { name: 'Write and review', exact: true }).click()
  opened = await inspect('dialog')
  await expect(opened.surface).toHaveAttribute('aria-label', 'New Team')
  await expect(teamSearch).toBeVisible()
  await expect(opened.footer.locator('[data-slot="dialog-footer-actions"] button')).toHaveCount(3)
  await expect(opened.footer.getByRole('button', { name: 'Dry run', exact: true })).toBeVisible()

  await page.goto('/preview.html')
  const gitSheet = page.getByLabel('git sheet')
  const dialogPreviews = [
    ['create branch', 'dialog'],
    ['ask agent', 'dialog'],
    ['worktree manager', 'dialog'],
    ['new worktree', 'dialog'],
    ['folder picker', 'dialog'],
    ['provenance', 'dialog'],
    ['delete session', 'alertdialog'],
    ['commit', 'dialog'],
    ['merge', 'dialog'],
    ['rename branch', 'dialog'],
    ['delete branch', 'dialog'],
    ['tag', 'dialog'],
    ['reset', 'dialog'],
    ['stash', 'dialog'],
    ['diff range', 'dialog'],
  ] as const
  for (const [name, kind] of dialogPreviews) {
    await gitSheet.selectOption(name)
    opened = await inspect(kind)
    await expect(opened.footer.locator('[data-slot="dialog-footer-actions"] button').first()).toBeVisible()
  }

  await openFrame(page, 'frame-wall=library', 'light')
  await page.getByRole('button', {name:'Add skill',exact:true}).click()
  await page.getByRole('menuitem', {name:'Copy from another runtime…',exact:true}).click()
  opened = await inspect('dialog')
  await expect(opened.surface.locator('[data-slot="search"] svg')).toHaveCount(1)
  await opened.surface.getByRole('button', {name:'Cancel',exact:true}).click()

  await openFrame(page, 'frame-wall=plugins', 'light')
  await page.locator('[data-page-destination="plugins"]:visible').getByRole('button', {name:'Add plugin',exact:true}).click()
  opened = await inspect('dialog')
  await opened.surface.getByRole('textbox', {}).fill('/work/sample-plugin')
  await opened.surface.getByRole('button', {name:'Continue',exact:true}).click()
  opened = await inspect('dialog')
  await expect(opened.surface.getByRole('button', {name:'Install and enable',exact:true})).toBeVisible()

  expect(new Set(footers).size).toBe(1)
})
