import { readdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { bounded, buildLeadRenderer, openLeadHost } from './lead-host'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
let renderer: string
test.beforeAll(async ({}, info) => { test.setTimeout(120_000); renderer = info.outputPath('renderer'); await buildLeadRenderer(renderer) })
const destinations = [['Agents', 'agents'], ['Flows', 'flows'], ['Dashboard', 'dashboard']] as const
const structure = (node: Element) => ({
  headings: [...node.querySelectorAll('h1,h2,h3')].map(element => [element.tagName, element.textContent]),
  slots: [...node.querySelectorAll('[data-slot]')].map(element => element.getAttribute('data-slot')).sort(),
  roles: [...node.querySelectorAll('[role]')].map(element => [element.getAttribute('role'), element.getAttribute('aria-label')]),
  controls: [...node.querySelectorAll('button,input,select,textarea')].map(element => [element.tagName, element.getAttribute('aria-label'), element.getAttribute('type')]),
})
const settleDestination = async (page: Page, destination: string) => {
  await bounded(`settle ${destination} destination`, () => page.evaluate(async value => {
    const store = (window as any).__hdStore
    if (value === 'agents') await store.loadAgents()
    if (value === 'dashboard') await store.loadUsage()
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  }, destination))
  if (destination === 'flows') await expect(page.getByText('Reading Flows…', { exact: true })).toHaveCount(0)
}

for (const theme of ['light', 'dark'] as const) test(`the flag-off host has no Lead surface and preserves existing destinations in ${theme}`, async ({ browser }) => {
  test.setTimeout(120_000)
  const baseline = await openLeadHost(browser, renderer)
  const expected = new Map<string, string>()
  try {
    await baseline.page.evaluate(value => (window as any).__hdStore.setTheme(value), theme)
    for (const [label, destination] of destinations) {
      await baseline.page.locator('[aria-label="Main sections"]').getByRole('button', { name: label, exact: true }).click()
      const body = baseline.page.locator(`[data-page-destination="${destination}"]:visible`)
      await expect(body.getByRole('heading', { name: label, exact: true }).first()).toBeVisible()
      await settleDestination(baseline.page, destination)
      expected.set(destination, JSON.stringify(await body.evaluate(structure)))
    }
  } finally { await baseline.close() }
  // Rig homes and extension ownership are process-scoped, so compare two
  // separate sittings rather than keeping two hosts alive in one process.
  const desk = await openLeadHost(browser, renderer, { enabled: false })
  const { page, rig } = desk
  try {
    await page.evaluate(value => (window as any).__hdStore.setTheme(value), theme)
    const sections = page.locator('[aria-label="Main sections"]')
    await expect(sections.getByRole('button', { name: 'Dex', exact: true })).toHaveCount(0)
    const labels = await sections.getByRole('button').allTextContents()
    expect(labels.map(label => label.trim())).toEqual(['Teams', 'Flows', 'Agents', 'Library', 'Plugins', 'Dashboard'])
    for (const [label, destination] of destinations) {
      await sections.getByRole('button', { name: label, exact: true }).click()
      const body = page.locator(`[data-page-destination="${destination}"]:visible`)
      await expect(body).toBeVisible()
      await expect(body.getByRole('heading', { name: label, exact: true }).first()).toBeVisible()
      await settleDestination(page, destination)
      // Read real DOM contracts from the same screen with the feature enabled;
      // variable ids and isolated project paths never enter the comparison.
      await expect.poll(async () => JSON.stringify(await body.evaluate(structure))).toBe(expected.get(destination))
    }
    // Finish the same destination path as the enabled baseline before any side trips.
    for (const [label, destination] of destinations) {
      await sections.getByRole('button', { name: label, exact: true }).click()
      const body = page.locator(`[data-page-destination="${destination}"]:visible`)
      await expect(body).toBeVisible()
      // Assert absence independently of the enabled comparison: a control
      // leaking into both sittings must still fail this contract.
      await expect(sections.getByRole('button', { name: /^(Lead|Dex|Lex)$/ })).toHaveCount(0)
      await expect(sections.locator('[title="Lead"]')).toHaveCount(0)
      await expect(page.locator('[data-page-destination="lead"]')).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Dex thread', exact: true })).toHaveCount(0)
      await expect(page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Lead settings', exact: true })).toHaveCount(0)
      // Neither programmatic route may replace Agents, Flows or Dashboard.
      await page.evaluate(() => (window as any).__hdStore.openDestination({ kind: 'lead' }))
      await expect(body).toBeVisible()
      await page.evaluate(() => (window as any).__hdStore.openDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } }))
      await expect(body).toBeVisible()
      await expect(page.locator('[data-page-destination="lead"]')).toHaveCount(0)
      // Inspect a real Settings navigation, rather than asserting against
      // a section that has never been mounted.
      await page.evaluate(() => (window as any).__hdStore.openDestination({ kind: 'settings', route: { kind: 'section', section: 'general', focus: null } }))
      const settings = page.getByRole('navigation', { name: 'Settings navigation', exact: true })
      await expect(settings).toBeVisible()
      await expect(settings.getByRole('button', { name: 'Lead', exact: true })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Lead', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Lead settings', exact: true })).toHaveCount(0)
      await expect(page.getByRole('spinbutton', { name: /^(Dollar|Round) allowance$/ })).toHaveCount(0)
      await page.evaluate(value => (window as any).__hdStore.openDestination({ kind: value }), destination)
      await expect(body).toBeVisible()
    }
    // Restored or programmatic navigation cannot mount a hidden destination.
    await page.evaluate(() => (window as any).__hdStore.openDestination({ kind: 'lead' }))
    await page.evaluate(() => (window as any).__hdStore.openDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } }))
    await expect(page.getByRole('button', { name: 'Lead', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-page-destination="lead"]')).toHaveCount(0)
    // Search the real palette as well as the nav and restored route.
    await page.getByRole('button', { name: 'Search everything', exact: true }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
    const search = palette.getByRole('searchbox')
    await search.fill('lead')
    await expect(search).toHaveValue('lead')
    await expect(palette.getByRole('option').filter({ hasText: 'Settings › Lead' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    const refusal = await bounded('disabled Lead wire refusal', () => page.evaluate(async () => {
      try { await (window as any).__hdStore.transport.request('lead/thread/read', {}); return null }
      catch (error) { return (error as { wireCode?: string; code?: string }).wireCode ?? (error as { code?: string }).code }
    }))
    expect(refusal).toBeTruthy()
    expect(rig.provider.requests).toHaveLength(0)
    expect(rig.children).toHaveLength(0)
    expect((await readdir(rig.home)).filter(name => /lead/i.test(name))).toEqual([])
  } finally { await desk.close() }
})
