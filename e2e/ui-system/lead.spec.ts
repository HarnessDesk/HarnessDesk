import { expect, test } from '@playwright/test'
import { buildLeadRenderer, openLead, openLeadHost, sendLeadGoal } from './lead-host'

let renderer: string
test.beforeAll(async ({}, info) => { test.setTimeout(120_000); renderer = info.outputPath('renderer'); await buildLeadRenderer(renderer) })

for (const theme of ['light', 'dark'] as const) {
  test(`Lead plan approval reaches a two-run reviewed result and human acceptance in ${theme}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const desk = await openLeadHost(browser, renderer, { holdWorkers: true })
    const { page, rig } = desk
    try {
      await openLead(page, theme)
      await sendLeadGoal(page)
      const plan = page.locator('[data-lead-card-type="plan"]')
      await expect(plan.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 30_000 })
      expect((await rig.host.call('goal/list', {})).length).toBe(0)
      await plan.getByRole('button', { name: 'Approve', exact: true }).click()
      await rig.waitFor(() => rig.journal.state.phase === 'running', 'approved work starts')
      await rig.releaseWorkers()
      const result = page.locator('[data-lead-card-type="result"]')
      await expect(result.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 90_000 })
      expect(rig.journal.state.runs.length).toBe(2)
      await result.getByRole('button', { name: 'Accept', exact: true }).click()
      await rig.waitFor(() => rig.journal.state.phase === 'accepted', 'human result acceptance')
      await expect(result).toHaveCount(0)
    } finally { await desk.close() }
  })

  test(`Lead refuses a delayed stale plan click through the real window method in ${theme}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const desk = await openLeadHost(browser, renderer, { holdWorkers: true })
    const other = await browser.newPage()
    const { page, rig } = desk
    try {
      await openLead(page, theme); await sendLeadGoal(page)
      const approve = page.locator('[data-lead-card-type="plan"]').getByRole('button', { name: 'Approve', exact: true })
      await expect(approve).toBeVisible({ timeout: 30_000 })
      // Hold only this outgoing click. The original shipping transport still
      // delivers it, after the second real window commits the same decision.
      await page.evaluate(() => {
        const store = (window as any).__hdStore, original = store.transport.request.bind(store.transport)
        let release!: () => void
        const held = new Promise<void>(done => { release = done })
        ;(window as any).__leadReleaseDecision = release
        store.transport.request = async (method: string, params: unknown) => {
          if (method === 'lead/card/decide') { store.transport.request = original; await held }
          return original(method, params)
        }
      })
      await approve.click()
      await desk.visit(other); await openLead(other, theme)
      await other.locator('[data-lead-card-type="plan"]').getByRole('button', { name: 'Approve', exact: true }).click()
      await rig.waitFor(() => rig.journal.state.runs.length > 0, 'other window approves and starts work')
      await page.evaluate(() => (window as any).__leadReleaseDecision())
      await expect(page.getByRole('alert')).toContainText(/already has a decision|changed.*latest/i)
      expect(rig.journal.state.runs.length).toBeLessThanOrEqual(rig.journal.state.contract!.steps.length)
      expect(new Set(rig.journal.state.runs.map(run => run.correlationId)).size).toBe(rig.journal.state.runs.length)
    } finally { await other.close(); await desk.close() }
  })

  test(`Lead Resume continues an interrupted provider request in ${theme}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const desk = await openLeadHost(browser, renderer, { scenario: 'interrupted' })
    const { page, rig } = desk
    try {
      await openLead(page, theme); await sendLeadGoal(page)
      await rig.waitFor(() => rig.provider.requests.length === 1, 'first provider request')
      await rig.interrupt()
      const resume = page.getByRole('button', { name: 'Resume', exact: true })
      await expect(resume).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('form', { name: 'Lead composer' })).toContainText('interrupted')
      await resume.click()
      await expect(page.locator('[data-lead-card-type="plan"]').getByRole('button', { name: 'Approve', exact: true })).toBeVisible({ timeout: 30_000 })
      expect(rig.provider.requests.length).toBeGreaterThan(1)
      expect(rig.journal.state.runs).toHaveLength(0)
    } finally { await desk.close() }
  })

  test(`Lead settings apply tightening immediately and require a card for widening in ${theme}`, async ({ browser }) => {
    test.setTimeout(120_000)
    const desk = await openLeadHost(browser, renderer)
    const { page, rig } = desk
    try {
      await openLead(page, theme)
      const lead = page.locator('[data-page-destination="lead"]')
      await lead.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Lead settings', exact: true })
      await settings.getByLabel('Permission mode', { exact: true }).selectOption('plan')
      await settings.getByRole('button', { name: 'Save permissions', exact: true }).click()
      await expect.poll(() => rig.journal.state.policy?.mode).toBe('plan')
      await settings.getByLabel('Permission mode', { exact: true }).selectOption('manage')
      await expect(settings).toContainText('Creates a card for your approval.')
      await settings.getByRole('button', { name: 'Save permissions', exact: true }).click()
      await expect.poll(() => rig.journal.state.cards.some(card => card.type === 'permission-change')).toBe(true)
      expect(rig.journal.state.policy?.mode).toBe('plan')
      await settings.getByRole('button', { name: 'Done', exact: true }).click()
      const permission = page.locator('[data-lead-card-type="permission-change"]')
      await expect(permission).toContainText('Manage')
      await permission.getByRole('button', { name: 'Approve', exact: true }).click()
      await expect.poll(() => rig.journal.state.policy?.mode).toBe('manage')
      await lead.getByRole('button', { name: 'Settings', exact: true }).click()
      await settings.getByLabel('Dollar allowance', { exact: true }).fill('1')
      await settings.getByRole('button', { name: 'Save allowances', exact: true }).click()
      await expect.poll(() => rig.journal.state.budget?.caps.usdMicros).toBe(1_000_000)
      await settings.getByLabel('Dollar allowance', { exact: true }).fill('2')
      await settings.getByRole('button', { name: 'Save allowances', exact: true }).click()
      await expect.poll(() => rig.journal.state.cards.some(card => card.type === 'budget-change')).toBe(true)
      await settings.getByRole('button', { name: 'Done', exact: true }).click()
      expect(rig.journal.state.budget?.caps.usdMicros).toBe(1_000_000)
      await page.locator('[data-lead-card-type="budget-change"]').getByRole('button', { name: 'Approve', exact: true }).click()
      await expect.poll(() => rig.journal.state.budget?.caps.usdMicros).toBe(2_000_000)
      expect(rig.provider.requests).toHaveLength(0)
    } finally { await desk.close() }
  })
}
