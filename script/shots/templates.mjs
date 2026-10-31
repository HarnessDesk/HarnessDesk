#!/usr/bin/env node
/** New Team → completed shipped templates, driven only through the renderer. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { serve } from '../../packages/server/dist/src/index.js'
import { FRAME } from '../../packages/ui/src/design/frame.ts'
import { COLLECT, TILDIFY, USER, textReasons } from './audit.mjs'
import { createTemplateRig, templateJourneyCases, TEMPLATE_CHECK, TEMPLATE_PUBLISH_BRANCH, TEMPLATE_TASK } from './template-rig.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const journeys = templateJourneyCases(process.argv)
const out = resolve(flag('out', join(tmpdir(), 'hd-template-frames')))
const ui = resolve(flag('ui', join(root, 'packages/ui/dist')))
mkdirSync(out, { recursive: true })
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hd-template-journeys-')))
let browser
const frames = [], evidence = []
try {
  browser = await chromium.launch({ headless: true })
  for (const [template, checkMode] of journeys) {
    const contest = template === 'mechanical-contest'
    const scene = contest ? `${template}-${checkMode}` : template
    const directory = join(scratch, scene)
    const rig = await createTemplateRig({ home: join(directory, 'home'), work: join(directory, 'person', 'work'), template })
    let server, page
    try {
      const remembered = JSON.parse(readFileSync(rig.stateFile, 'utf8')).workspaces[0]
      assert.deepEqual(Object.keys(remembered).sort(), ['id', 'lastOpenedAt', 'name', 'path'], 'the project starts with the old build’s record')
      server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot: ui })
      page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
      const rendererErrors = []
      page.on('pageerror', error => rendererErrors.push(error.message))
      await page.goto(`${server.url}/?token=${server.token}`)
      await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
      await page.waitForFunction(repo => window.__hdStore.getSnapshot().workspace?.path === repo, rig.repo)
      // Rig-only presentation preferences; no start, card or merge bypasses UI.
      await page.evaluate(() => window.__hdStore.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }))
      const photographedRevisions = new Set()
      const photograph = async (name) => {
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => window.__hdStore.setTheme(value), theme)
          if (name.endsWith('-flow')) await expect(page.getByText('The path this Run took', { exact: true })).toBeVisible()
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
          await page.evaluate(TILDIFY(join(directory, 'person')))
          await page.evaluate(TILDIFY(scratch, '~/.template-scenes'))
          // Only labels of revisions read from this rig's actual evidence.
          // Keep option values intact for the person’s exact-revision merge.
          await page.evaluate(revisions => {
            for (const option of document.querySelectorAll('option')) {
              const label = option.textContent.trim()
              if (revisions.includes(label)) option.textContent = `${label.slice(0, 7)}…`
            }
          }, [...photographedRevisions])
          assert.doesNotMatch(await page.locator('body').innerText(), /(?:harnessdesk\/)?lane-[0-9a-f-]{20,}/, 'managed lane identifiers stay out of visible text')
          assert.deepEqual(textReasons(await page.evaluate(COLLECT), { user: USER }), [], `privacy audit: ${name}`)
          const filename = `${scene}-${name}-${theme}.png`
          await page.screenshot({ path: join(out, filename), animations: 'disabled' })
          frames.push(filename)
          process.stdout.write(`Captured ${filename}\n`)
        }
      }
      // The New Team menu uses the current project, restored from its visible
      // recent-project list. Reopening it here would mask the old-record bug.
      await expect(page.locator('[data-left-column]').getByRole('button', { name: 'storefront', exact: true })).toHaveAttribute('title', /^The folder this app is working in/)
      await expect(page.getByRole('button', { name: 'More ways to start', exact: true })).toBeVisible()
      if (template === 'fix-and-review') {
        const branch = page.locator('[aria-label="Conversation facts"] [data-slot="summary-item"]')
          .filter({ has: page.locator('dt', { hasText: /^Branch$/ }) }).locator('[data-slot="middle-truncate"]')
        const details = page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Toggle rail', exact: true })
        const openedDetails = !(await branch.isVisible())
        if (openedDetails) await details.click()
        await expect(branch).toBeVisible()
        await expect(branch.locator(':scope > .sr-only')).toHaveText(TEMPLATE_PUBLISH_BRANCH)
        const parts = branch.locator('[data-part]')
        await expect(parts).toHaveCount(2)
        await expect(parts.nth(0)).toBeVisible()
        await expect(parts.nth(1)).toBeVisible()
        expect((await parts.allTextContents()).join('')).toBe(TEMPLATE_PUBLISH_BRANCH)
        if (openedDetails) await details.click()
      }
      await photograph('00-project')
      await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
      await page.getByRole('menuitem', { name: /^New Team/ }).click()
      const newTeam = page.getByRole('dialog', { name: 'New Team', exact: true })
      await expect(newTeam).toBeVisible()
      await photograph('01-new-team')
      const name = contest ? 'Mechanical contest' : template === 'comparison' ? 'Side by side' : 'Write and review'
      // Search reveals the complete catalogue, including templates outside
      // the three quick choices offered when the dialog first opens.
      await newTeam.getByRole('searchbox', { name: 'Search Flows', exact: true }).fill(name)
      await newTeam.getByRole('button', { name, exact: true }).click()
      // The first dry run can still be installing the project's suggested
      // check when the task field appears. Open the visible role control;
      // its runtime and model pickers live inside that configuration.
      const primaryRole = template === 'comparison' || contest ? 'Attempt A' : 'Writes'
      const configurePrimary = newTeam.getByRole('button', { name: `Configure ${primaryRole}`, exact: true })
      await expect(configurePrimary).toBeEnabled({ timeout: 30000 })
      await configurePrimary.click()
      const primaryConfiguration = page.getByRole('group', { name: `${primaryRole} configuration`, exact: true })
      await expect(primaryConfiguration.getByRole('button', { name: `Runtime for ${primaryRole}`, exact: true })).toBeVisible()
      await expect(primaryConfiguration.getByRole('button', { name: `Model for ${primaryRole}`, exact: true })).toBeVisible()
      await configurePrimary.click()
      const task = template === 'comparison' || contest ? TEMPLATE_TASK : `${TEMPLATE_TASK} for review`
      await newTeam.getByRole('textbox', { name: template === 'comparison' ? 'What should both try?' : 'What should they do?', exact: true }).fill(task)
      if (template === 'comparison' || contest) {
        await newTeam.getByRole('button', { name: 'Details', exact: true }).click()
        const command = newTeam.getByRole('textbox', { name: 'Check each attempt with', exact: true })
        await expect(command).toHaveValue('pnpm test')
        const chosenCheck = contest ? (checkMode === 'skipped' ? '' : 'pnpm test') : TEMPLATE_CHECK
        await command.fill(chosenCheck)
        await expect(command).toHaveValue(chosenCheck)
      }
      await expect(newTeam.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled({ timeout: 30000 }).catch(async error => { throw new Error(`${error.message}\n${template}: ${await newTeam.innerText()}`) })
      await newTeam.getByRole('textbox', { name: template === 'comparison' ? 'What should both try?' : 'What should they do?', exact: true }).scrollIntoViewIfNeeded()
      await photograph('02-task')
      const details = newTeam.getByRole('button', { name: 'Details', exact: true })
      if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
      if (!contest) {
        // The rig names the `codex-review` runtime "Scripted reviewer".
        const reviewRole = template === 'comparison' ? 'Judge' : 'Reviews'
        const configureReviewer = newTeam.getByRole('button', { name: `Configure ${reviewRole}`, exact: true })
        await configureReviewer.click()
        const reviewConfiguration = page.getByRole('group', { name: `${reviewRole} configuration`, exact: true })
        const reviewer = reviewConfiguration.getByRole('button', { name: `Runtime for ${reviewRole}`, exact: true })
        await reviewer.click()
        await page.getByRole('menuitemradio', { name: 'Scripted reviewer', exact: true }).click()
        // Enabling the optional Judge moves its control from Details into
        // the graph, so inspect the newly rendered role configuration.
        await expect(configureReviewer).toContainText('Scripted reviewer')
        if (await configureReviewer.getAttribute('aria-expanded') !== 'true') await configureReviewer.click()
        await expect(reviewer).toHaveText('Scripted reviewer')
        await expect(reviewConfiguration.getByRole('button', { name: `Model for ${reviewRole}`, exact: true })).toBeVisible()
        await configureReviewer.click()
      }
      const completion = newTeam.getByRole('region', { name: 'Completion and dry run', exact: true })
      await completion.getByRole('button', { name: 'Completion and dry run', exact: true }).click()
      await newTeam.getByRole('button', { name: 'Dry run', exact: true }).click()
      const dryRun = newTeam.getByRole('region', { name: 'Dry run', exact: true })
      await expect(dryRun).toBeVisible()
      await expect(newTeam.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled({ timeout: 30000 })
      if (template === 'comparison') await expect(dryRun.getByRole('region', { name: 'Commands it runs' }).getByText(new RegExp(TEMPLATE_CHECK.replaceAll('.', '\\.')))).toBeVisible()
      if (contest) {
        const commands = dryRun.getByRole('region', { name: 'Commands it runs' })
        if (checkMode === 'declared') await expect(commands.getByText(/pnpm test/)).toBeVisible()
        else await expect(commands).toHaveCount(0)
      }
      await dryRun.getByRole('region', { name: 'Seats this would open' }).scrollIntoViewIfNeeded()
      await photograph('03-preview')
      assert.equal(JSON.parse(readFileSync(rig.stateFile, 'utf8')).workspaces[0].shellIdentity, undefined, 'preview does not pre-admit the legacy record')
      await newTeam.getByRole('button', { name: 'Start Team', exact: true }).click()
      await expect(newTeam).toHaveCount(0, { timeout: 30000 })
      await page.waitForFunction(name => [...window.__hdStore.getSnapshot().flowExecutions.values()].some(one => one.document.flow.name === name && window.__hdStore.getSnapshot().goals.has(one.goal)), name)
      const run = await page.evaluate(name => {
        const snapshot = window.__hdStore.getSnapshot()
        const execution = [...snapshot.flowExecutions.values()].find(one => one.document.flow.name === name && snapshot.goals.has(one.goal))
        return { id: execution.id, goal: execution.goal }
      }, name)
      // The browser regression advances only this observer's clock. Host and
      // renderer keep running normally; the first referee read is held for one
      // poll, making the two phases exceed one window but fit separately.
      const phaseClock = process.argv.includes('--observation-clock-test') && template === 'comparison'
        ? { offset: 0, active: false, judge: false, transition: false } : null
      const now = () => Date.now() + (phaseClock?.offset ?? 0)
      const observe = async (matches, label) => {
        let view, execution
        const until = now() + 30000
        do {
          view = await rig.host.call('goal/read', { goal: run.goal })
          execution = await rig.host.call('flow/execution', { run: run.id })
          if (phaseClock?.active && !phaseClock.judge && view.board.intents.some(one => one.role === 'judge' && one.state === 'done' && one.outcome === 'picked')) {
            phaseClock.judge = true
            phaseClock.offset += 25000
          }
          if (phaseClock?.judge && !phaseClock.transition) {
            view = { ...view, board: { ...view.board, intents: view.board.intents.filter(one => one.role !== 'referee') } }
          }
          assert.deepEqual(rig.errors, [], 'no scripted agent tool failure')
          assert.notEqual(execution.state, 'stalled', execution.reason ?? 'the template stalled')
          if (matches(view.board.intents, execution)) break
          await new Promise(done => setTimeout(done, 50))
          if (phaseClock?.judge && !phaseClock.transition) {
            phaseClock.transition = true
            phaseClock.offset += 8000
          }
        } while (now() < until)
        if (!matches(view.board.intents, execution)) {
          const facts = await rig.host.call('evidence/board', { room: run.goal })
          writeFileSync(join(out, `${template}-local-flow-diagnostic.json`), `${JSON.stringify({ label, execution, cards: view.board.intents, facts }, null, 2)}\n`)
        }
        assert.ok(matches(view.board.intents, execution), `${label}: ${JSON.stringify({ execution, cards: view.board.intents })}`)
        await page.waitForFunction(({ goal, cards }) => cards.every(([id, state, outcome]) => window.__hdStore.getSnapshot().teams.get(goal)?.intents.some(one => one.id === id && one.state === state && (one.outcome ?? null) === outcome)),
          { goal: run.goal, cards: view.board.intents.map(one => [one.id, one.state, one.outcome ?? null]) })
        return { view, execution }
      }
      const tab = async name => {
        const value = ({ Overview: 'overview', Run: 'overview', Board: 'board', Chat: 'room' })[name]
        assert.ok(value, `unknown Team destination ${name}`)
        const direct = page.locator(`[data-slot="workbench-main"] [data-team-page="${value}"]:visible`)
        await direct.click()
        await expect(direct).toHaveAttribute('aria-selected', 'true')
      }
      const runView = async name => {
        const work = page.locator('[data-slot="run-workspace"][data-view="work"]')
        await expect(work).toBeVisible()
        if (name === 'Timeline') {
          const fullRecord = work.getByRole('button', { name: 'Full record', exact: true })
          if (await fullRecord.isVisible()) await fullRecord.click()
          await expect(work.getByRole('list', { name: 'Run timeline', exact: true })).toBeVisible()
        } else await expect(work.locator('[data-slot="run-flow"]')).toBeVisible()
      }
      const chatView = async name => {
        await tab('Chat')
        await page.locator('[data-slot="workbench-main"]:visible').getByRole('button', { name: /^(Chat|Split)$/ }).click()
        await page.getByRole('menuitemradio', { name: name === 'Side by side' ? 'Split' : 'Chat', exact: true }).click()
      }
      const completedSeats = async expected => {
        const toggle = page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Toggle rail', exact: true })
        const opened = await toggle.getAttribute('aria-pressed') !== 'true'
        if (opened) await toggle.click()
        const seats = page.locator('[data-frame-region="rail"] section[aria-label="Seats"]')
        const fold = seats.getByRole('button', { name: 'Seats', exact: true })
        if (await fold.getAttribute('aria-expanded') !== 'true') await fold.click()
        const done = seats.locator('[data-slot="chip"]').filter({ hasText: /^Done$/ })
        await expect(done.first()).toBeVisible({ timeout: 30000 })
        if (expected !== undefined) await expect(done).toHaveCount(expected)
        // The canonical Seats rail owns this fold now; Work does not repeat
        // a second Seat table or a separate completed-seat disclosure.
        await fold.click()
        await expect(fold).toHaveAttribute('aria-expanded', 'false')
        await expect(done.first()).toBeHidden()
        await fold.click()
        await expect(fold).toHaveAttribute('aria-expanded', 'true')
        await expect(done.first()).toBeVisible()
        const runFacts = page.locator('[data-frame-region="rail"] [aria-label="Team Run facts"]')
        await expect(runFacts.locator('[data-slot="summary-item"]').filter({ has: page.locator('dt', { hasText: /^State$/ }) })).toContainText('Settled')
        if (opened) await toggle.click()
      }
      const boardTitle = title => page.getByRole('heading', { level: 4, name: new RegExp(`^#\\d+ ${title}$`) })
      const boardColumn = name => page.locator('[data-slot="board-column"]').filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })
      const repository = async () => {
        await page.getByRole('button', { name: 'Search everything', exact: true }).click()
        await page.getByRole('dialog', { name: 'Command palette', exact: true }).getByRole('searchbox').fill('Show Repository')
        await page.getByRole('option', { name: /^Show Repository/ }).click()
      }
      const closeWorkRail = async () => {
        const shell = page.locator('[data-slot="fixed-shell"]:visible')
        await expect(shell).toHaveCount(1)
        if (await shell.getAttribute('data-rail-open') === 'true') {
          const bar = shell.locator('[data-slot="top-bar"]:visible')
          const direct = bar.getByRole('button', { name: 'Toggle rail', exact: true })
          if (await direct.isVisible()) await direct.click()
          else {
            await bar.getByRole('button', { name: 'More', exact: true }).click()
            await page.getByRole('menuitemradio', { name: 'Toggle rail', exact: true }).click()
          }
        }
        await expect(shell).toHaveAttribute('data-rail-open', 'false')
        await expect(shell.locator('[data-frame-region="rail"]')).toBeHidden()
      }
      const mergeFromRepository = async revision => {
        await repository()
        const repositoryPanel = page.locator('[data-frame-region="right"]')
        const changes = page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Changes', exact: true })
        // The palette action changes the active pane asynchronously. Read the
        // new frame's rail only after Repository has actually taken its place.
        await expect(changes).toHaveAttribute('aria-pressed', 'true')
        await expect(repositoryPanel).toBeVisible()
        await closeWorkRail()
        await expect(repositoryPanel.getByRole('grid', { name: 'Commits', exact: true })).toBeVisible()
        await expect(repositoryPanel).toContainText('commits')
        await expect.poll(() => repositoryPanel.evaluate(node => node.getBoundingClientRect().width)).toBe(FRAME.rightPanel.width)
        await expect(repositoryPanel.getByRole('button', { name: 'Give this panel the whole area', exact: true })).toHaveCount(0)
        // Fixed tools retire whole-area zoom. Resize through the real seam
        // to FRAME's maximum width; Git's refs stay in the compact picker.
        const repositorySeam = page.getByRole('separator', { name: 'Resize the right panel', exact: true })
        const seamBox = await repositorySeam.boundingBox()
        assert.ok(seamBox, 'the Repository panel has a visible resize seam')
        const panelWidth = await repositoryPanel.evaluate(node => node.getBoundingClientRect().width)
        const seamX = seamBox.x + seamBox.width / 2
        const seamY = seamBox.y + seamBox.height / 2
        await page.mouse.move(seamX, seamY)
        await page.mouse.down()
        await page.mouse.move(seamX - (FRAME.rightPanel.max - panelWidth), seamY, { steps: 6 })
        await page.mouse.up()
        await expect.poll(() => repositoryPanel.evaluate(node => node.getBoundingClientRect().width)).toBe(FRAME.rightPanel.max)
        const refs = repositoryPanel.getByRole('button', { name: 'Switch the refs rail', exact: true })
        await refs.click()
        const main = page.locator('[data-git-ref="main"]')
        await expect(main).toBeVisible()
        if (await main.getAttribute('data-current') === null) {
          await main.click({ button: 'right' })
          await page.getByRole('menuitem', { name: 'Check out main', exact: true }).click()
          await refs.click()
        }
        await expect(main).toHaveAttribute('data-current', '')
        await page.keyboard.press('Escape')
        if (!contest) await photograph('10-person-repository')
        await page.getByTitle('Merge into the current branch…', { exact: true }).click()
        const merge = page.getByRole('dialog', { name: 'Merge into main', exact: true })
        await merge.getByRole('combobox', { name: 'What to merge', exact: true }).selectOption(revision)
        if (!contest) await photograph('11-person-merge')
        await merge.getByRole('button', { name: 'Merge', exact: true }).click()
        await expect(merge).toHaveCount(0)
      }
      const returnToBoard = async () => {
        const changes = page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Changes', exact: true })
        await page.locator('[data-fixed-tool-frame]').getByRole('button', { name: 'Close pane', exact: true }).click()
        await expect(changes).toHaveAttribute('aria-pressed', 'false')
        await expect(page.locator('[data-fixed-tool-frame]')).toBeHidden()
        await tab('Board')
      }
      if (contest) {
        await observe(cards => cards.filter(one => one.role === 'competitor' && one.state === 'claimed').length === 2, 'contest attempts seated')
        rig.release('attempts')
        if (checkMode === 'declared') {
          await observe((cards, execution) => cards.filter(one => one.role === 'verify' && one.state === 'open').length === 2 && execution.operations.some(one => one.kind === 'check' && one.state === 'started'), 'declared contest checks started')
          rig.release('checks')
        }
        const handoff = await observe(cards => cards.some(one => one.role === 'referee' && one.state === 'open'), 'contest person choice')
        const facts = await rig.host.call('evidence/board', { room: run.goal })
        const records = facts.cards.flatMap(one => one.facts.map(fact => fact.record))
        const checks = records.filter(one => one.fact.kind === 'check')
        const diffs = handoff.view.board.intents.filter(one => one.role === 'competitor').map(card => facts.cards.find(one => one.card === card.id).facts.find(one => one.record.fact.kind === 'diff').record)
        assert.equal(checks.length, checkMode === 'skipped' ? 0 : 2)
        assert.ok(checks.every(one => one.fact.run === 'pnpm test' && one.fact.exit === 0))
        if (checks.length) assert.deepEqual(checks.map(one => one.fact.at).sort(), diffs.map(one => one.fact.to).sort(), 'declared checks ran on the committed attempts')
        assert.deepEqual(handoff.execution.rounds.map(one => one.role), checkMode === 'skipped' ? ['competitor', 'referee'] : ['competitor', 'verify', 'referee'])
        const branch = execFileSync('git', ['branch', '--show-current'], { cwd: diffs[0].checkout.cwd, encoding: 'utf8' }).trim()
        await mergeFromRepository(branch)
        await returnToBoard()
        rig.git('merge-base', '--is-ancestor', diffs[0].fact.to, 'main')
        const referee = handoff.view.board.intents.find(one => one.role === 'referee')
        await page.getByRole('button', { name: `What to do with #${referee.id}`, exact: true }).click()
        await page.getByRole('menuitem', { name: 'Answer merged', exact: true }).click()
        await observe((cards, execution) => execution.state === 'settled' && cards.every(one => one.state === 'done'), 'contest completed')
        await tab('Overview')
        await completedSeats(2)
        await page.waitForFunction(goal => window.__hdStore.getSnapshot().goals.get(goal)?.activity !== 'working', run.goal)
        // A finished Team stays in the sidebar, marked, until it is wrapped (#1675 D5).
        await expect(page.getByRole('button', { name: `Room ${task}`, exact: true })).toBeVisible({ timeout: 30000 })
        evidence.push({ template, checkMode, checks: checks.map(one => ({ command: one.fact.run, exitCode: one.fact.exit, at: one.fact.at })), rounds: handoff.execution.rounds.map(one => one.role), settledSidebar: true })
        assert.deepEqual(rendererErrors, [], 'the contest renderer had no uncaught errors')
        continue
      }
      await observe(cards => cards.filter(one => one.role === (template === 'comparison' ? 'competitor' : 'fixer') && one.state === 'claimed').length === (template === 'comparison' ? 2 : 1), 'writers seated')
      await tab('Overview')
      await expect(page.getByText('Working', { exact: true }).first()).toBeVisible()
      await photograph('04-writing-overview')
      await tab('Run')
      await runView('Timeline')
      await expect(page.getByText(task, { exact: true }).first()).toBeVisible()
      await photograph('05-writing-timeline')
      await runView('Flow')
      await expect(page.getByText('The path this Run took', { exact: true })).toBeVisible()
      await photograph('06-writing-flow')
      await tab('Board')
      await expect(boardTitle(task)).toHaveCount(template === 'comparison' ? 2 : 1)
      await expect(boardColumn('Working').getByRole('heading', { level: 4 })).toHaveCount(template === 'comparison' ? 2 : 1)
      await photograph('07-writing-board')
      if (template === 'comparison') {
        rig.release('attempts')
        const checking = await observe((cards, execution) => cards.filter(one => one.role === 'verify' && one.state === 'open').length === 2 && execution.operations.some(one => one.kind === 'check' && one.state === 'started'), 'the first attempt check is running')
        const facts = await rig.host.call('evidence/board', { room: run.goal })
        const diffs = checking.view.board.intents.filter(one => one.role === 'competitor').map(card => facts.cards.find(one => one.card === card.id).facts.find(one => one.record.fact.kind === 'diff').record)
        for (const diff of diffs) photographedRevisions.add(diff.fact.to)
        assert.equal(new Set(diffs.map(one => one.checkout.cwd)).size, 2, 'each attempt wrote in its own lane')
        const changedPaths = diffs.map(one => execFileSync('git', ['diff', '--name-only', one.fact.from, one.fact.to], { cwd: one.checkout.cwd, encoding: 'utf8' }).trim().split('\n'))
        for (const diff of diffs) {
          assert.notEqual(diff.checkout.cwd, rig.repo)
          assert.deepEqual(changedPaths[diffs.indexOf(diff)], ['rig-attempt.txt'], 'both committed attempts change the same relative path')
          assert.match(readFileSync(join(diff.checkout.cwd, 'rig-attempt.txt'), 'utf8'), /^Attempt [12]:/)
        }
        assert.notEqual(readFileSync(join(diffs[0].checkout.cwd, 'rig-attempt.txt'), 'utf8'), readFileSync(join(diffs[1].checkout.cwd, 'rig-attempt.txt'), 'utf8'), 'the shared path contains distinct attempts')
        await expect(boardTitle('Check the attempt')).toHaveCount(2)
        const checkCards = page.locator('[data-slot="board-card"]').filter({ has: boardTitle('Check the attempt') })
        await expect(boardColumn('Working').getByRole('heading', { level: 4, name: /^#\d+ Check the attempt$/ })).toHaveCount(1)
        await expect(boardColumn('To do').getByRole('heading', { level: 4, name: /^#\d+ Check the attempt$/ })).toHaveCount(1)
        await expect(checkCards.filter({ hasText: 'verify running' })).toHaveCount(1)
        await expect(boardColumn('Working').locator('[data-slot="board-card"]').filter({ hasText: 'verify running' })).toHaveCount(1)
        await expect(boardColumn('To do').locator('[data-slot="board-card"]').filter({ hasText: 'verify running' })).toHaveCount(0)
        await photograph('08-checking-board')
        rig.release('checks')
        await observe(cards => cards.some(one => one.role === 'judge' && one.state === 'claimed'), 'judge seated')
        await expect(boardTitle('Pick the best attempt')).toBeVisible()
        await expect(boardColumn('Working').getByRole('heading', { level: 4 })).toHaveCount(1)
        await expect(boardColumn('Ready').getByRole('heading', { level: 4 })).toHaveCount(4)
        await expect(boardColumn('Needs you').getByRole('heading', { level: 4 })).toHaveCount(0)
        await expect(page.getByText('nothing checked', { exact: true })).toHaveCount(0)
        await expect(checkCards.getByText('pass', { exact: true })).toHaveCount(2)
        const passedChecks = checkCards.getByText(/^verify ✓ @[0-9a-f]+$/)
        await expect(passedChecks).toHaveCount(2)
        for (let index = 0; index < 2; index += 1) await expect(passedChecks.nth(index)).toBeVisible()
        await photograph('09-judging-board')
        if (phaseClock) phaseClock.active = true
        rig.release('judge')
        await observe(cards => cards.some(one => one.role === 'judge' && one.state === 'done' && one.outcome === 'picked'), 'judge picked')
        const picked = await observe(cards => cards.some(one => one.role === 'referee' && one.state === 'open'), 'person merge step')
        if (phaseClock) assert.deepEqual([phaseClock.judge, phaseClock.transition, phaseClock.offset], [true, true, 33000], 'both controlled observation phases ran')
        await expect(boardTitle('Merge the picked change')).toBeVisible()
        await expect(boardColumn('Needs you').getByRole('heading', { level: 4, name: /^#\d+ Merge the picked change$/ })).toBeVisible()
        await photograph('10-referee-board')
        await chatView('Side by side')
        // Comparisons keep the Judge off the attempt grid. Its conversation
        // remains reachable through the Seats actions in Details.
        const details = page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Toggle rail', exact: true })
        const judgeActions = page.getByRole('button', { name: 'Actions for Judge', exact: true })
        const openedDetails = !(await judgeActions.isVisible())
        if (openedDetails) await details.click()
        await judgeActions.click()
        await page.getByRole('menuitem', { name: 'Open conversation', exact: true }).click()
        await expect(page.getByText('Verdict: picked', { exact: true })).toBeVisible()
        if (openedDetails) await details.click()
        await chatView('Side by side')
        await expect(page.locator('[data-slot="side-by-side-tile"][aria-label="Judge"]')).toHaveCount(0)
        await expect(page.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
        await expect(page.locator('[data-slot="side-by-side-tile"]').getByText('Picked', { exact: true })).toHaveCount(1)
        await expect(page.locator('[data-slot="side-by-side-tile"]').getByText('Not kept', { exact: true })).toHaveCount(1)
        await expect(page.getByRole('button', { name: 'Merge A into main', exact: true })).toBeEnabled()
        await expect(page.getByText('The runtime finished this turn without any output.', { exact: true })).toHaveCount(0)
        await photograph('11-picked-attempt')
        await page.getByRole('button', { name: 'Merge A into main', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Merge into main', exact: true })).toBeVisible()
        await photograph('12-merge')
        await expect(page.getByRole('dialog', { name: 'Merge into main', exact: true }).getByRole('combobox', { name: 'What to merge', exact: true })).toHaveValue(diffs[0].fact.to)
        await page.getByRole('dialog', { name: 'Merge into main', exact: true }).getByRole('button', { name: 'Merge', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Merge into main', exact: true })).toHaveCount(0)
        rig.git('merge-base', '--is-ancestor', diffs[0].fact.to, 'main')
        assert.equal(readFileSync(join(rig.repo, 'rig-attempt.txt'), 'utf8'), readFileSync(join(diffs[0].checkout.cwd, 'rig-attempt.txt'), 'utf8'), 'the person merged the judged content')
        const board = await rig.host.call('evidence/board', { room: run.goal })
        const checks = board.cards.flatMap(one => one.facts.filter(fact => fact.record.fact.kind === 'check').map(fact => fact.record))
        assert.equal(checks.length, 2)
        assert.ok(checks.every(one => one.fact.run === TEMPLATE_CHECK && one.fact.exit === 0))
        assert.deepEqual(checks.map(one => one.fact.at).sort(), diffs.map(one => one.fact.to).sort(), 'each check names its actual committed attempt')
        evidence.push({ template, firstRecord: 'path/name/lastOpenedAt/id only', lanes: diffs.length, changedPaths, distinctContents: true, checks: checks.map(one => ({ command: one.fact.run, exitCode: one.fact.exit, at: one.fact.at })), pickedHead: diffs[0].fact.to, mergedHead: rig.git('rev-parse', 'main'), rounds: picked.execution.rounds.map(one => one.role) })
      } else {
        rig.release('writer')
        await observe(cards => cards.some(one => one.role === 'reviewer' && one.state === 'claimed'), 'fresh reviewer seated')
        await expect(boardTitle('Review the committed change')).toBeVisible()
        await expect(boardColumn('Working').getByRole('heading', { level: 4 })).toHaveCount(1)
        await photograph('08-review-board')
        rig.release('reviewer')
        const reviewed = await observe(cards => cards.some(one => one.role === 'referee' && one.state === 'open'), 'person handoff')
        await expect(boardTitle('Approve publishing the reviewed change')).toBeVisible()
        await expect(boardColumn('Needs you').getByRole('heading', { level: 4, name: /^#\d+ Approve publishing the reviewed change$/ })).toBeVisible()
        await photograph('09-referee-board')
        const referee = reviewed.view.board.intents.find(one => one.role === 'referee')
        assert.equal(JSON.parse(readFileSync(join(directory, 'home', 'template-forge.json'), 'utf8')).pr, null, 'nothing was published before the person handoff')
        await rig.publish()
        await mergeFromRepository(TEMPLATE_PUBLISH_BRANCH)
        const published = JSON.parse(readFileSync(join(directory, 'home', 'template-forge.json'), 'utf8')).pr
        rig.git('merge-base', '--is-ancestor', published.headRefOid, 'main')
        await photograph('12-person-merged')
        await returnToBoard()
        await page.getByRole('button', { name: `What to do with #${referee.id}`, exact: true }).click()
        await page.getByRole('menuitem', { name: 'Answer merged', exact: true }).click()
        const records = (await rig.host.call('evidence/board', { room: run.goal })).cards.flatMap(one => one.facts.map(fact => fact.record))
        const review = records.find(one => one.fact.kind === 'review')
        assert.equal(review?.fact.at, published.headRefOid, 'the fresh reviewer judged the actual published head')
        evidence.push({ template, startsOn: published.headRefName, keepsSeatedBranch: true, rounds: reviewed.execution.rounds.map(one => one.role), syntheticPullRequest: 41, publishedHead: published.headRefOid, reviewedHead: review.fact.at, mergedHead: rig.git('rev-parse', 'main'), branchSwitchEvidence: 'pre-existing frozen-branch limitation remains Backlog' })
      }
      await observe((cards, execution) => execution.state === 'settled' && cards.every(one => one.state === 'done'), 'template completed')
      await tab('Overview')
      await completedSeats()
      await expect(page.locator('[data-slot="run-ending"]')).toContainText('Nothing waits.')
      await expect(page.getByText('Needs you', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Not confirmed', { exact: true })).toHaveCount(0)
      if (template === 'fix-and-review') {
        const comments = JSON.parse(readFileSync(join(directory, 'home', 'template-forge.json'), 'utf8')).comments
        assert.equal(comments?.length ?? 0, 0, 'review before publication stays local')
      }
      // The completed comparison retains both attempt records, separately
      // from its routing rounds; ordinary Runs keep their progress in Details.
      if (template === 'comparison') {
        await chatView('Side by side')
        const summary = page.locator('[data-slot="comparison-summary"]')
        await expect(summary).toBeVisible()
        await expect(summary.locator('[data-slot="row"]')).toHaveCount(2)
        await expect(summary).toContainText('merged into main')
        await expect(summary).toContainText('not kept')
        await tab('Overview')
      } else {
        const toggle = page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Toggle rail', exact: true })
        const opened = await toggle.getAttribute('aria-pressed') !== 'true'
        if (opened) await toggle.click()
        await expect(page.locator('[aria-label="Team Run facts"] [data-slot="summary-item"]').filter({ has: page.locator('dt', { hasText: /^Progress$/ }) })).toContainText('Round 3 of 7')
        if (opened) await toggle.click()
      }
      // The board settles before the final turn/activity event reaches the
      // sidebar. Capture the finished Goal only once both surfaces agree.
      await page.waitForFunction(({ goal, run }) => {
        const snapshot = window.__hdStore.getSnapshot()
        return snapshot.flowExecutions.get(run)?.state === 'settled' &&
          snapshot.goals.has(goal) && snapshot.goals.get(goal).activity !== 'working'
      }, { goal: run.goal, run: run.id })
      // A finished Team stays in the sidebar, marked, until it is wrapped (#1675 D5).
      await expect(page.getByRole('button', { name: `Room ${task}`, exact: true })).toBeVisible({ timeout: 30000 })
      evidence.at(-1).settledSidebar = true
      await photograph('13-finished-overview')
      await tab('Run')
      await runView('Timeline')
      await photograph('14-finished-run')
      await tab('Board')
      const readyRail = page.getByRole('button', { name: /^Ready \d+ — Open column$/ })
      if (await readyRail.isVisible()) await readyRail.click()
      await expect(boardColumn('Needs you').getByRole('heading', { level: 4 })).toHaveCount(0)
      await expect(boardColumn('In review').getByRole('heading', { level: 4 })).toHaveCount(0)
      await expect(boardColumn('Ready').getByRole('heading', { level: 4 })).toHaveCount(template === 'comparison' ? 6 : 3)
      await photograph('15-finished-board')
      await chatView('Thread')
      await expect(page.locator('[data-slot="side-by-side-grid"]')).toHaveCount(0)
      await expect(page.getByText(/You (?:added|completed).*Check the attempt/)).toHaveCount(0)
      await expect(page.getByText(/The Flow .* added/).first()).toBeVisible()
      await expect(page.getByText(/\(Implementer\)/)).toHaveCount(0)
      await photograph('16-finished-chat')
      assert.deepEqual(rendererErrors, [], 'the shipped renderer had no uncaught errors')
    } catch (error) {
      if (existsSync(rig.logFile)) writeFileSync(join(out, `${template}-local-host-diagnostic.ndjson`), readFileSync(rig.logFile))
      if (page) { writeFileSync(join(out, `${template}-local-diagnostic.txt`), await page.locator('body').innerText()); writeFileSync(join(out, `${template}-local-diagnostic.json`), JSON.stringify(await page.evaluate(COLLECT), null, 2)); await page.screenshot({ path: join(out, `${template}-local-diagnostic.png`) }) }
      throw error
    } finally { await page?.close(); await server?.close(); await rig.dispose() }
  }
  writeFileSync(join(out, 'sequence.json'), `${JSON.stringify({ evidence, frames }, null, 2)}\n`)
} finally { await browser?.close(); rmSync(scratch, { recursive: true, force: true }) }
