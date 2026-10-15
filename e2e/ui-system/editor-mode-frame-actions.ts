import { expect, type Page } from '@playwright/test'

/** Let each explicit editor wall destination settle on its actual live surface. */
export const applyEditorModeFrameActions = async (page: Page, id: string) => {
  if (!id.startsWith('editor-')) return
  const main = page.locator('[data-slot="editor-main"]'), right = page.locator('[data-frame-region="right"]')
  if (id === 'editor-settings') {
    await expect(page.locator('[data-left-top] [data-mode-switch]')).toHaveCount(0)
    // A narrow floating drawer masks the settings labels. Verify its top row,
    // then show the reading surface that carries the new Minimap control.
    if ((page.viewportSize()?.width ?? 1440) < 1000) await page.locator('[data-left-column]:visible [data-left-top]').getByRole('button', { name: 'Hide sidebar', exact: true }).click()
    const minimap = page.getByRole('switch', { name: 'Minimap', exact: true })
    await minimap.scrollIntoViewIfNeeded()
    await expect(minimap).toBeVisible()
    await expect(page.getByText('Minimap', { exact: true })).toBeInViewport()
    return
  }
  if (id === 'editor-team') {
    await expect(page.getByRole('button', { name: 'Editor mode', exact: true })).toBeDisabled()
    return
  }
  if (id === 'editor-conversation') {
    await expect(page.getByRole('button', { name: 'Conversation mode', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
    return
  }
  if (id === 'editor-panel-file' || id === 'editor-panel-popout') {
    await expect(right.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked()
    await right.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(right.locator('.cm-content')).toContainText('Storefront')
    if (id === 'editor-panel-file') return
    await right.locator('.cm-content').focus()
    await page.keyboard.press('Meta+End'); await page.keyboard.insertText('\nCheck the payment reference before retrying.\n')
    await right.getByRole('button', { name: 'Pop out to Editor mode', exact: true }).click()
    await expect(main.locator('.cm-content')).toContainText('Check the payment reference before retrying.')
    await expect(main.getByRole('tab', { name: 'README.md, unsaved', exact: true })).toBeVisible()
    return
  }
  await expect(main.getByRole('tab')).toHaveCount(2)
  await expect(main.locator('[data-slot="file-tab-unsaved"]')).toHaveCount(1)
  if (id === 'editor-preview') {
    await expect(main.getByRole('heading', { name: 'Storefront', exact: true })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  } else {
    await expect(main.locator('.cm-content')).toContainText('retryPayment')
    if (id === 'editor-changes') await expect(main.locator('.cm-deletedChunk')).toBeVisible()
    if (id === 'editor-ask') await expect(page.getByRole('button', { name: 'Ask in chat ⌘L', exact: true })).toBeVisible()
    if (id === 'editor-conflict') {
      await expect(main.getByText('auth.ts changed on disk while you had unsaved edits.', { exact: true })).toBeVisible()
      for (const name of ['Compare', 'Reload', 'Keep mine']) await expect(main.getByRole('button', { name, exact: true })).toBeVisible()
    }
    if (id === 'editor-dirty-close') {
      await main.getByRole('button', { name: 'Close auth.ts', exact: true }).click()
      await expect(page.getByRole('alertdialog').getByRole('button', { name: "Don't save", exact: true })).toBeVisible()
    }
  }
}
