import path from 'node:path'
import { expect, test } from '@playwright/test'
import { goalRig } from '../../packages/server/dist/test/fixtures/flow-goal-rig.js'
import { sourceDigest } from '../../packages/server/dist/src/flow-execution.js'
import { decideLoop } from '../../packages/server/dist/src/findings/rounds.js'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const FINAL = 'version: 2\nname: Finish the change\nroles:\n  person: { kind: person, outcomes: [done, no-pr] }\nseed: { role: person, title: Finish it }\nrules: []\n'
const SCENES = ['complete', 'unrouted', 'person-stop', 'desk-stop', 'stalled', 'rounds', 'without-progress'] as const

for (const theme of ['light', 'dark'] as const) {
  test(`real Flow endings retain their banners and doors in ${theme}`, async ({ page }) => {
    const cleanup: (() => Promise<void>)[] = []
    const rig = await goalRig({ after: fn => { cleanup.push(fn) } })
    try {
      for (const scene of SCENES) {
        let source = FINAL
        if (scene === 'unrouted') source = FINAL.replace('rules: []', 'rules:\n  - { id: again, on: person, when: { every: [done] }, then: { role: person, title: Again } }')
        if (scene === 'rounds' || scene === 'without-progress') source = FINAL.replace('roles:', `budget: { rounds: ${scene === 'rounds' ? 1 : 10}, without-progress: 2 }\nroles:`).replace('rules: []', 'rules:\n  - { id: again, on: person, then: { role: person, title: Again } }')
        if (scene === 'stalled') {
          rig.checkEvidenceFails = true
          source = 'version: 2\nname: Verify the change\nroles:\n  check: { kind: check, run: echo checked, exits: { "0": pass }, otherwise: fail }\nseed: { role: check, title: Verify it }\nrules: []\n'
        }
        const dispose = scene === 'without-progress' ? rig.executions.onRoundClosed((id, n) => rig.executions.recordRoundClose(id, n, state => {
          const decision = decideLoop({ closed: n, limit: 10, idle: state.idleRounds, idleLimit: 2, newProgress: n === 1,
            unresolvedRepairs: [], unresolved: 1, reviewComplete: false, freshGuards: false, pendingException: false })
          return { ...state, closedRounds: [...state.closedRounds, n], idleRounds: decision.idle,
            stopped: decision.next === 'person' ? { round: n, reason: decision.reason!, ceiling: decision.ceiling, budget: decision.budget! } : null }
        })) : () => {}
        const run = await rig.flows.startGoal({ root: '/repo', sentence: 'Finish the change', source, sourcePath: null, compiled: rig.compile(source, []),
          authorization: { sourceDigest: sourceDigest(source), commandDigest: sourceDigest(''), approvedAt: 1 } })
        if (scene === 'person-stop' || scene === 'desk-stop') await rig.flows.stopRun(run.id, 'The Run was stopped. Its cards are kept.', scene === 'person-stop' ? 'person' : 'desk')
        else if (scene !== 'stalled') {
          for (let n = 0; n < (scene === 'without-progress' ? 3 : 1); n += 1) {
            const card = rig.flows.executionOf(run.id)!.rounds.at(-1)!.cards[0]!
            await rig.team.intentAction(run.goal, card, 'done', undefined, scene === 'unrouted' ? 'no-pr' : 'done')
            await rig.flows.flush()
          }
        }
        await rig.flows.flush()
        dispose()
        const execution = rig.flows.executionOf(run.id)!
        expect(execution.end?.kind).toBe(scene === 'person-stop' || scene === 'desk-stop' ? 'stopped' : scene === 'rounds' || scene === 'without-progress' ? 'budget' : scene)
        await page.route('**/run-ending-rig.json', route => route.fulfill({ json: { execution, cards: rig.board(run.goal).intents, origin: 'Started by you' } }))
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`/preview.html?run-ending-rig&theme=${theme}`)
        if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
        else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
        const frame = page.locator('#run-ending-rig')
        const banner = frame.locator('[data-slot="run-ending"]')
        const titles = { complete: 'Settled', unrouted: 'Ended without a next step', 'person-stop': 'Stopped by you', 'desk-stop': 'Stopped by the desk', stalled: 'Needs you', rounds: 'Round budget reached', 'without-progress': 'Rounds without progress reached' }
        await expect(banner).toContainText(titles[scene])
        await expect(banner.locator('[data-tone]')).toHaveAttribute('data-tone', ['complete', 'person-stop', 'desk-stop'].includes(scene) ? 'neutral' : 'warning')
        const door = scene === 'complete' ? 'Wrap' : scene === 'stalled' ? 'Review and run again…' : 'Run again…'
        await expect(banner.getByRole('button', { name: door, exact: true })).toBeVisible()
        if (scene === 'complete') await expect(banner).toContainText('Nothing waits.')
        if (scene === 'unrouted') await expect(banner.getByRole('button', { name: 'Board', exact: true })).toBeVisible()
        if (scene === 'rounds' || scene === 'without-progress') await expect(banner).toContainText(scene === 'rounds' ? '1 round used' : '2 rounds without progress')
        await page.setViewportSize({ width: 390, height: 900 })
        await frame.locator('[data-row="end"]').scrollIntoViewIfNeeded()
        await expect(banner.getByRole('button', { name: door, exact: true })).toBeInViewport()
        expect(await frame.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        if (process.env.RUN_ENDING_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `${scene}-${theme}.png`) })
        await page.unroute('**/run-ending-rig.json')
        rig.checkEvidenceFails = false
      }
    } finally { for (const fn of cleanup.reverse()) await fn() }
  })

  test(`Run again previews recorded inputs, seat changes and both Runs in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const team = page.locator('#run-view-team')
    await team.getByRole('button', { name: 'Run 1', exact: true }).click()
    await team.locator('[data-slot="run-ending"]').scrollIntoViewIfNeeded()
    await team.getByRole('button', { name: 'Run again…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Run again', exact: true })
    await expect(dialog.getByLabel('Brief', { exact: true })).toHaveValue(/Retry the checkout call/)
    await expect(dialog.getByLabel('Task', { exact: true })).toHaveValue('Retry the checkout call')
    await dialog.getByLabel('writer · Seat preference').selectOption({ label: 'Alpha · High' })
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_ENDING_FRAMES_DIR) await dialog.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `run-again-${theme}.png`) })
    await dialog.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await team.locator('aside').getByRole('button', { name: 'Run 2', exact: true }).click()
    const chooser = team.locator('[aria-label="Choose a Run"]')
    await expect(chooser.getByRole('button', { name: 'Run 1', exact: true })).toBeVisible()
    await expect(chooser.getByRole('button', { name: 'Run 2', exact: true })).toBeVisible()
    await expect(team.locator('[data-slot="run-header"]')).toContainText('Continues Run 1')
    await team.locator('[data-slot="run-revision"]').click()
    await expect(team.locator('[aria-label="Run timeline"]')).toHaveCount(0)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_ENDING_FRAMES_DIR) await team.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `lineage-${theme}.png`) })
  })

  test(`Run again loading, refusal and narrow form in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 390, height: 900 })
    for (const scene of ['pending', 'failed', 'superseded', 'empty', 'default']) {
      await page.goto(`/preview.html?run-again=${scene}&theme=${theme}`)
      const dialog = page.getByRole('dialog', { name: 'Run again', exact: true })
      await expect(dialog).toBeVisible()
      if (scene === 'default' || scene === 'empty') {
        await expect(dialog.getByLabel('Brief', { exact: true })).toHaveValue(scene === 'empty' ? '' : /Retry the checkout call/)
        await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
      } else {
        await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
        if (scene === 'failed') await expect(dialog).toContainText('The earlier Run’s source could not be read.')
        if (scene === 'superseded') {
          await expect(dialog).toContainText('A newer Run continues this one. Start work on that Run instead.')
          await expect(dialog.getByLabel('writer · Seat preference')).toHaveCount(0)
        }
      }
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeInViewport()
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      if (process.env.RUN_ENDING_FRAMES_DIR) await dialog.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `run-again-${scene}-${theme}.png`) })
    }
  })

  test(`Run again preserves two Seat preferences in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-again=multiple-seats&theme=${theme}`)
    const dialog = page.getByRole('dialog', { name: 'Run again', exact: true })
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    if (process.env.RUN_ENDING_FRAMES_DIR) await dialog.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `run-again-two-seats-${theme}.png`) })
    await expect(dialog.getByRole('combobox')).toHaveCount(2)
    await dialog.getByLabel('writer · Seat 1 · Seat preference').selectOption({ label: 'Alpha · High' })
    await expect(dialog.getByLabel('writer · Seat 2 · Seat preference')).toHaveValue(JSON.stringify({ runtime: 'codex', effort: 'high' }))
    await expect(dialog).toContainText('It opens 2 seats')
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_ENDING_FRAMES_DIR) await dialog.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `run-again-two-seats-edited-${theme}.png`) })
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeInViewport()
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    if (process.env.RUN_ENDING_FRAMES_DIR) await dialog.screenshot({ path: path.join(process.env.RUN_ENDING_FRAMES_DIR, `run-again-two-seats-narrow-${theme}.png`) })
  })
}
