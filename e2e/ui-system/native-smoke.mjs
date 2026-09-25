#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Cdp, closeDesk, launchDesk, sleep, STORE, waitForSnapshot } from '../../script/lib/desk.mjs'
import { removeTemporaryDirectory } from '../../script/lib/temporary-directory.mjs'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, 'output/native-ui-system')
const rig = mkdtempSync(join(tmpdir(), 'harnessdesk-ui-system-'))
const marker = join(rig, '.harnessdesk-ui-system-rig')
const rigHome = join(rig, 'home')
const rigWork = join(rig, 'work')
const frames = join(output, 'frames')
const args = process.argv.slice(2)
const explicitScenes = args.includes('--scene')
const shootArgs = explicitScenes
  ? args
  : [
      ...args,
      '--scene', 'desk',
      '--scene', 'sidebar-menu',
      '--scene', 'sidebar-accounts',
      '--scene', 'workspace-hover',
      '--scene', 'session-hover',
      '--scene', 'dashboard',
      '--scene', 'settings',
      '--scene', 'settings-agents',
      '--scene', 'settings-library',
      '--scene', 'settings-skills',
      '--scene', 'settings-permissions',
      '--scene', 'conversation',
      '--scene', 'git',
      '--scene', 'editor',
      '--scene', 'terminal',
      '--scene', 'board',
      '--scene', 'room',
      '--scene', 'front-door',
      '--scene', 'browser',
    ]
const chosenTheme = (() => {
  const at = shootArgs.indexOf('--theme')
  return at >= 0 ? shootArgs[at + 1] : 'dark'
})()
const environment = {
  ...process.env,
  HD_SHOTS_HOME: rigHome,
  HD_SHOTS_WORK: rigWork,
  HARNESSDESK_LOG_LEVEL: 'error',
  HARNESSDESK_NO_UPDATE_CHECK: '1',
  HARNESSDESK_CODEX_BINARY: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
  HARNESSDESK_TEST_ABOUT: '1',
  HD_SHOTS_NATIVE_CODEX: '1',
  CODEX_HOME: join(rig, 'codex-home'),
}

writeFileSync(marker, 'HarnessDesk isolated native UI-system rig\n')

const run = (script, scriptArgs) =>
  execFileSync(process.execPath, [join(root, script), ...scriptArgs], {
    cwd: root,
    // About is tested on the explicit relaunch below. Opening it during the
    // scene sweep backgrounds the main window and pauses its resize/placement
    // animation frames, leaving dynamically expanded menus at stale positions.
    env: { ...environment, HARNESSDESK_TEST_ABOUT: '0' },
    stdio: 'inherit',
  })

try {
  rmSync(output, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })

  run('script/shots/seed.mjs', ['--clean'])
  run('script/shots/shoot.mjs', [...shootArgs, '--assert-layout', '--out', frames])

  // Exercise a non-default combination on relaunch. This is written through
  // the same persisted state the host reads, inside the disposable rig only.
  const stateFile = join(rigHome, 'state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.preferences = {
    ...state.preferences,
    theme: chosenTheme,
    palette: 'editorial',
    accent: 'violet',
    corners: 'round',
    look: 'studio',
  }
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)

// The screenshot pass closes the app. Relaunch the same isolated home and
// profile to prove that the last applied appearance travelled through the host
// preference store, rather than a catalog-only or renderer-local cache.
  const desk = await launchDesk({
  app: root,
  executable: process.env['HD_SHOTS_EXECUTABLE'],
  home: rigHome,
  userDataDir: join(rigHome, 'electron'),
  logPath: join(output, 'relaunch.log'),
  env: environment,
})

  let relaunch
  let about
  try {
  // `launchDesk` returns as soon as the renderer store exists. Preferences are
  // loaded immediately afterwards, so wait for hydration instead of sampling
  // the store's construction-time `system` default.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const theme = await desk.cdp.eval(`${STORE}.getSnapshot().theme`)
    if (theme === chosenTheme) break
    await sleep(250)
  }
  const readRelaunch = () => desk.cdp.json(`(() => ({
    theme: ${STORE}.getSnapshot().theme,
    dark: document.body.hasAttribute('data-hd-dark-theme'),
    dragRegions: [...document.querySelectorAll('.hd-drag')].length,
    noDragControls: [...document.querySelectorAll('.hd-no-drag button, .hd-no-drag input, .hd-no-drag select')].length,
    searchNamed: Boolean(document.querySelector('[aria-label="Search everything"]')),
    title: document.title,
    background: getComputedStyle(document.body).backgroundColor,
    foreground: getComputedStyle(document.body).color,
    radius: getComputedStyle(document.body).getPropertyValue('--hd-radius-lg').trim(),
    palette: document.body.dataset.hdPalette ?? '',
    accent: document.body.dataset.hdAccent ?? '',
    corners: document.body.dataset.hdCorners ?? '',
    interface: document.body.dataset.hdInterface ?? '',
  }))()`)
  relaunch = await readRelaunch()
  assert.equal(relaunch.theme, chosenTheme, 'appearance did not persist through a real app relaunch')
  assert.equal(relaunch.dark, chosenTheme === 'dark', 'the persisted theme was not applied to the native renderer root')
  assert.ok(relaunch.dragRegions > 0, 'the native window has no draggable chrome')
  assert.ok(relaunch.noDragControls > 0, 'controls inside native chrome are not marked clickable')
  assert.equal(relaunch.searchNamed, true, 'the native sidebar search lost its accessible name')
  assert.match(relaunch.title, /HarnessDesk/)
  assert.deepEqual(
    [relaunch.palette, relaunch.accent, relaunch.corners, relaunch.interface],
    ['editorial', 'violet', 'round', 'studio'],
    'appearance axes did not persist through the native renderer',
  )

  let aboutTarget
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${desk.port}/json/list`)).json()
    aboutTarget = targets.find((target) => target.type === 'page' && target.title === 'About HarnessDesk')
    if (aboutTarget?.webSocketDebuggerUrl) break
    await sleep(100)
  }
  assert.ok(aboutTarget?.webSocketDebuggerUrl, 'the native About auxiliary window did not open')
  const aboutCdp = await Cdp.open(aboutTarget.webSocketDebuggerUrl)
  try {
    about = await aboutCdp.json(`(() => ({
      title: document.title,
      heading: document.querySelector('h1')?.textContent ?? '',
      foundationLoaded: [...document.styleSheets].some((sheet) => sheet.href?.endsWith('/about-foundation.css')),
      background: getComputedStyle(document.body).backgroundColor,
      foreground: getComputedStyle(document.body).color,
      radius: getComputedStyle(document.querySelector('.tile')).borderRadius,
      palette: document.documentElement.dataset.hdPalette ?? '',
      accent: document.documentElement.dataset.hdAccent ?? '',
      corners: document.documentElement.dataset.hdCorners ?? '',
      interface: document.documentElement.dataset.hdInterface ?? '',
    }))()`)
    assert.equal(about.title, 'About HarnessDesk')
    assert.equal(about.heading, 'HarnessDesk')
    assert.equal(about.foundationLoaded, true, 'the About window did not load generated foundation output')
    // Store hydration and the rendered CSS cascade are distinct readiness
    // points. On CI the first renderer sample still had the initial white
    // ground although its saved theme/attributes were already dark. Re-read
    // the rendered facts; a persistent mismatch still fails at the deadline.
    relaunch = await waitForSnapshot(readRelaunch, current =>
      current.theme === chosenTheme
      && current.dark === (chosenTheme === 'dark')
      && current.background === about.background
      && current.foreground === about.foreground
      && current.radius === about.radius
      && current.palette === about.palette
      && current.accent === about.accent
      && current.corners === about.corners
      && current.interface === about.interface,
    )
    assert.equal(about.background, relaunch.background, 'the About window forked the app background token')
    assert.equal(about.foreground, relaunch.foreground, 'the About window forked the app foreground token')
    assert.equal(about.radius, relaunch.radius, 'the About window forked the app corner preference')
    assert.deepEqual(
      [about.palette, about.accent, about.corners, about.interface],
      [relaunch.palette, relaunch.accent, relaunch.corners, relaunch.interface],
      'the About window did not receive every appearance preference',
    )

    const reasons = textReasons(await aboutCdp.json(COLLECT), { user: USER })
    assert.deepEqual(reasons, [], `the About window is not publishable: ${reasons.join('; ')}`)
    const capture = await aboutCdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    writeFileSync(join(output, `about-${chosenTheme}.png`), Buffer.from(capture.data, 'base64'))
  } finally {
    aboutCdp.close()
  }
  } finally {
    await closeDesk(desk)
  }

const screenshots = readdirSync(frames).filter((file) => file.endsWith('.png')).sort()
assert.ok(screenshots.length > 0, 'the native run produced no screenshots')
const report = {
  command: `node e2e/ui-system/native-smoke.mjs ${args.join(' ')}`.trim(),
  platform: process.platform,
  arch: process.arch,
  isolatedHome: 'temporary isolated profile',
  isolatedWork: 'temporary synthetic repositories',
  screenshots: [
    ...screenshots.map((file) => `output/native-ui-system/frames/${file}`),
    `output/native-ui-system/about-${chosenTheme}.png`,
  ],
  relaunch,
  about,
}
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`native UI system smoke: ${screenshots.length} app frames plus About, relaunch persistence verified\n`)
} finally {
  // Refuse to remove anything unless it is the exact directory created above
  // and still carries this run's marker.
  if (existsSync(marker)) {
    // Electron's helper processes can finish a final cache write just after
    // the main process exits. Node retries the exact marked directory for the
    // transient ENOTEMPTY/EBUSY window instead of turning a successful visual
    // run red or, worse, broadening the cleanup target.
    removeTemporaryDirectory(rig)
  }
}
