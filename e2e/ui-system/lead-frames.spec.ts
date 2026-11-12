import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const scenes = ['pending-plan', 'result-person-gate', 'following', 'handback-running', 'push-card', 'branch-released', 'branch-rewritten', 'handback-limit', 'settings-triggers', 'autonomy-proposal', 'autonomy-proposal-words', 'settings-autonomy', 'settings-memory', 'wake-ledger'] as const
for (const theme of ['light', 'dark']) for (const scene of scenes) test(`Lead synthetic ${scene} in ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 980 })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' || new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort())
  await page.goto(`/preview.html?lead-synthetic=${scene}&theme=${theme}`)
  const frame = page.locator(`[data-frame-id="lead-${scene}"]`)
  await expect(frame).toBeVisible()
  if (scene === 'settings-triggers') {
    await page.getByText('Triggers', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('switch', { name: 'Checks failed' })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Checks failed on acme/widgets' })).toBeVisible()
  } else if (scene === 'pending-plan') await expect(frame.locator('[data-slot="lead-plan-flow"]')).toBeVisible()
  else if (scene === 'result-person-gate' || scene === 'push-card') await expect(frame.getByRole('button', { name: 'Accept and open PR', exact: true })).toBeVisible()
  else if (scene.startsWith('branch-')) await expect(frame.getByRole('button', { name: 'Take the branch back', exact: true })).toBeVisible()
  else if (scene === 'handback-running') await expect(frame.locator('[data-slot="lead-live-line"]')).toHaveText('Repairing checks · round 2')
  else if (scene === 'handback-limit') await expect(frame.locator('[data-lead-card="handback-limit"]')).toContainText('Automatic repairs reached their limit')
  else if (scene === 'autonomy-proposal') {
    const cards = frame.locator('[data-slot="lead-settings-proposals"]')
    await expect(cards).toContainText('Desk-change reports: Act → Observe')
    await expect(cards).toContainText('Takes effect at once')
    await expect(cards.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(2)
    // The card sits inside the thread, under the reply's text: same left edge, never past the right.
    const thread = frame.getByRole('region', { name: / thread$/ })
    const [card, region, reply] = await Promise.all([cards.boundingBox(), thread.boundingBox(), frame.getByText('Those are settings, not notes').boundingBox()])
    expect(card && region && reply && Math.abs(card.x - reply.x) <= 1 && card.x + card.width <= region.x + region.width).toBe(true)
    // An added line shows the words the section will hold, the line marked as the append it is (#2152).
    await expect(cards.getByLabel('What changes in How to talk to me')).toContainText('+ Lead every report with the conclusion.')
  }
  else if (scene === 'settings-autonomy') {
    // A first change can be rolled back: the shipped words close the section's history, with Restore (#2152).
    await frame.getByRole('button', { name: 'Edit', exact: true }).first().click()
    const versions = page.getByRole('dialog').getByLabel('Versions of How to talk to me')
    await expect(versions.locator('[data-slot="row"]').filter({ hasText: 'Shipped words' }).getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    await page.getByRole('dialog').screenshot({ path: join(process.env.LEAD_D_FRAMES_DIR ?? info.outputPath('frames'), `settings-rules-dialog-${theme}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await frame.getByLabel('Autonomy changes').scrollIntoViewIfNeeded()
  }
  else if (scene === 'settings-memory') {
    // After Forget, history says what was forgotten and what each change did (#2152).
    const forgot = frame.locator('[data-slot="row"]').filter({ hasText: '1 forgotten' })
    await forgot.scrollIntoViewIfNeeded()
    await expect(forgot).toBeVisible()
    await expect(frame.locator('[data-slot="row"]').filter({ hasText: 'Forgotten' }).filter({ hasText: '1 added' })).toBeVisible()
    await expect(frame).not.toContainText('no change')
  }
  else if (scene === 'wake-ledger') {
    // The ledger sits after the latest reply, not above the conversation (#2149).
    const [ledger, reply] = await Promise.all([frame.getByRole('region', { name: 'Wake ledger' }).boundingBox(), frame.getByText('I will look at the nightly run').boundingBox()])
    expect(ledger && reply && ledger.y > reply.y + reply.height).toBe(true)
  }
  else if (scene === 'autonomy-proposal-words') {
    const cards = frame.locator('[data-slot="lead-settings-proposals"]')
    const row = cards.locator('[data-slot="row"]')
    await expect(row).toHaveCount(1)
    // The section's new words sit inside the row Apply answers, never loose after the list.
    const words = row.getByLabel('What changes in What counts as done')
    await expect(words).toContainText('+ Done means every check run is green and the person reviewed it.')
    await expect(row.getByRole('button', { name: 'Apply', exact: true })).toBeVisible()
    const [card, box, inside, title, apply, reply] = await Promise.all([cards.boundingBox(), row.boundingBox(), words.boundingBox(), row.locator('[data-slot="row-title"]').boundingBox(),
      row.getByRole('button', { name: 'Apply', exact: true }).boundingBox(), frame.getByText('I proposed new words for that section').boundingBox()])
    expect(card && reply && Math.abs(card.x - reply.x) <= 1).toBe(true)
    // The words' plate starts on the row's text edge, keeps inside the row, and stops short of the row's buttons.
    expect(box && inside && title && apply && Math.abs(inside.x - title.x) <= 1 && inside.y >= box.y && inside.y + inside.height <= box.y + box.height + 1 && inside.x + inside.width < apply.x).toBe(true)
  }
  else await expect(frame.locator('[data-slot="lead-pr-status"]')).toContainText('#12')
  expect(await frame.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const directory = process.env.LEAD_D_FRAMES_DIR ?? info.outputPath('frames')
  await mkdir(directory, { recursive: true })
  await frame.screenshot({ path: join(directory, `${scene}-${theme}.png`), animations: 'disabled' })
})

for (const theme of ['light', 'dark']) test(`Lead plan and four-action result wrap at a narrow short viewport in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 540 })
  for (const scene of ['pending-plan', 'result-person-gate']) {
    await page.goto(`/preview.html?lead-synthetic=${scene}&theme=${theme}`)
    const frame = page.locator(`[data-frame-id="lead-${scene}"]`)
    await expect(frame).toBeVisible()
    expect(await frame.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    const action = frame.getByRole('button', { name: scene === 'pending-plan' ? 'Approve' : 'Accept and open PR', exact: true })
    await expect(action).toBeVisible()
    expect(await action.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth })).toBe(true)
  }
})

for (const theme of ['light', 'dark']) test(`an unavailable Lead has one runtime reason and no retry in ${theme}`, async ({ page }, info) => {
  await page.goto(`/preview.html?lead-synthetic=runtime-unavailable&theme=${theme}`)
  const frame = page.locator('[data-frame-id="lead-runtime-unavailable"]')
  await expect(frame.getByText("Lead can't start here: no runtime on this desk keeps its network blocked by the permission model.")).toHaveCount(1)
  await expect(frame.getByText("This app's runtime (Node 24.19.0) rejected the Lead flags (exit 9).", { exact: true })).toHaveCount(1)
  await expect(frame.getByRole('textbox', { name: 'Goal or message' })).toBeDisabled()
  await expect(frame.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(frame.getByRole('alert')).toHaveCount(0)
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  await frame.screenshot({ path: info.outputPath(`runtime-unavailable-${theme}.png`), animations: 'disabled' })
})

for (const theme of ['light', 'dark']) test(`the Lead's rail carries its goal, plan, workers and limits in ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/preview.html?lead-synthetic=app-shell&theme=${theme}`)
  const frame = page.locator('[data-frame-id="lead-app-shell"]')
  const rail = frame.locator('[data-frame-region="rail"]')
  await expect(frame.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-rail-open', 'true')
  for (const label of ['Goal', 'Plan', 'Workers', 'Spend']) await expect(rail.getByRole('region', { name: label })).toBeVisible()
  await expect(rail.getByRole('region', { name: 'Plan' })).toContainText('Waiting for you')
  await expect(rail.getByRole('button', { name: 'Change limits' })).toBeVisible()
  await expect(frame.getByRole('form', { name: 'Lead composer' })).not.toContainText('Up to')
  await frame.getByRole('button', { name: 'Toggle rail' }).click()
  await expect(frame.locator('[data-slot="fixed-shell"]')).toHaveAttribute('data-rail-open', 'false')
  await frame.getByRole('button', { name: 'Toggle rail' }).click()
  await frame.screenshot({ path: info.outputPath(`app-shell-rail-${theme}.png`), animations: 'disabled' })
})

for (const theme of ['light', 'dark']) test(`#2168: What happened? is one click in the Lead's top bar, never under the rail, in ${theme}`, async ({ page }, info) => {
  // A window as narrow as the sitting's: the rail is drawn over the thread here, and it used to hold the Recap card.
  await page.setViewportSize({ width: 820, height: 640 })
  await page.goto(`/preview.html?lead-synthetic=app-shell&theme=${theme}`)
  const frame = page.locator('[data-frame-id="lead-app-shell"]')
  const recap = frame.getByRole('button', { name: 'What happened?', exact: true })
  await expect(recap).toBeVisible()
  await expect(frame.locator('[data-frame-region="rail"]').getByRole('button', { name: 'What happened?' })).toHaveCount(0)
  if (await frame.locator('[data-slot="fixed-shell"]').getAttribute('data-rail-open') !== 'true') await frame.getByRole('button', { name: 'Toggle rail' }).click()
  // With the rail open, nothing is drawn over the button: the point under its centre is the button itself.
  const box = (await recap.boundingBox())!
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-lead-recap]'), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true)
  const directory = process.env.LEAD_D_FRAMES_DIR ?? info.outputPath('frames')
  await mkdir(directory, { recursive: true })
  await frame.screenshot({ path: join(directory, `recap-top-bar-${theme}.png`), animations: 'disabled' })
})
