import { expect, type Locator } from '@playwright/test'

/** The preview's current project folds Teams and conversations into five rows. */
export async function revealPreviewConversation(sidebar: Locator, title: string) {
  const conversation = sidebar.getByRole('button', { name: title, exact: true })
  if (await conversation.count() === 0) {
    await sidebar.locator('[data-project-root]').first().getByRole('button', { name: 'Show more', exact: true }).click()
  }
  await expect(conversation).toBeVisible()
  return conversation
}
