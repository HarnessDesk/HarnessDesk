#!/usr/bin/env node
/** Headless, real Flow run: node script/shots/flow.mjs --out <frames>. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { serve } from '../../packages/server/dist/src/index.js'
import { COLLECT, TILDIFY, USER, textReasons } from './audit.mjs'
import { createFlowRig, startFlowScene } from './flow-rig.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const out = resolve(flag('out', join(tmpdir(), 'hd-flow-frames')))
mkdirSync(out, { recursive: true })
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hd-flow-scene-')))
let rig, server, browser
try {
  rig = await createFlowRig({ home: join(scratch, 'home'), work: join(scratch, 'person', 'work'), delayMs: 5000 })
  server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot: join(root, 'packages/ui/dist') })
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  await page.goto(`${server.url}/?token=${server.token}`)
  await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
  await page.evaluate(() => window.__hdStore.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }))
  const run = await startFlowScene(rig)
  await page.evaluate((goal) => window.__hdStore.openGoal(goal), run.goal)
  await page.getByRole('button', { name: /^Run\b/ }).click()
  await page.getByRole('radio', { name: 'Flow', exact: true }).click()
  const milestones = [
    ['01-write', (cards) => cards.some((one) => one.role === 'write' && one.state === 'claimed')],
    ['02-review', (cards) => cards.some((one) => one.role === 'review' && one.state === 'claimed')],
    ['03-repair', (cards) => cards.filter((one) => one.role === 'write').length === 2 && cards.some((one) => one.role === 'write' && one.state === 'claimed')],
    ['04-handoff', (cards) => cards.some((one) => one.role === 'land' && one.state === 'open')],
  ]
  const captured = []
  for (const [name, matches] of milestones) {
    let view, execution
    const deadline = Date.now() + 90000
    do {
      view = await rig.host.call('goal/read', { goal: run.goal })
      execution = await rig.host.call('flow/execution', { run: run.id })
      if (execution.state === 'stalled' || rig.errors.length) throw new Error(JSON.stringify({ reason: execution.reason, errors: rig.errors }))
      if (matches(view.board.intents)) break
      await new Promise((done) => setTimeout(done, 100))
    } while (Date.now() < deadline)
    if (!matches(view.board.intents)) throw new Error(`The run never reached ${name}`)
    // Await the window's copy of the actual card state before photographing
    // its Flow. Each theme then waits two paints and passes the privacy audit.
    await page.waitForFunction(({ goal, cards }) => {
      const shown = window.__hdStore.getSnapshot().teams.get(goal)?.intents ?? []
      return cards.every(([id, state, outcome]) => shown.some((one) => one.id === id && one.state === state && (one.outcome ?? null) === outcome))
    }, { goal: run.goal, cards: view.board.intents.map((one) => [one.id, one.state, one.outcome ?? null]) })
    await page.getByRole('radio', { name: 'Flow', exact: true }).waitFor()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.__hdStore.setTheme(value), theme)
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      await page.evaluate(TILDIFY(join(scratch, 'person')))
      const reasons = textReasons(await page.evaluate(COLLECT), { user: USER })
      if (reasons.length) throw new Error(reasons.join('\n'))
      const filename = `${name}-${theme}.png`
      await page.screenshot({ path: join(out, filename) })
      captured.push(filename)
      process.stdout.write(`Captured ${filename}\n`)
    }
  }
  const execution = await rig.host.call('flow/execution', { run: run.id })
  writeFileSync(join(out, 'sequence.json'), `${JSON.stringify({ rounds: execution.rounds.map((one) => one.role), frames: captured }, null, 2)}\n`)
} finally {
  await browser?.close()
  await server?.close()
  await rig?.dispose()
  rmSync(scratch, { recursive: true, force: true })
}
