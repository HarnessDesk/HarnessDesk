import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


test('Lists R9 empty Teams centres the complete empty state in the page body', async ({ page }) => {
  await openFrame(page, 'frame-wall=teams&frame-empty=1', 'light', 1440)
  const body = page.locator('[data-page-destination="teams"]:visible')
  const empty = body.locator('[data-slot="empty-state"][data-variant="panel"]')
  await expect(empty).toBeVisible()
  await expect(empty.locator('svg')).toHaveCount(1)
  await expect(empty.getByRole('heading', { name: 'No active Teams', exact: true })).toBeVisible()
  await expect(empty.getByText(/Create a Team/)).toBeVisible()
  await expect(empty.getByRole('button', { name: 'New Team', exact: true })).toBeVisible()

  const geometry = await empty.evaluate(node => {
    const region = node.getBoundingClientRect()
    const children = [...node.children].map(child => child.getBoundingClientRect())
    const contentTop = Math.min(...children.map(box => box.top))
    const contentBottom = Math.max(...children.map(box => box.bottom))
    return { regionCenter: region.y + region.height / 2, contentCenter: contentTop + (contentBottom - contentTop) / 2 }
  })
  expect(Math.abs(geometry.regionCenter - geometry.contentCenter)).toBeLessThanOrEqual(1)
})

test('Lists R9 Library warning fills the List measure', async ({ page }) => {
  await openFrame(page, 'frame-wall=library', 'light', 1440)
  const library = page.locator('[data-page-destination="library"]:visible')
  const warning = library.locator('[data-slot="alert"]')
  const list = library.locator('[data-slot="skill-list"]')
  await expect(warning).toBeVisible()
  await expect(list).toBeVisible()
  const widths = await Promise.all([warning, list].map(async locator => (await locator.boundingBox())!.width))
  expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(1)
})

test('Lists R9 Library list description occupies no more than two lines', async ({ page }) => {
  await openFrame(page, 'frame-wall=library', 'light', 1440)
  const description = page.locator('[data-page-destination="library"]:visible [data-skill-description]').first()
  await description.evaluate(node => {
    node.textContent = 'Canvas checks compare the exact output, state and layout of a page. '.repeat(18)
  })
  const geometry = await description.evaluate(node => {
    const box = node.getBoundingClientRect()
    const line = parseFloat(getComputedStyle(node).lineHeight)
    return { height: box.height, line }
  })
  expect(geometry.height).toBeLessThanOrEqual(geometry.line * 2 + 1)
})

test('Lists R9 Agents show each seat mark and the shortened source path', async ({ page }) => {
  await openFrame(page, 'frame-wall=agents', 'light', 1440)
  const agents = page.locator('[data-page-destination="agents"]:visible')
  const rows = agents.locator('[data-kind="record"]')
  await expect(rows).toHaveCount(6)
  const faceKinds = await rows.locator('[data-slot="row-face"]').evaluateAll(nodes => nodes.map(node => ({
    runtime: node.querySelector('svg[class*="brand-"]') !== null,
    avatar: node.querySelector('[data-slot="monogram"]') !== null,
    generic: node.querySelector('svg.lucide-bot') !== null,
  })))
  expect(faceKinds.every(face => (face.runtime || face.avatar) && !face.generic)).toBe(true)

  const source = agents.locator('section[aria-label="In HarnessDesk"] [data-slot="middle-truncate"]')
  await expect(source).toContainText('HarnessDesk/.harnessdesk/agents')
  expect(await source.getAttribute('title')).toMatch(/HarnessDesk\/\.harnessdesk\/agents$/)
})

test('Lists R9 Library filter and skill detail use group-level facts', async ({ page }) => {
  await openFrame(page, 'frame-wall=library', 'light', 1440)
  await page.locator('[data-slot="popover-trigger"][title="Declared by"]').click()
  await expect(page.getByRole('menuitemradio', { name: 'Any agent', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  const skill = page.locator('[data-slot="skill-row"]').filter({ hasText: 'systematic-debugging' })
  await expect(skill).toBeVisible()
  await skill.click()
  const dialog = page.getByRole('dialog')
  const group = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Which agents load it', exact: true }) })
  await expect(group.getByRole('listitem')).toHaveCount(3)
  await expect(group).toContainText('Installed where this agent does not look')
  expect(await group.locator('text=Installed where this agent does not look').count()).toBe(1)
})

test('Lists R9 Plugins show Active and Built in on the state row', async ({ page }) => {
  await openFrame(page, 'frame-wall=plugins&frame-plugin-page=detail', 'light', 1440)
  const plugin = page.locator('[data-page-destination="plugins"]:visible')
  const row = plugin.locator('[data-slot="row"]').filter({ hasText: 'Active' }).first()
  await expect(row.locator('[data-slot="row-title"]')).toContainText('Active')
  await expect(row.locator('[data-slot="row-title-chip"]')).toHaveText('Built in')
  await expect(plugin.locator('p').filter({ hasText: 'Built in' })).toHaveCount(0)
})
