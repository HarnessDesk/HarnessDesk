#!/usr/bin/env node
/** Real Team grid against scripted fake agents, in a disposable desk. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { serve } from '../../packages/server/dist/src/index.js'
import { COLLECT, TILDIFY, USER, textReasons } from './audit.mjs'
import { createFlowRig } from './flow-rig.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out = resolve(process.argv[2] ?? join(tmpdir(), 'hd-shared-composer-frames'))
mkdirSync(out, { recursive: true })
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hd-shared-composer-')))
process.env.HARNESSDESK_HOME = join(scratch, 'home')
let rig, server, browser, page
const evidence = []
try {
  rig = await createFlowRig({ home: process.env.HARNESSDESK_HOME, work: join(scratch, 'person', 'work'), scriptedTurns: false })
  const sessions = []
  for (let at = 0; at < 4; at++) {
    sessions.push(await rig.host.call('session/create', { runtime: 'codex', options: { cwd: rig.repo } }))
  }
  const room = (await rig.host.teamPlane.createRoom(rig.repo, 'Checkout retry comparison')).id
  for (const session of sessions) await rig.host.teamPlane.joinRoom(room, session.runtime, session.id)
  const peers = await rig.host.call('team/peers', { room })
  console.log('Fake seats:', peers.map(one => ({ nickname: one.nickname, sessionId: one.sessionId })))
  server = await serve({ host: rig.host, logger: rig.logger, port: 0, uiRoot: join(root, 'packages/ui/dist') })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => console.error('Renderer:', error.message))
  await page.goto(`${server.url}/?token=${server.token}`)
  await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
  await page.evaluate(path => window.__hdStore.openWorkspace(path), rig.repo)
  await page.evaluate((id) => { window.__hdStore.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }); window.__hdStore.openTeamRoom(id) }, room)
  for (const at of [0, 1]) {
    await page.getByRole('button', { name: 'Team members', exact: true }).click()
    await page.getByRole('button', { name: /^Watch / }).nth(at).click()
  }
  await page.keyboard.press('Escape')
  await page.mouse.move(0, 0)
  const box = page.locator('[data-shared-composer] [data-slot="composer-text"]')
  await box.waitFor({ state: 'visible' })
  await box.fill('Keep this room draft while reading one attempt.')
  await page.getByRole('button', { name: 'Expand GPT', exact: true }).click()
  assert.equal(await box.isVisible(), false)
  await page.getByRole('button', { name: 'Collapse GPT', exact: true }).click()
  assert.equal(await box.inputValue(), 'Keep this room draft while reading one attempt.')
  await page.setViewportSize({ width: 800, height: 1000 })
  await page.waitForFunction(() => document.querySelector('[data-shared-composer]')?.hidden)
  assert.equal(await page.locator('[data-slot="side-by-side-tile"]:not([data-hidden]) [data-slot="composer-text"]').count(), 1)
  await page.setViewportSize({ width: 1680, height: 1000 })
  await box.waitFor({ state: 'visible' })
  await page.getByRole('tab', { name: /^Chat\b/ }).click()
  assert.equal(await page.locator('[data-slot="composer-text"]').inputValue(), 'Keep this room draft while reading one attempt.')
  await page.getByRole('button', { name: 'Side by side', exact: true }).click()
  await box.waitFor({ state: 'visible' })
  assert.equal(await box.inputValue(), 'Keep this room draft while reading one attempt.')
  evidence.push('Expand and narrow layouts show the individual composer; Chat and the grid retain the same waiting room draft.')
  await box.fill('Compare the retry budget and explain the tradeoffs.')
  await box.press('Enter')
  await page.waitForFunction(({ room, text }) => {
    const messages = window.__hdStore.getSnapshot().teams.get(room)?.channel.filter(one => one.kind === 'message' && one.from.kind === 'user' && one.text === text) ?? []
    return messages.length === 2
  }, { room: room, text: 'Compare the retry budget and explain the tradeoffs.' })
  const sent = (await rig.host.call('team/state', { room: room })).channel.filter(one => one.kind === 'message' && one.from.kind === 'user' && one.text === 'Compare the retry budget and explain the tradeoffs.')
  assert.equal(sent.length, 2)
  assert.deepEqual(new Set(sent.map(one => one.to.sessionId)), new Set(peers.slice(0, 2).map(one => one.sessionId)))
  evidence.push('Default send reached exactly the two displayed Seats; two off-grid Seats received no copy.')
  await page.waitForFunction(() => window.__hdStore.getSnapshot().approvals.length >= 2)
  const pending = await page.evaluate(() => window.__hdStore.getSnapshot().approvals.map(one => one.approval.id).sort())
  await box.fill('Keep approval shortcuts out of this draft: ')
  await box.press('1')
  await box.press('Escape')
  assert.equal(await box.inputValue(), 'Keep approval shortcuts out of this draft: 1')
  assert.deepEqual(await page.evaluate(() => window.__hdStore.getSnapshot().approvals.map(one => one.approval.id).sort()), pending)
  evidence.push('Digits and Escape in the shared textarea leave every tile approval unanswered.')
  await box.fill('')
  const geometry = await page.locator('[data-slot="side-by-side-grid"]').evaluate(grid => {
    const dock = grid.querySelector('[data-shared-composer]').getBoundingClientRect()
    return [...grid.querySelectorAll('[data-slot="side-by-side-tile"]')].map(tile => {
      const approval = tile.querySelector('[data-slot="approval-dialog-scope"]')
      const body = tile.lastElementChild.getBoundingClientRect()
      const bounds = approval?.getBoundingClientRect()
      const viewport = tile.querySelector('[data-slot="dialog-viewport"]').getBoundingClientRect()
      const scroll = tile.querySelector('[data-live-transcript]')
      return { bodyBottom: body.bottom, tileBottom: tile.getBoundingClientRect().bottom, dockTop: dock.top, viewportBottom: viewport.bottom, scrollPadding: parseFloat(getComputedStyle(scroll).paddingBottom), dockHeight: dock.height, approval: bounds ? { top: bounds.top, bottom: bounds.bottom } : null }
    })
  })
  assert(geometry.every(one => one.bodyBottom === one.tileBottom && one.bodyBottom > one.dockTop && one.viewportBottom <= one.dockTop + 1 && one.scrollPadding >= one.dockHeight), JSON.stringify(geometry))
  evidence.push('Both panels extend to the bottom behind the floating dock; transcript padding and approval viewports clear its measured height.')
  const capture = async name => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => window.__hdStore.setTheme(value), theme)
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      await page.evaluate(TILDIFY(join(scratch, 'person')))
      const reasons = textReasons(await page.evaluate(COLLECT), { user: USER })
      assert.deepEqual(reasons, [])
      await page.screenshot({ path: join(out, `${name}-${theme}.png`), animations: 'disabled' })
      console.log(`Captured ${name}-${theme}.png`)
    }
  }
  await capture('shared-composer-approvals')
  for (const [count, message] of [[1, 'Only the first attempt should receive this.'], [2, 'Only the first two attempts should receive this.']]) {
    while (await page.locator('[data-shared-composer] [data-slot="composer-chip"] button').count()) await page.locator('[data-shared-composer] [data-slot="composer-chip"] button').first().click()
    for (let at = 0; at < count; at++) {
      await box.fill('@GPT')
      await page.getByRole('option').nth(at).click()
    }
    await box.fill(message)
    await box.press('Enter')
    await page.waitForFunction(({ room, message, count }) => window.__hdStore.getSnapshot().teams.get(room)?.channel.filter(one => one.kind === 'message' && one.from.kind === 'user' && one.text === message).length === count, { room, message, count })
    const copies = (await rig.host.call('team/state', { room })).channel.filter(one => one.kind === 'message' && one.from.kind === 'user' && one.text === message)
    assert.deepEqual(new Set(copies.map(one => one.to.sessionId)), new Set(peers.slice(0, count).map(one => one.sessionId)))
    assert(copies.every(one => one.state === 'queued'))
    await box.waitFor({ state: 'visible' })
  }
  evidence.push('@ one and @ several reached exactly those Seats and queued behind their pending turns.')
  while (await page.locator('[data-shared-composer] [data-slot="composer-chip"] button').count()) await page.locator('[data-shared-composer] [data-slot="composer-chip"] button').first().click()
  for (const at of [2, 3]) {
    await page.getByRole('button', { name: 'Team members', exact: true }).click()
    await page.getByRole('button', { name: /^Watch / }).nth(at).click()
  }
  await page.mouse.move(0, 0)
  await box.fill('Compare all four attempts.')
  await box.press('Enter')
  await page.waitForFunction(() => window.__hdStore.getSnapshot().approvals.length === 4)
  await page.waitForFunction(room => window.__hdStore.getSnapshot().teams.get(room)?.channel.filter(one => one.kind === 'message' && one.from.kind === 'user' && one.text === 'Compare all four attempts.').length === 4, room)
  const fourPost = (await rig.host.call('team/state', { room })).channel.filter(one => one.kind === 'message' && one.from.kind === 'user' && one.text === 'Compare all four attempts.')
  assert.deepEqual(fourPost.map(one => one.state).sort(), ['delivered', 'delivered', 'queued', 'queued'])
  assert.equal(await page.locator('[data-slot="side-by-side-tile"] header [title="Queued — next after this turn"]').count(), 2)
  const fourGeometry = await page.locator('[data-slot="side-by-side-grid"]').evaluate(grid => {
    const dock = grid.querySelector('[data-shared-composer]').getBoundingClientRect()
    return [...grid.querySelectorAll('[data-slot="side-by-side-tile"]')].map(tile => {
      const body = tile.lastElementChild.getBoundingClientRect()
      const scrim = tile.querySelector('[data-slot="dialog-overlay"]').getBoundingClientRect()
      const popup = tile.querySelector('[data-slot="dialog-popup"]').getBoundingClientRect()
      return { bodyTop: body.top, bodyBottom: body.bottom, dockTop: dock.top, scrimTop: scrim.top, scrimBottom: scrim.bottom, popupTop: popup.top, popupBottom: popup.bottom }
    })
  })
  assert(fourGeometry.every(one => one.scrimTop >= one.bodyTop - 1 && one.scrimBottom <= one.bodyBottom + 1 && one.popupTop >= one.bodyTop - 1 && one.popupBottom <= Math.min(one.bodyBottom, one.dockTop) + 1), JSON.stringify(fourGeometry))
  await capture('shared-composer-four-approvals')
  evidence.push('Four tile approvals and their buttons stay inside their own bodies, clear of the shared dock; busy copies are queued.')
  await page.setViewportSize({ width: 1680, height: 520 })
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const shortGeometry = await page.locator('[data-slot="side-by-side-tile"]').evaluateAll(tiles => tiles.map(tile => {
    const body = tile.lastElementChild.getBoundingClientRect()
    const dockTop = tile.closest('[data-slot="side-by-side-grid"]').querySelector('[data-shared-composer]').getBoundingClientRect().top
    const popup = tile.querySelector('[data-slot="dialog-popup"]')
    popup.scrollTop = popup.scrollHeight
    const buttons = [...popup.querySelectorAll('button')].map(button => { const rect = button.getBoundingClientRect(); return [rect.top, rect.bottom] })
    return { body: [body.top, body.bottom], dockTop, buttons }
  }))
  assert(shortGeometry.every(one => one.body[1] > one.body[0] && one.buttons.every(([top, bottom]) => top >= one.body[0] - 1 && bottom <= Math.min(one.body[1], one.dockTop) + 1)), JSON.stringify(shortGeometry))
  evidence.push('At the minimum 520px window height, every tile keeps a nonzero body and each approval can scroll to its answer buttons.')
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.getByRole('tab', { name: /^Chat\b/ }).click()
  await page.getByText('Compare the retry budget and explain the tradeoffs.', { exact: true }).waitFor()
  assert.equal(await page.getByText('Compare the retry budget and explain the tradeoffs.', { exact: true }).count(), 1)
  evidence.push('Chat renders the shared message once.')
  // Stage a readable transcript frame by denying the scripted requests
  // explicitly. The shared composer never participates in those answers.
  for (let at = 0; at < 16; at++) {
    await page.waitForFunction(() => window.__hdStore.getSnapshot().approvals.length > 0 || [...window.__hdStore.getSnapshot().sessions.values()].every(one => one.turns.at(-1)?.status !== 'inProgress'))
    const pending = await page.evaluate(() => {
      const one = window.__hdStore.getSnapshot().approvals[0]
      return one ? { key: one.key, id: one.approval.id, option: one.approval.options.find(option => option.intent === 'deny')?.id } : null
    })
    if (!pending) break
    assert(pending.option)
    await page.evaluate(({ key, id, option }) => window.__hdStore.respondToApproval(key, id, { type: 'option', optionId: option }), pending)
  }
  await page.waitForFunction(() => window.__hdStore.getSnapshot().approvals.length === 0)
  await page.getByRole('button', { name: 'Side by side', exact: true }).click()
  for (const name of ['GPT 3', 'GPT 4']) {
    await page.getByRole('button', { name: `${name} actions`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Take off the grid', exact: true }).click()
  }
  await box.fill('Compare the retry limits across these attempts.')
  await capture('shared-composer-transcripts')
  writeFileSync(join(out, 'evidence.json'), `${JSON.stringify({ evidence, geometry, fourGeometry, shortGeometry }, null, 2)}\n`)
  console.log(evidence.join('\n'))
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText())
    await page.screenshot({ path: join(out, 'local-diagnostic.png') })
  }
  throw error
} finally {
  await browser?.close()
  await server?.close()
  await rig?.dispose()
  rmSync(scratch, { recursive: true, force: true })
}
