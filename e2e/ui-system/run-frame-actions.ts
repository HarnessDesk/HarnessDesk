import { expect, type Locator } from '@playwright/test'

/** A Run's registered View controls live in its canonical bar. */
export const runBar = (frame: Locator): Locator => frame.locator('[data-slot="top-bar"]:visible').first()

export const selectRunView = async (frame: Locator, value: 'Timeline' | 'Flow'): Promise<void> => {
  await runBar(frame).getByRole('button', { name: 'View', exact: true }).click()
  const choice = frame.page().getByRole('menuitem', { name: value, exact: true })
  await expect(choice).toBeVisible()
  await choice.click()
}

export const stopRun = (frame: Locator): Locator => runBar(frame).getByRole('button', { name: 'Stop run…', exact: true })

/** The phone bar moves its complete verb into More. */
export const clickStopRun = async (frame: Locator): Promise<void> => {
  const direct = stopRun(frame)
  if (await direct.isVisible()) await direct.click()
  else {
    await runBar(frame).getByRole('button', { name: 'More', exact: true }).click()
    await frame.page().getByRole('menuitem', { name: /^Stop run…/ }).click()
  }
}
