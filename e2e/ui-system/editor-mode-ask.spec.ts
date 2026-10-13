import { expect, test, type Locator } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

const select = async (content: Locator) => content.evaluate(node => {
  ;(node.closest('.cm-content') as HTMLElement | null)?.focus()
  const range = document.createRange(); range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return selection.toString()
})

for (const theme of ['light', 'dark'] as const) test(`Ask quotes Source, Changes and Preview into the same retained draft in ${theme}`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openFrame(page, 'frame-wall=conversation&frame-editor=source', theme, 1440)
  const main = page.locator('[data-slot="editor-main"]')
  const composer = page.locator('[data-frame-region="right"] textarea')
  await composer.fill('Please inspect this')
  const transcript = await page.locator('[data-live-transcript]').textContent()
  await page.locator('[data-work-tool="details"]').click()
  const selected = await select(main.locator('.cm-line').first())
  const action = page.getByRole('button', { name: 'Ask in chat ⌘L', exact: true })
  await expect(action).toBeVisible()
  const before = await action.boundingBox(), source = await main.locator('.cm-line').first().boundingBox()
  expect(before!.y + before!.height).toBeLessThanOrEqual(source!.y + 1)
  await page.screenshot({ path: testInfo.outputPath(`ask-source-${theme}.png`) })
  await action.click()
  await expect(page.locator('[data-work-tool="conversation"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(composer).toBeFocused()
  const quote = `app/checkout.ts:1\n\`\`\`typescript\n${selected}\n\`\`\`\n`
  await expect(composer).toHaveValue(`Please inspect this\n${quote}`)
  // A stale retained selection cannot answer a shortcut typed in the composer.
  await page.keyboard.press('Meta+l')
  await expect(composer).toHaveValue(`Please inspect this\n${quote}`)
  await main.getByRole('radio', { name: /^Changes/ }).click()
  await expect(main.locator('.cm-deletedChunk')).toBeVisible()
  const change = await select(main.locator('.cm-line').filter({ hasText: 'Checkout' }).first())
  await expect(action).toBeVisible()
  await page.keyboard.press('Meta+l')
  await expect(composer).toHaveValue(`Please inspect this\n${quote}\napp/checkout.ts:1\n\`\`\`typescript\n${change}\n\`\`\`\n`)
  await expect(composer).toBeFocused()
  // Make this a scrollable file, then retain a current-document selection
  // while selecting the separate native removed-line widget.
  await main.locator('.cm-content').focus()
  await page.keyboard.press('Meta+End')
  await page.keyboard.insertText('\n' + 'unchanged follow-up line\n'.repeat(50))
  await select(main.locator('.cm-line').filter({ hasText: 'Checkout' }).first())
  const removed = await select(main.locator('.cm-deletedText').first())
  await expect(action).toBeVisible()
  const draftBeforeRemoved = await composer.inputValue()
  const scrolled = await main.locator('.cm-scroller').evaluate(node => {
    node.scrollTop = 12
    node.dispatchEvent(new Event('scroll'))
    return node.scrollTop
  })
  expect(scrolled).toBeGreaterThan(0)
  await expect(action).toBeVisible()
  await action.click()
  await expect(composer).toHaveValue(`${draftBeforeRemoved}\napp/checkout.ts:1\n\`\`\`typescript\n${removed}\n\`\`\`\n`)
  await expect(composer).toBeFocused()
  await main.getByRole('tab', { name: 'README.md', exact: true }).click()
  const previewText = await select(main.locator('p').first())
  await expect(action).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`ask-preview-${theme}.png`) })
  await action.click()
  expect(await composer.inputValue()).toContain(`README.md:3\n\`\`\`markdown\n${previewText}\n\`\`\`\n`)
  await expect(composer).toBeFocused()
  await expect(page.locator('[data-live-transcript]')).toHaveText(transcript ?? '')
  expect(errors).toEqual([])
})
