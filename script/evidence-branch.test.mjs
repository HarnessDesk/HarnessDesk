import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createFlowRig } from './shots/flow-rig.mjs'

// Optional photography uses exactly the Host state this regression produced.
// Ordinary test runs need neither a renderer build nor a browser.
const photograph = async (rig, goal, directory, mode) => {
  if (!process.env.HD_EVIDENCE_FRAMES || !['same', 'switch', 'switch-after'].includes(mode)) return
  const { chromium } = await import('@playwright/test')
  const { serve } = await import('../packages/server/dist/src/index.js')
  const { COLLECT, TILDIFY, USER, textReasons } = await import('./shots/audit.mjs')
  const server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot: fileURLToPath(new URL('../packages/ui/dist', import.meta.url)) })
  const browser = await chromium.launch({ headless: true })
  let page
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.goto(`${server.url}/?token=${server.token}`)
    await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
    await page.waitForFunction(goal => window.__hdStore.getSnapshot().goals.has(goal), goal)
    await page.evaluate(() => window.__hdStore.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }))
    await page.getByText('Review the committed retry change', { exact: true }).click()
    await page.getByRole('tab', { name: /^Board\b/ }).click()
    await page.getByText('Build the retry change', { exact: false }).first().waitFor()
    if (mode === 'switch' && !process.env.HD_EVIDENCE_BEFORE) await page.getByText(SWITCH_NOTE, { exact: false }).first().waitFor()
    if (mode === 'switch-after') {
      await page.getByRole('button', { name: /^What the desk observed on #1:/ }).click()
      const dialog = page.getByRole('dialog', { name: 'What the desk observed on #1' })
      await dialog.waitFor()
      await dialog.getByText(/on (original|after)$/, { exact: false }).waitFor()
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => window.__hdStore.setTheme(value), theme)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.evaluate(TILDIFY(directory, '~/.branch-evidence-rig'))
      assert.deepEqual(textReasons(await page.evaluate(COLLECT), { user: USER }), [])
      mkdirSync(process.env.HD_EVIDENCE_FRAMES, { recursive: true })
      const phase = process.env.HD_EVIDENCE_BEFORE ? 'before' : 'after'
      await page.screenshot({ path: join(process.env.HD_EVIDENCE_FRAMES, `${mode}-${phase}-${theme}.png`), animations: 'disabled' })
    }
  } catch (error) {
    mkdirSync(process.env.HD_EVIDENCE_FRAMES, { recursive: true })
    writeFileSync(join(process.env.HD_EVIDENCE_FRAMES, `${mode}-diagnostic.txt`), await page.locator('body').innerText())
    await page.screenshot({ path: join(process.env.HD_EVIDENCE_FRAMES, `${mode}-diagnostic.png`) })
    throw error
  } finally {
    await browser.close()
    await server.close()
  }
}

const SWITCH_NOTE = 'Work may span branches; review the final revision.'

const source = isolate => `
version: 2
name: Branch evidence
roles:
  write: { kind: agent, uses: implementer, grant: edit, isolate: ${isolate} }
  review: { kind: agent, uses: code-reviewer, grant: read, isolate: true }
  land: { kind: person, outcomes: [done] }
seed: { role: write, title: Build the retry change, detail: RIG_FLOW_WRITE, files: [rig-retry.txt] }
rules:
  - { id: review, on: write, when: { every: [committed], evidence: [{ diff: true }] }, then: { role: review, title: Review the retry change, detail: RIG_FLOW_REVIEW } }
  - { id: land, on: review, when: { every: [request-changes], evidence: [{ review: request-changes }] }, then: { role: land, title: Inspect the final revision } }
messaging: board-only
`

const until = async (read, what) => {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

for (const mode of ['same', 'switch', 'switch-back', 'isolated', 'switch-after']) {
  test(`scripted turn records its final branch: ${mode}`, { timeout: 180000 }, async t => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hd-evidence-branch-')))
    const gates = join(directory, 'gates')
    mkdirSync(gates)
    let evidenceNow = Date.now()
    const rig = await createFlowRig({ home: join(directory, 'home'), work: join(directory, 'work'), gates, evidenceNow: () => evidenceNow })
    t.after(async () => { await rig.dispose(); rmSync(directory, { recursive: true, force: true }) })
    const git = (...args) => execFileSync('git', args, { cwd: rig.repo, encoding: 'utf8', stdio: 'pipe' }).trim()
    git('switch', '-c', 'original')
    const text = source(mode === 'isolated')
    const preview = await rig.host.call('flow/preview', { root: rig.repo, source: text, vars: {} })
    assert.ok(preview.token, JSON.stringify(preview.problems))
    const run = await rig.host.call('flow/start-goal', { root: rig.repo, source: text, token: preview.token, sentence: 'Review the committed retry change', vars: {} })
    const read = () => rig.host.call('goal/read', { goal: run.goal })
    const writer = await until(async () => (await read()).board.intents.find(one => one.role === 'write' && one.state === 'claimed'), 'the gated writer')
    const claimed = JSON.parse(readFileSync(join(directory, 'home', 'goals', `${run.goal}.json`), 'utf8')).board.intents.find(one => one.id === writer.id)
    assert.equal(typeof claimed.claim.checkoutMark, 'string', 'the durable claim records checkout-move history before the turn')
    const writerBranch = execFileSync('git', ['branch', '--show-current'], { cwd: claimed.claim.cwd, encoding: 'utf8' }).trim()
    if (!['same', 'switch-after'].includes(mode)) git('switch', '-c', 'changed')
    if (mode === 'switch-back') git('switch', 'original')
    writeFileSync(join(gates, 'RIG_FLOW_WRITE'), '')
    const reviewer = await until(async () => (await read()).board.intents.find(one => one.role === 'review' && one.state === 'claimed'), 'the gated reviewer')
    const candidates = await until(async () => {
      const found = await rig.host.teamPlane.reviewCandidates(reviewer.id, reviewer.claim)
      return found.length ? found : null
    }, 'the reviewer binding')
    assert.equal(candidates.length, 1)
    // Capture the same completed writer before the assertions, so a frozen-
    // branch mutation can leave its failing reproduction's before frames.
    if (mode !== 'switch-after') await photograph(rig, run.goal, directory, mode)
    const expected = mode === 'switch' ? 'changed' : mode === 'isolated' ? writerBranch : 'original'
    if (mode === 'isolated') assert.match(expected, /^harnessdesk\//)
    assert.equal(candidates[0].branch, expected, 'the candidate must name the writer checkout now, not its Seat opening branch')
    if (mode === 'switch-after') {
      git('switch', '-c', 'after')
      await assert.rejects(() => rig.host.teamPlane.recordReview({ intent: reviewer.id, candidate: candidates[0].id, verdict: 'request-changes' }, reviewer.claim), /moved on/)
      await assert.rejects(() => rig.host.teamPlane.reviewCandidates(reviewer.id, reviewer.claim), /switched branches after this card finished/)
      writeFileSync(join(rig.repo, 'later.txt'), 'Later card work.\n')
      evidenceNow += 5 * 60 * 1000 + 1
      const refreshed = await until(async () => {
        const board = await rig.host.call('evidence/board', { room: run.goal })
        const diff = board.cards.find(one => one.card === writer.id)?.facts.find(one => one.record.fact.kind === 'diff')?.record
        return diff?.fact.dirty ? diff : null
      }, 'the stopped diff refresh on a later branch')
      // Photograph the real refreshed record before asserting so a mutation
      // retains its failing branch label for the review's before frames.
      await photograph(rig, run.goal, directory, mode)
      assert.equal(refreshed.checkout.branch, expected, 'a refreshed stopped diff keeps the completion branch')
      assert.equal(refreshed.fact.to, candidates[0].at)
      rmSync(join(rig.repo, 'later.txt'))
      git('switch', 'original')
    }
    writeFileSync(join(gates, 'RIG_FLOW_REVIEW'), '')
    await until(async () => (await read()).board.intents.find(one => one.role === 'land'), 'the evidence-guarded handoff')
    assert.deepEqual(rig.errors, [])
    const evidence = await rig.host.call('evidence/board', { room: run.goal })
    const fact = (card, kind) => evidence.cards.find(one => one.card === card)?.facts.find(one => one.record.fact.kind === kind)?.record
    const diff = fact(writer.id, 'diff')
    const review = fact(reviewer.id, 'review')
    assert.equal(review.fact.at, diff.fact.to)
    assert.equal(review.checkout.branch, expected)
    assert.equal(diff.checkout.branch, expected)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: diff.checkout.cwd, encoding: 'utf8' }).trim(), review.fact.at)
    const done = (await read()).board.intents.find(one => one.id === writer.id)
    assert.equal(done.untilBranch, expected, 'the branch at completion is durable')
    if (mode === 'switch' || mode === 'switch-back') assert.ok(done.note.includes(SWITCH_NOTE), 'the card explains branch ambiguity, including a switch and return')
    else assert.equal(done.note, 'Scripted committed.')
  })
}
