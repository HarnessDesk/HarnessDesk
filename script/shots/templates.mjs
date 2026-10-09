#!/usr/bin/env node
/** New Team → completed shipped templates, driven only through the renderer. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { serve } from '../../packages/server/dist/src/index.js'
import { COLLECT, TILDIFY, USER, textReasons } from './audit.mjs'
import { createTemplateRig, TEMPLATE_CHECK, TEMPLATE_PUBLISH_BRANCH, TEMPLATE_TASK } from './template-rig.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const out = resolve(flag('out', join(tmpdir(), 'hd-template-frames')))
const ui = resolve(flag('ui', join(root, 'packages/ui/dist')))
mkdirSync(out, { recursive: true })
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hd-template-journeys-')))
let browser
const frames = [], evidence = []
try {
  browser = await chromium.launch({ headless: true })
  for (const template of ['comparison', 'fix-and-review']) {
    const directory = join(scratch, template)
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
          const filename = `${template}-${name}-${theme}.png`
          await page.screenshot({ path: join(out, filename), animations: 'disabled' })
          frames.push(filename)
          process.stdout.write(`Captured ${filename}\n`)
        }
      }
      // The New Team menu uses the current project, restored from its visible
      // recent-project list. Reopening it here would mask the old-record bug.
      await expect(page.getByRole('button', { name: 'storefront', exact: true })).toHaveAttribute('title', /^The folder this app is working in/)
      await expect(page.getByRole('button', { name: 'More ways to start', exact: true })).toBeVisible()
      if (template === 'fix-and-review') await expect(page.getByText(TEMPLATE_PUBLISH_BRANCH, { exact: true }).first()).toBeVisible()
      await photograph('00-project')
      await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
      await page.getByRole('menuitem', { name: /^New Team/ }).click()
      await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
      await photograph('01-new-team')
      const name = template === 'comparison' ? 'Side by side' : 'Write and review'
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${name}`) }).click()
      // The first dry run can still be installing the project's suggested
      // check when the task field appears. Wait for its editable Seat controls.
      await expect(page.getByRole('dialog').getByRole('combobox', { name: /^Agent for / }).first()).toBeEnabled({ timeout: 30000 })
      const task = template === 'comparison' ? TEMPLATE_TASK : `${TEMPLATE_TASK} for review`
      await page.getByRole('textbox', { name: template === 'comparison' ? 'What should both try?' : 'What should they do?', exact: true }).fill(task)
      if (template === 'comparison') {
        const command = page.getByRole('textbox', { name: 'Check each attempt with', exact: true })
        await expect(command).toHaveValue('pnpm test')
        await command.fill(TEMPLATE_CHECK)
        await expect(command).toHaveValue(TEMPLATE_CHECK)
      }
      await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: 30000 })
      await expect(page.getByRole('dialog').getByRole('combobox', { name: /^Model for / }).first()).toBeVisible()
      await page.getByRole('textbox', { name: template === 'comparison' ? 'What should both try?' : 'What should they do?', exact: true }).scrollIntoViewIfNeeded()
      await photograph('02-task')
      await page.getByText('Details', { exact: true }).click()
      const reviewer = page.getByRole('combobox', { name: template === 'comparison' ? 'Agent for Judge' : 'Agent for Reviews', exact: true })
      await reviewer.selectOption('codex-review')
      await expect(reviewer).toHaveValue('codex-review')
      if (template === 'comparison') await expect(page.getByRole('region', { name: 'Commands it runs' }).getByText(new RegExp(TEMPLATE_CHECK.replaceAll('.', '\\.')))).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: 30000 })
      await page.getByRole('region', { name: 'Seats this would open' }).scrollIntoViewIfNeeded()
      await photograph('03-preview')
      assert.equal(JSON.parse(readFileSync(rig.stateFile, 'utf8')).workspaces[0].shellIdentity, undefined, 'preview does not pre-admit the legacy record')
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(page.getByRole('dialog', { name, exact: true })).toHaveCount(0, { timeout: 30000 })
      await page.waitForFunction(name => [...window.__hdStore.getSnapshot().flowExecutions.values()].some(one => one.document.flow.name === name && window.__hdStore.getSnapshot().goals.has(one.goal)), name)
      const run = await page.evaluate(name => {
        const snapshot = window.__hdStore.getSnapshot()
        const execution = [...snapshot.flowExecutions.values()].find(one => one.document.flow.name === name && snapshot.goals.has(one.goal))
        return { id: execution.id, goal: execution.goal }
      }, name)
      const observe = async (matches, label) => {
        let view, execution
        const until = Date.now() + 30000
        do {
          view = await rig.host.call('goal/read', { goal: run.goal })
          execution = await rig.host.call('flow/execution', { run: run.id })
          assert.deepEqual(rig.errors, [], 'no scripted agent tool failure')
          assert.notEqual(execution.state, 'stalled', execution.reason ?? 'the template stalled')
          if (matches(view.board.intents, execution)) break
          await new Promise(done => setTimeout(done, 50))
        } while (Date.now() < until)
        assert.ok(matches(view.board.intents, execution), `${label}: ${JSON.stringify({ execution, cards: view.board.intents })}`)
        await page.waitForFunction(({ goal, cards }) => cards.every(([id, state, outcome]) => window.__hdStore.getSnapshot().teams.get(goal)?.intents.some(one => one.id === id && one.state === state && (one.outcome ?? null) === outcome)),
          { goal: run.goal, cards: view.board.intents.map(one => [one.id, one.state, one.outcome ?? null]) })
        return { view, execution }
      }
      const tab = async name => { await page.getByRole('tablist', { name: 'Team pages', exact: true }).getByRole('tab', { name: new RegExp(`^${name}\\b`) }).click() }
      const boardTitle = title => page.getByRole('heading', { level: 4, name: new RegExp(`^#\\d+ ${title}$`) })
      const boardColumn = name => page.locator('[data-slot="board-column"]').filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })
      await observe(cards => cards.filter(one => one.role === (template === 'comparison' ? 'competitor' : 'fixer') && one.state === 'claimed').length === (template === 'comparison' ? 2 : 1), 'writers seated')
      await tab('Overview')
      await expect(page.getByText('Working', { exact: true }).first()).toBeVisible()
      await photograph('04-writing-overview')
      await tab('Run')
      await page.getByRole('radio', { name: 'Timeline', exact: true }).click()
      await expect(page.getByText(task, { exact: true }).first()).toBeVisible()
      await photograph('05-writing-timeline')
      await page.getByRole('radio', { name: 'Flow', exact: true }).click()
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
        for (const diff of diffs) {
          assert.notEqual(diff.checkout.cwd, rig.repo)
          const attempts = readdirSync(diff.checkout.cwd).filter(one => /^rig-attempt-[12]\.txt$/.test(one))
          assert.equal(attempts.length, 1)
          assert.match(readFileSync(join(diff.checkout.cwd, attempts[0]), 'utf8'), /^Attempt [12]:/)
        }
        await expect(boardTitle('Check the attempt')).toHaveCount(2)
        const checkCards = page.locator('[data-slot="board-card"]').filter({ has: boardTitle('Check the attempt') })
        await expect(boardColumn('To do').getByRole('heading', { level: 4 })).toHaveCount(2)
        await expect(checkCards.filter({ hasText: 'verify running' })).toHaveCount(1)
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
        rig.release('judge')
        const picked = await observe(cards => cards.some(one => one.role === 'referee' && one.state === 'open'), 'person merge step')
        await expect(boardTitle('Merge the picked change')).toBeVisible()
        await expect(boardColumn('Needs you').getByRole('heading', { level: 4, name: /^#\d+ Merge the picked change$/ })).toBeVisible()
        await photograph('10-referee-board')
        await page.getByRole('button', { name: 'Side by side', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Merge A into main', exact: true })).toBeEnabled()
        await expect(page.getByText('The agent finished this turn without any output.', { exact: true })).toHaveCount(0)
        await photograph('11-picked-attempt')
        await page.getByRole('button', { name: 'Merge A into main', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Merge into main', exact: true })).toBeVisible()
        await photograph('12-merge')
        await expect(page.getByRole('dialog').getByRole('combobox', { name: 'What to merge', exact: true })).toHaveValue(diffs[0].fact.to)
        await page.getByRole('dialog').getByRole('button', { name: 'Merge', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Merge into main', exact: true })).toHaveCount(0)
        rig.git('merge-base', '--is-ancestor', diffs[0].fact.to, 'main')
        const board = await rig.host.call('evidence/board', { room: run.goal })
        const checks = board.cards.flatMap(one => one.facts.filter(fact => fact.record.fact.kind === 'check').map(fact => fact.record))
        assert.equal(checks.length, 2)
        assert.ok(checks.every(one => one.fact.run === TEMPLATE_CHECK && one.fact.exit === 0))
        assert.deepEqual(checks.map(one => one.fact.at).sort(), diffs.map(one => one.fact.to).sort(), 'each check names its actual committed attempt')
        evidence.push({ template, firstRecord: 'path/name/lastOpenedAt/id only', lanes: diffs.length, checks: checks.map(one => ({ command: one.fact.run, exitCode: one.fact.exit, at: one.fact.at })), pickedHead: diffs[0].fact.to, mergedHead: rig.git('rev-parse', 'main'), rounds: picked.execution.rounds.map(one => one.role) })
      } else {
        rig.release('writer')
        await observe(cards => cards.some(one => one.role === 'reviewer' && one.state === 'claimed'), 'fresh reviewer seated')
        await expect(boardTitle('Review the pull request')).toBeVisible()
        await expect(boardColumn('Working').getByRole('heading', { level: 4 })).toHaveCount(1)
        await photograph('08-review-board')
        rig.release('reviewer')
        const reviewed = await observe(cards => cards.some(one => one.role === 'referee' && one.state === 'open'), 'person handoff')
        await expect(boardTitle('Merge it — every reviewer approved')).toBeVisible()
        await expect(boardColumn('Needs you').getByRole('heading', { level: 4, name: /^#\d+ Merge it — every reviewer approved$/ })).toBeVisible()
        await photograph('09-referee-board')
        const referee = reviewed.view.board.intents.find(one => one.role === 'referee')
        const repository = async () => {
          await page.getByRole('button', { name: 'Search everything', exact: true }).click()
          await page.getByPlaceholder('Search sessions, files, agents, commands, actions…').fill('Show repository')
          await page.getByRole('option', { name: /^Show repository/ }).click()
        }
        await repository()
        await page.getByRole('button', { name: 'Give this panel the whole area', exact: true }).last().click()
        const main = page.getByTitle('main — click to find it, double-click to check it out', { exact: true })
        await main.dblclick()
        await expect(main).toHaveAttribute('data-current', '')
        await photograph('10-person-repository')
        await page.getByTitle('Merge into the current branch…', { exact: true }).click()
        const merge = page.getByRole('dialog', { name: 'Merge into main', exact: true })
        await merge.getByRole('combobox', { name: 'What to merge', exact: true }).selectOption('rig-write-review-1')
        await photograph('11-person-merge')
        await merge.getByRole('button', { name: 'Merge', exact: true }).click()
        await expect(merge).toHaveCount(0)
        const published = JSON.parse(readFileSync(join(directory, 'home', 'template-forge.json'), 'utf8')).pr
        rig.git('merge-base', '--is-ancestor', published.headRefOid, 'main')
        await photograph('12-person-merged')
        await page.getByRole('button', { name: 'Back to the layout', exact: true }).click()
        await repository()
        await tab('Board')
        await page.getByRole('button', { name: `What to do with #${referee.id}`, exact: true }).click()
        await page.getByRole('menuitem', { name: 'Answer merged', exact: true }).click()
        const records = (await rig.host.call('evidence/board', { room: run.goal })).cards.flatMap(one => one.facts.map(fact => fact.record))
        const review = records.find(one => one.fact.kind === 'review')
        assert.equal(review?.fact.at, published.headRefOid, 'the fresh reviewer judged the actual published head')
        evidence.push({ template, startsOn: published.headRefName, keepsSeatedBranch: true, rounds: reviewed.execution.rounds.map(one => one.role), syntheticPullRequest: 41, publishedHead: published.headRefOid, reviewedHead: review.fact.at, mergedHead: rig.git('rev-parse', 'main'), branchSwitchEvidence: 'pre-existing frozen-branch limitation remains Backlog' })
      }
      await observe((cards, execution) => execution.state === 'settled' && cards.every(one => one.state === 'done'), 'template completed')
      await tab('Overview')
      await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 30000 })
      await expect(page.getByRole('status').filter({ hasText: 'this run is complete.' })).toBeVisible()
      await expect(page.getByText('Needs you', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Not confirmed', { exact: true })).toHaveCount(0)
      if (template === 'fix-and-review') {
        const comments = JSON.parse(readFileSync(join(directory, 'home', 'template-forge.json'), 'utf8')).comments
        assert.equal(comments?.length, 1, 'the Host posted one closed-round review comment to the local forge')
        assert.ok(comments[0].body.includes(`reviewed ${evidence.at(-1).publishedHead.slice(0, 12)} in round 2 and raised no findings.`))
        evidence.at(-1).reviewCommentUrl = comments[0].html_url
      }
      await expect(page.getByText(template === 'comparison' ? 'Rounds 4 of 4' : 'Rounds 3 of 7', { exact: true })).toBeVisible()
      await photograph('13-finished-overview')
      await tab('Run')
      await page.getByRole('radio', { name: 'Timeline', exact: true }).click()
      await photograph('14-finished-run')
      await tab('Board')
      const readyRail = page.getByRole('button', { name: /^Ready \d+ — Open column$/ })
      if (await readyRail.isVisible()) await readyRail.click()
      await expect(boardColumn('Needs you').getByRole('heading', { level: 4 })).toHaveCount(0)
      await expect(boardColumn('In review').getByRole('heading', { level: 4 })).toHaveCount(0)
      await expect(boardColumn('Ready').getByRole('heading', { level: 4 })).toHaveCount(template === 'comparison' ? 6 : 3)
      await photograph('15-finished-board')
      await tab('Chat')
      await expect(page.getByText(/You (?:added|completed).*Check the attempt/)).toHaveCount(0)
      await expect(page.getByText(/The Flow .* added/).first()).toBeVisible()
      await expect(page.getByText(/\(Implementer\)/)).toHaveCount(0)
      await photograph('16-finished-chat')
      assert.deepEqual(rendererErrors, [], 'the shipped renderer had no uncaught errors')
    } catch (error) {
      if (page) { writeFileSync(join(out, `${template}-local-diagnostic.txt`), await page.locator('body').innerText()); writeFileSync(join(out, `${template}-local-diagnostic.json`), JSON.stringify(await page.evaluate(COLLECT), null, 2)); await page.screenshot({ path: join(out, `${template}-local-diagnostic.png`) }) }
      throw error
    } finally { await page?.close(); await server?.close(); await rig.dispose() }
  }
  writeFileSync(join(out, 'sequence.json'), `${JSON.stringify({ evidence, frames }, null, 2)}\n`)
} finally { await browser?.close(); rmSync(scratch, { recursive: true, force: true }) }
