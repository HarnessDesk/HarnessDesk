#!/usr/bin/env node
/** Local-only walkthrough camera: shipping renderer, isolated scripted seats. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { Host, Logger, StateStore, serve } from '../../packages/server/dist/src/index.js'
import { ExtensionKernel, setTeamEngine } from '../../packages/cordis-host/dist/src/index.js'
import { teamPlugin } from '../../packages/plugins/dist/src/index.js'
import { CodexRuntime } from '../../packages/adapter-codex/dist/src/index.js'
import { GatedRegistry } from '../../packages/server/dist/src/ceilings/gate.js'
import { COLLECT, TILDIFY, USER, textReasons, accountReasons } from './audit.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outFlag = process.argv.indexOf('--out')
const out = resolve(outFlag < 0 ? '.lead-out/race-walk' : process.argv[outFlag + 1])
const scratch = '/tmp/race-walk/desk-' + randomUUID()
const home = join(scratch, 'home'), work = join(scratch, 'person', 'work')
mkdirSync(out, { recursive: true })
mkdirSync(home, { recursive: true })
const repo = join(work, 'storefront')
let host, extensions, server, browser, page
const frames = [], errors = []
const gameHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Click game — Attempt __ATTEMPT__</title>
<style>body{margin:0;background:#f4f1e8;color:#222;font:18px system-ui;display:grid;place-content:center;min-height:100vh;text-align:center}h1{font-size:32px}button{font:inherit;border:0;border-radius:12px;padding:18px 32px;background:#205c50;color:white;cursor:pointer}strong{font-size:64px;display:block;margin:24px}p{color:#555}</style>
</head><body><p>ATTEMPT __ATTEMPT__</p><h1>One click. One point.</h1><strong id="score">0</strong><button disabled>Add a point</button><p>A small game built in an isolated checkout.</p>
<script type="module">import {nextScore} from './game.js';const button=document.querySelector('button');button.addEventListener('click',()=>{const score=document.querySelector('#score');score.textContent=nextScore(Number(score.textContent))});button.disabled=false</script></body></html>`
try {
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '1' }, stdio: 'pipe',
  })
  const flows = join(repo, '.harnessdesk/flows')
  mkdirSync(flows, { recursive: true })
  writeFileSync(join(flows, 'race.yml'), readFileSync(join(root, '.harnessdesk/flows/race.yml')))
  const source = readFileSync(join(root, 'packages/server/flows/comparison.yml'), 'utf8')
    .replace('name: "Comparison"', 'name: "Race with a judge (rig)"')
    .replace('label: "Task"', 'label: "What both should attempt"')
    .replace('run: "pnpm verify"', 'run: "node --check game.js"')
    .replace('independentOf: [competitor]', 'independentOf: []')
    .replace('seed: { role: competitor, title: "{{task}}" }', 'seed: { role: competitor, title: "{{task}}", detail: RIG_RACE_WRITE }')
    .replace('then: { role: judge, title: "Pick the best attempt" }', 'then: { role: judge, title: "Pick the best attempt", detail: RIG_RACE_JUDGE }')
  writeFileSync(join(flows, 'race-rig.yml'), source)
  execFileSync('git', ['add', '.harnessdesk/flows'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'rig: stage the race camera fixtures'], { cwd: repo, stdio: 'pipe' })
  writeFileSync(join(home, 'seating.json'), JSON.stringify({ implementer: ['codex'], judge: ['codex'] }))
  const state = join(home, 'scripted.json')
  writeFileSync(state, JSON.stringify({ passes: {}, done: [] }))
  // Copy the existing fake into this disposable home. The product fixture stays intact.
  const fixture = join(root, 'packages/adapter-codex/test/fixtures')
  const fake = join(home, 'fake-codex.mjs')
  writeFileSync(fake, readFileSync(join(fixture, 'fake-codex.mjs'), 'utf8')
    .replace("new URL('./plugin-icon.svg', import.meta.url)", `new URL(${JSON.stringify(new URL('plugin-icon.svg', 'file://' + fixture + '/').href)})`), { mode: 0o755 })
  writeFileSync(join(home, 'scripted-flow.mjs'), readFileSync(join(fixture, 'scripted-flow.mjs'), 'utf8')
    // Closing a two-card round can await seating the next role before answering.
    .replace('}, 10000)', '}, 60000)')
    .replace("files: step.kind === 'write' ? [step.file] : []", 'files: []')
    .replace("if (script.delayMs) await delay(script.delayMs, undefined, { signal: controller.signal })", `const progress = { id: 'rig-progress-' + intent, type: 'agentMessage', text: step.kind === 'write' ? 'Building a small click game in this isolated checkout. The score increases when the player presses the button; I will check the script before handing it over.' : 'Comparing both committed games and their checks. I will keep the first passing attempt.' };\n              notify('item/started', { threadId, turnId, item: progress });\n              notify('item/completed', { threadId, turnId, item: progress });\n              while (!existsSync(script.state + '.' + marker + '.go')) await delay(100, undefined, { signal: controller.signal })`)
    .replace("writeFileSync(path, `Retryable statuses: ${pass === 0 ? '503, 504' : '502, 503, 504'}\\n`)", `writeFileSync(path, '// Attempt ' + intent + '\\nexport function nextScore(score) { return score + 1 }\\n'); writeFileSync(join(cwd, 'game.html'), ${JSON.stringify(gameHtml)}.replaceAll('__ATTEMPT__', String(intent)))`)
    .replace("      } catch (cause)", `        if (!card) { const item = { id: 'rig-ready-' + turnId, type: 'agentMessage', text: 'Ready. I will follow the card assigned to this seat.' }; notify('item/started', { threadId, turnId, item }); notify('item/completed', { threadId, turnId, item }); }\n      } catch (cause)`)
    .replace("note: `Scripted ${outcome}.`", "note: step.kind === 'review' ? 'The first attempt passes its check and implements the click game.' : 'The click game is committed and its script is valid.'")
    .replace("context: outcome === 'request-changes' ? 'Add 502 to the committed retry status list.' : 'The committed retry status list is ready for the next step.'", "context: 'game.js exports nextScore; the game increments the score on each click.'"))
  const logger = new Logger('race-walk', { level: 'error', console: false })
  extensions = new ExtensionKernel()
  host = new Host({ logger, state: new StateStore(join(home, 'state.json')), extensions, catalogRefreshMs: 0, libraryHome: join(home, 'person'),
    evidence: { gh: async () => ({ stdout: '', stderr: 'This rig has no forge.', exitCode: 1 }) } })
  setTeamEngine(host.teamPlane)
  const codex = new CodexRuntime({ binaryPath: fake, codexHome: join(home, 'codex-home'), capabilities: new GatedRegistry(extensions, () => host.ceilingGate),
    env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0', FAKE_CODEX_FLOW: JSON.stringify({ state, steps: {
      RIG_RACE_WRITE: { kind: 'write', outcomes: ['committed'], file: 'game.js' },
      RIG_RACE_JUDGE: { kind: 'review', outcomes: ['picked'] },
    } }) } })
  host.register(codex)
  codex.subscribe(event => { if (event.type === 'turn/completed' && event.turn?.error) { errors.push(event.turn.error); console.error(JSON.stringify(event.turn.error)) } })
  await extensions.load(teamPlugin)
  await host.start()
  await codex.start()
  await host.call('workspace/open', { path: repo })
  server = await serve({ host, logger, port: 0, uiRoot: join(root, 'packages/ui/dist') })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  page.setDefaultTimeout(60000)
  await page.goto(`${server.url}/?token=${server.token}`)
  await page.waitForFunction(() => window.__hdStore?.getSnapshot().status === 'open')
  await page.evaluate(() => window.__hdStore.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }))
  const camera = await page.context().newCDPSession(page)
  const capture = async (name, action, themes = ['light']) => {
    for (const theme of themes) {
      await page.evaluate(value => window.__hdStore.setTheme(value), theme)
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      await page.evaluate(TILDIFY(join(scratch, 'person')))
      await page.evaluate(TILDIFY(scratch))
      await page.evaluate(TILDIFY(realpathSync(scratch)))
      const gameOnCamera = name === '14-browser-game' || name === '15-judge-picked'
      if (gameOnCamera) {
        const document = page.frames().find(frame => frame.url().startsWith(server.url + '/camera-game/'))
        // Reload only the synthetic game after a theme change, then replay its click.
        await document.goto(document.url())
        const guest = page.frameLocator('iframe')
        await guest.getByRole('heading', { name: 'One click. One point.' }).waitFor()
        if (await guest.locator('#score').innerText() === '0') await guest.getByRole('button', { name: 'Add a point' }).click()
        await guest.locator('#score').filter({ hasText: '1' }).waitFor()
        await guest.locator('body').evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        await guest.getByRole('heading', { name: 'One click. One point.' }).screenshot()
      }
      const seen = await page.evaluate(COLLECT)
      const problems = [...textReasons(seen, { user: USER }), ...accountReasons(await page.evaluate(() => window.__hdStore.getSnapshot().accountsByRuntime), { vouched: new Set(['dev@example.com']) })]
      for (const guest of page.frames().filter(frame => frame !== page.mainFrame())) {
        if (!guest.url().startsWith(server.url + '/camera-game/')) throw new Error('An unstaged guest is on camera')
        problems.push(...textReasons(await guest.evaluate(COLLECT), { user: USER }))
      }
      if (problems.length) throw new Error(problems.join('\n'))
      const filename = name + (theme === 'dark' ? '-dark' : '') + '.png'
      let png = await page.screenshot()
      if (gameOnCamera) {
        const region = await page.locator('iframe').boundingBox()
        const gamePainted = async bytes => page.evaluate(async ({ data, region }) => {
          const photo = new Image()
          photo.src = 'data:image/png;base64,' + data
          await photo.decode()
          const canvas = document.createElement('canvas')
          canvas.width = photo.naturalWidth; canvas.height = photo.naturalHeight
          const pixels = canvas.getContext('2d')
          pixels.drawImage(photo, 0, 0)
          const { data: ink } = pixels.getImageData(Math.floor(region.x), Math.floor(region.y), Math.floor(region.width), Math.floor(region.height))
          let green = 0
          for (let offset = 0; offset < ink.length; offset += 4) {
            if (Math.abs(ink[offset] - 32) < 5 && Math.abs(ink[offset + 1] - 92) < 5 && Math.abs(ink[offset + 2] - 80) < 5) green++
          }
          return green > 1000
        }, { data: bytes.toString('base64'), region })
        if (!await gamePainted(png)) {
          const photo = await camera.send('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false })
          png = Buffer.from(photo.data, 'base64')
        }
        if (!await gamePainted(png)) throw new Error('The game button did not paint in ' + filename)
      }
      if (png.readUInt32BE(16) !== 1440 || png.readUInt32BE(20) !== 900) throw new Error('The camera changed viewport size')
      writeFileSync(join(out, filename), png)
      frames.push({ filename, action, source: 'rig', theme })
      writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 2) + '\n')
      console.log('Captured ' + filename)
    }
    await page.evaluate(() => window.__hdStore.setTheme('light'))
  }
  const release = marker => writeFileSync(state + '.' + marker + '.go', '')
  const both = ['light', 'dark']
  await page.waitForLoadState('networkidle')
  await capture('01-entry-sidebar', 'Open the synthetic Storefront project; the sidebar, New session and composer are the starting surface.')
  await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
  await capture('02-start-menu', 'Click More ways to start; the menu offers Goal…, Flow… and Team….')
  await page.getByRole('menuitem', { name: 'Flow…', exact: true }).click()
  await capture('03-flow-dialog', 'Click Flow…; What are you starting? opens with Flow selected and a Continue button.')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('combobox', { name: 'Flow', exact: true }).waitFor()
  await capture('04-run-flow-dialog', 'Click Continue; Run a flow asks for the finish condition while its Flow catalogue loads.')
  await page.getByRole('combobox', { name: 'Flow', exact: true }).selectOption('race')
  await page.getByText('This flow uses the old format', { exact: true }).waitFor()
  await capture('05-race-old-format', 'Choose Race with a judge from the supplied race.yml; the renderer refuses the old format and directs the person to update it.')
  await page.getByRole('combobox', { name: 'Flow', exact: true }).selectOption('race-rig')
  await page.getByLabel('What both should attempt', { exact: true }).waitFor()
  await capture('06-race-choose', 'Choose Race with a judge (rig), the supported Comparison flow adapted for scripted seats and a small game check.')
  await page.getByLabel('What finishes this?', { exact: true }).fill('Build and judge a small click game')
  await page.getByLabel('What both should attempt', { exact: true }).fill('Build a small click game in game.html; a button increases the score by one. Keep its script in game.js.')
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Start')?.disabled)
  await page.getByLabel('What both should attempt', { exact: true }).press('Home')
  await capture('07-race-task', 'Fill the finish condition and What both should attempt with the click game brief.')
  await page.getByText('Judge — judge', { exact: true }).scrollIntoViewIfNeeded()
  await capture('08-start-seats', 'Scroll through the preview: two isolated competitors hold Edit and Judge holds Read only.')
  await page.getByText('Its rounds', { exact: true }).scrollIntoViewIfNeeded()
  await capture('09-start-checks', 'Read the game syntax check and routing through judge to a person; Start is in the footer.')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 60000 })
  await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor()
  await capture('10-team-open', 'Click Start; the Team opens on Overview while both competitors begin.', both)
  await page.getByRole('button', { name: 'Side by side', exact: true }).click()
  await page.locator('[data-shared-composer]').waitFor()
  await capture('11-both-starting', 'Click Side by side; both competitor conversations share the Team composer.', both)
  await page.waitForFunction(() => [...window.__hdStore.getSnapshot().sessions.values()].filter(session => session.turns.some(turn => turn.items.some(item => item.text?.startsWith('Building a small click game')))).length === 2)
  await capture('12-both-working', 'Both scripted competitor turns remain working, with progress in Conversation and one shared composer.', both)
  await page.getByRole('radio', { name: 'Browser', exact: true }).first().click()
  await page.getByText('Nothing open yet', { exact: true }).waitFor()
  await capture('13-browser-empty', 'Click Browser in the first tile; no page has been opened by the scripted seat.', both)
  release('RIG_RACE_WRITE')
  await page.waitForFunction(() => [...window.__hdStore.getSnapshot().flowExecutions.values()].some(run => run.rounds.some(round => round.role === 'judge' && round.state === 'running')), {}, { timeout: 60000 })
  const lanes = await page.evaluate(() => window.__hdStore.getSnapshot().lanes)
  await page.route('**/camera-game/**', route => {
    const url = new URL(route.request().url())
    const index = Number(/attempt-(\d+)/.exec(url.pathname)?.[1]) - 1
    const file = url.pathname.endsWith('game.js') ? 'game.js' : 'game.html'
    return route.fulfill({ status: 200, contentType: file === 'game.js' ? 'text/javascript' : 'text/html', body: readFileSync(join(lanes[index].cwd, file), 'utf8') })
  })
  await page.evaluate(url => {
    const own = window.__hdStore
    own.openBrowser(url, { profile: own.getSnapshot().lanes[0].browserProfile })
  }, server.url + '/camera-game/attempt-1/')
  await page.frameLocator('iframe').getByRole('button', { name: 'Add a point' }).click()
  await page.frameLocator('iframe').locator('#score').filter({ hasText: '1' }).waitFor()
  await capture('14-browser-game', 'Show the first committed game in its lane Browser and click Add a point; camera-seeded navigation, with the game read from the actual fake competitor checkout.', both)
  await page.waitForFunction(() => [...window.__hdStore.getSnapshot().sessions.values()].some(session => session.turns.some(turn => turn.items.some(item => item.text?.startsWith('Comparing both committed games')))), {}, { timeout: 60000 })
  release('RIG_RACE_JUDGE')
  try {
    await page.getByRole('button', { name: 'Merge the picked change', exact: true }).waitFor({ timeout: 60000 })
  } catch (error) {
    const state = await page.evaluate(() => { const snap = window.__hdStore.getSnapshot(); return { runs: [...snap.flowExecutions.values()], cards: [...snap.teams.values()].map(team => team.intents), turns: [...snap.sessions.values()].map(session => session.turns) } })
    writeFileSync(join(out, 'capture-failure.json'), JSON.stringify({ errors, state }, null, 2))
    throw error
  }
  await page.getByText('Not kept', { exact: true }).waitFor()
  await capture('15-judge-picked', 'The scripted judge records a passing candidate; Picked / Not kept, the verdict notice and Merge the picked change appear.', both)
  await page.getByRole('button', { name: 'Merge the picked change', exact: true }).click()
  await page.getByRole('button', { name: 'Merged', exact: true }).waitFor()
  await capture('16-person-decision', 'Click Merge the picked change; Run opens Steps with the selected revision and a Merged acknowledgement. This does not perform Git integration.')
  await page.getByRole('button', { name: 'Merged', exact: true }).click()
  await page.waitForFunction(() => [...window.__hdStore.getSnapshot().flowExecutions.values()].some(run => run.state === 'settled'), {}, { timeout: 60000 })
  await capture('17-after-answer', 'Click Merged in the disposable rig to simulate the person’s acknowledgement; the Run settles. No Git merge is executed.')
  await page.getByRole('button', { name: 'Close Run details', exact: true }).click()
  await page.getByRole('button', { name: 'Hide the right panel', exact: true }).click()
  await page.getByRole('button', { name: 'End', exact: true }).scrollIntoViewIfNeeded()
  await capture('18-run-settled', 'Close the Steps panel and scroll to End: the Run is Settled, the Team remains under Storefront in the sidebar, and Wrap is offered.')
  await page.getByRole('button', { name: 'Wrap', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await capture('19-wrap-preview', 'Click Wrap; the dialog asks what finished and how each card should be retained.')
  await page.getByLabel('What finished', { exact: true }).fill('Both isolated click games passed their script checks; the judge picked Attempt A and the person acknowledged the result.')
  const choices = page.getByRole('dialog').getByRole('combobox')
  for (let index = 0; index < await choices.count(); index++) await choices.nth(index).selectOption(index === 1 ? 'dropped' : 'finished')
  await page.getByRole('dialog').getByRole('textbox', { name: /Reason for dropping/ }).fill('The judge kept Attempt A.')
  await capture('20-wrap-choices', 'Summarize the result; mark the picked attempt Finished and the other Dropped with a reason, and finish the remaining cards.')
  await page.getByRole('button', { name: 'Review receipt', exact: true }).click()
  await page.getByRole('button', { name: 'Wrap Goal', exact: true }).waitFor()
  await capture('21-wrap-receipt-preview', 'Click Review receipt; review the retained work and answers before Wrap Goal.')
  await page.getByRole('button', { name: 'Wrap Goal', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: 'Receipt', exact: true }).click()
  await page.getByText('Both isolated click games passed their script checks; the judge picked Attempt A and the person acknowledged the result.', { exact: true }).waitFor()
  await capture('22-wrapped-receipt', 'Confirm Wrap Goal and open Receipt; the Team is now a read-only record and its sidebar row has disappeared.')
  await page.getByRole('button', { name: 'Teams', exact: true }).click()
  await page.getByText('No active Teams', { exact: true }).waitFor()
  await capture('23-teams-active', 'Click Teams; Active contains no Team now that this one is wrapped, and Settled has one record.')
  await page.getByRole('button', { name: 'Settled', exact: true }).click()
  await page.getByRole('button', { name: 'Open Build and judge a small click game', exact: true }).waitFor()
  await capture('24-teams-settled', 'Click Settled; the wrapped Team remains here after leaving the project sidebar.')
  await page.getByRole('button', { name: 'Open Build and judge a small click game', exact: true }).click()
  await page.getByRole('tab', { name: 'Receipt', exact: true }).waitFor()
  await capture('25-reopen-receipt', 'Open the settled Team again; its Receipt and retained conversations are still available.')
  const runs = await page.evaluate(() => [...window.__hdStore.getSnapshot().flowExecutions.values()].map(run => ({ state: run.state, rounds: run.rounds.map(round => ({ role: round.role, state: round.state })) })))
  if (runs.length !== 1 || runs[0].state !== 'settled' || runs[0].rounds.length !== 4) throw new Error('The walkthrough did not settle its four-round Run')
  const commits = lanes.map(lane => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: lane.cwd, encoding: 'utf8' }).trim())
  if (new Set(commits).size !== 2) throw new Error('The two fake competitors must produce distinct revisions')
  const version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const notes = `# Race walkthrough\n\nCaptured from renderer source ${version} at 1440×900, device scale 1. Every numbered PNG is a full viewport of the shipping browser renderer against an isolated native fake-seat rig. No preview-harness frames were needed. Light is captured at every step; dark covers brief steps 4–7 (opening, conversations, Browser and verdict: frames 10–15).\n\n## Sources and limits\n\n- Frame 05 uses the supplied .harnessdesk/flows/race.yml verbatim. It is legacy and cannot start a Goal in this renderer. The remaining run uses the shipping version-2 Comparison flow, renamed Race with a judge (rig), with the task label from the brief.\n- Rig-only changes: all three Seats use the native fake peer; judge independence is relaxed to permit that same synthetic account; the check is node --check game.js; scripted markers hold milestones for the camera. The two competitors commit distinct game.js and game.html files in their own isolated checkouts. The judge records the first candidate through the real review tool. This is synthetic UI evidence, not a measurement of model quality.\n- Browser navigation is camera-seeded through the renderer store. The page is served only from a fake competitor’s committed files using a same-origin route, and clicking it changes score 0 to 1. Browser content is an iframe in this headless browser build; native Electron browser-tool navigation was not exercised. Host and guest text, attributes and fake accounts are audited before every PNG.\n- Merged is a simulated acknowledgement on the disposable person card. No Git merge, forge operation, real account or live model call runs. The window asks the person to merge the exact picked revision separately.\n- After the acknowledgement the Run is Settled and the Team stays under Storefront until Wrap. After Wrap, its project-sidebar row disappears; Teams → Settled is the way back to its Receipt. Spend is unrecorded in this rig.\n- Added rig code: script/shots/race-walk.mjs on capture/race-walk. Artifacts and this document remain local under .lead-out/race-walk; no PR.\n\n## Frames\n\n${frames.map(frame => `- [${frame.filename}](${frame.filename}) — ${frame.action} Source: ${frame.source}; ${frame.theme}.`).join('\n')}\n\n## Verification\n\nThe capture asserts two distinct committed attempts, both syntax checks passing before a judge can be seated, score 1 in the game Browser, a recorded pick with its person step, a settled four-round Run, and reopening its wrapped Receipt. Privacy audits passed for all ${frames.length} frames.\n`
  writeFileSync(join(out, 'steps.md'), notes)
  writeFileSync(join(out, 'verification.json'), JSON.stringify({ source: version, viewport: { width: 1440, height: 900 }, frames: frames.length, commits, runs, privacy: 'passed', gameScore: 1 }, null, 2) + '\n')
  const sheet = await browser.newPage({ viewport: { width: 1488, height: 900 }, deviceScaleFactor: 1 })
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  await sheet.setContent(`<style>body{margin:0;padding:16px;background:#eee;font:14px system-ui}h1{margin:0 0 16px;font-size:24px}.grid{display:grid;grid-template-columns:repeat(3,480px);gap:8px}figure{margin:0;background:white}img{display:block;width:480px;height:300px}figcaption{padding:8px;font-size:13px}</style><h1>Race walkthrough · rig · 1440×900 · light and dark</h1><div class="grid">${frames.map(frame => `<figure><img src="data:image/png;base64,${readFileSync(join(out, frame.filename)).toString('base64')}"><figcaption>${escape(frame.filename)} · ${frame.source}</figcaption></figure>`).join('')}</div>`)
  await sheet.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
  await sheet.screenshot({ path: join(out, 'sheet.png'), fullPage: true })
  await sheet.close()
  console.log(`PASS: ${frames.length} audited frames, distinct attempts, game score 1, four settled rounds, Receipt reopened; steps.md and sheet.png written.`)
  if (errors.length) throw new Error(JSON.stringify(errors))
} catch (error) {
  if (page) {
    const details = await page.evaluate(() => {
      const snap = window.__hdStore?.getSnapshot()
      return { text: document.body.innerText, runs: [...(snap?.flowExecutions.values() ?? [])], cards: [...(snap?.teams.values() ?? [])].map(team => team.intents), turns: [...(snap?.sessions.values() ?? [])].map(session => session.turns) }
    }).catch(() => null)
    writeFileSync(join(out, 'capture-failure.json'), JSON.stringify({ error: error.message, errors, details }, null, 2))
    console.error('Capture failure details saved to capture-failure.json')
  }
  throw error
} finally {
  await browser?.close()
  await server?.close()
  await host?.dispose()
  await extensions?.dispose()
  setTeamEngine(null)
  rmSync(scratch, { recursive: true, force: true })
}
