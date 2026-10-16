import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const script = dirname(fileURLToPath(import.meta.url))
const gif = readFileSync(resolve(script, 'shots/gif2.mjs'), 'utf8')

test('hero lets each named seat reply through an idle-checked room delivery', () => {
  const start = gif.indexOf("if (SCENARIO === 'hero') {\n    // HarnessDesk never shows")
  const hero = gif.slice(start, gif.indexOf("} else if (SCENARIO === 'flow') {", start))

  assert.match(gif, /seatGoal\(\{ goal: .*agent: 'room-claude-code' \}\)/)
  assert.match(gif, /seatGoal\(\{ goal: .*agent: 'room-codex' \}\)/)
  assert.match(hero, /startIdleSeatTurn\(claudeKey, 'Make the 502 retry fix/)
  assert.match(hero, /startRoomDelivery\(claudeKey, 'Your call on the nit\.'/)
  assert.match(hero, /await followRoomChat\(\)/)
  assert.match(hero, /await click\('Chat'\)/)
  assert.match(gif, /agent\.env\.SHOT_TURN = '8,8,5'/)
  assert.match(gif, /SHOT_ROOM_MESSAGE/)
  assert.match(readFileSync(resolve(script, 'shots/agent.mjs'), 'utf8'), /turn\.say \?\? \[\]/)
})

test('flow records its board changes through the seated agents, not person verbs', () => {
  const start = gif.indexOf("  } else if (SCENARIO === 'flow') {\n    // Beat 1")
  const flow = gif.slice(start)
  const agent = readFileSync(resolve(script, 'shots/agent.mjs'), 'utf8')

  assert.match(gif, /SHOT_FLOW/)
  assert.doesNotMatch(flow, /\.teamIntent\(/)
  assert.match(flow, /crop=960:600/)
  assert.match(agent, /claim_next/)
  assert.match(agent, /complete_claim/)
})

test('front-door records the shipped Independent review dry run without starting it', () => {
  const start = gif.indexOf("  } else if (SCENARIO === 'front-door') {")
  const frontDoor = gif.slice(start, gif.indexOf("  } else if (SCENARIO === 'flow') {", start))

  assert.match(frontDoor, /click\('Independent review', catalogue\)/)
  assert.match(frontDoor, /fill\('What should they do\?', 'Add 502 to the retryable status set'\)/)
  assert.match(frontDoor, /fill\('Done when · optional', 'Ship it once every specialist approves'\)/)
  assert.match(frontDoor, /click\('Details', dryRun\)/)
  assert.match(frontDoor, /click\('Dry run', dryRun\)/)
  assert.match(frontDoor, /aria-label="New Team"/)
  assert.match(frontDoor, /aria-label="Dry run"/)
  assert.match(frontDoor, /scrollIntoView/)
  assert.match(frontDoor, /button\.disabled/)
  assert.doesNotMatch(frontDoor, /click\('Start Team'/)
  assert.doesNotMatch(gif, /click\('Continue'|aria-label="Start a team"|aria-label="Start Independent review"|aria-label="Start Fix and review"/)
  assert.match(gif, /deviceScaleFactor: DEVICE_SCALE/)
  assert.match(gif, /scale=960:600:flags=lanczos/)
})

test('GIF dry-run beats wait for the fresh start token before holding or starting', () => {
  for (const [scenario, hold] of [['front-door', '2600'], ['flow', '3000']]) {
    const start = gif.indexOf(`  } else if (SCENARIO === '${scenario}') {`)
    const scene = gif.slice(start, gif.indexOf(`    await sleep(${hold})`, start))
    const afterDryRun = scene.slice(scene.indexOf("click('Dry run'"))
    assert.match(afterDryRun, /\.find\(\(one\) => one\.textContent\?\.trim\(\) === 'Start Team'\)/, `${scenario} checks the current Start Team after Dry run`)
    assert.match(afterDryRun, /return Boolean\(button\) && !button\.disabled/, `${scenario} waits until the new preview can start`)
  }
})

test('the GIF tile crop includes the persistent Team dialog at its actual width', async () => {
  const start = gif.indexOf('    frontDoorCrop = await cdp.json(')
  const source = gif.slice(start, gif.indexOf('\n    if (!frontDoorCrop)', start))
  for (const { rect, viewport } of [
    { rect: { left: 210, top: 152, width: 860, height: 496 }, viewport: { width: 1280, height: 800 } },
    { rect: { left: 210, top: 100, width: 860, height: 600 }, viewport: { width: 1280, height: 800 } },
    { rect: { left: 0, top: 40, width: 1280, height: 720 }, viewport: { width: 1280, height: 800 } },
    { rect: { left: 290, top: 202, width: 860, height: 496 }, viewport: { width: 1440, height: 900 } },
    { rect: { left: 210, top: 202, width: 860, height: 496 }, viewport: { width: 1280, height: 900 } },
  ]) {
    const dialog = { getBoundingClientRect: () => rect }
    const sidebar = { getBoundingClientRect: () => ({ right: 240 }) }
    const dom = { document: { querySelector: selector => selector === '[data-left-column]' ? sidebar : selector.includes('Workspace actions') ? null : dialog }, innerWidth: viewport.width, innerHeight: viewport.height, Math }
    const crop = await runInNewContext(`(async () => { ${source}; return frontDoorCrop })()`, {
      frontDoorCrop: null, dryRun: '[role="dialog"][aria-label="New Team"]', q: JSON.stringify, DEVICE_SCALE: 2,
      cdp: { json: expression => runInNewContext(expression, dom) },
    })
    assert.ok(crop.left / 2 <= rect.left, 'the title and seat label starts stay inside the tile')
    assert.ok((crop.left + crop.width) / 2 >= rect.left + rect.width, 'the right side of the dialog stays inside the tile')
    assert.ok(crop.top / 2 <= rect.top)
    assert.ok((crop.top + crop.height) / 2 >= rect.top + rect.height)
    const wholeViewport = crop.width === viewport.width * 2 && crop.height === viewport.height * 2
    assert.ok(Math.abs(crop.width / crop.height - (wholeViewport ? viewport.width / viewport.height : 960 / 600)) < 0.002, 'the crop preserves its source aspect ratio')
    assert.ok(crop.left === 0 || crop.left / 2 >= 240, 'the tile preserves the full sidebar when a close crop would clip it')
  }
})

test('a non-16:10 front-door viewport fits the GIF tile with centered padding', () => {
  const start = gif.indexOf('  const outputFilter =')
  const source = gif.slice(start, gif.indexOf("\n  await run('ffmpeg'", start))
  const filter = runInNewContext(`${source}\noutputFilter`, {
    SCENARIO: 'front-door', FPS: 13, frontDoorCrop: { width: 2560, height: 1800, left: 0, top: 0 },
    WIDTH: 1280, backdrop: '0xe9e9e7', padFilter: '',
  })
  assert.match(filter, /crop=2560:1800:0:0/)
  assert.match(filter, /scale=960:600:flags=lanczos:force_original_aspect_ratio=decrease/)
  assert.match(filter, /pad=960:600:\(ow-iw\)\/2:\(oh-ih\)\/2:0xe9e9e7/)
  assert.match(filter, /setsar=1/)
})

test('GIF field filling targets the exact label and leaves every field untouched when it is absent', async () => {
  const start = gif.indexOf('  const fill = (label, value) =>')
  const source = gif.slice(start, gif.indexOf('\n\n  // Staged before', start))
  class Input {
    constructor(value) { this.current = value; this.events = [] }
    get value() { return this.current }
    set value(value) { this.current = value }
    dispatchEvent(event) { this.events.push(event.type) }
  }
  class Textarea extends Input {}
  const task = new Textarea('Original task'), done = new Input('Original outcome')
  const controls = new Map([['task', task], ['done', done]])
  const labels = new Map([['What should they do?', 'task'], ['Done when · optional', 'done']])
  const document = {
    querySelectorAll: selector => selector === 'label' ? [...labels].map(([textContent, id]) => ({ textContent, getAttribute: () => id })) : [task, done],
    getElementById: id => controls.get(id),
    querySelector: () => null,
  }
  const dom = { document, HTMLTextAreaElement: Textarea, HTMLInputElement: Input, Event: class { constructor(type) { this.type = type } } }
  const fill = runInNewContext(`${source}\nfill`, { q: JSON.stringify, cdp: { eval: expression => runInNewContext(expression, dom) } })
  assert.equal(await fill('Done when · optional', 'All specialists approve'), true)
  assert.equal(done.value, 'All specialists approve')
  assert.equal(task.value, 'Original task')
  assert.equal(await fill('Missing label', 'Must not replace the task'), false)
  assert.equal(task.value, 'Original task')
  assert.deepEqual(task.events, [])
})
