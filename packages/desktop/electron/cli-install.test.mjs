import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import {
  BUNDLE_ID,
  LAUNCHER_MARKER,
  MENU_LABEL,
  createCommandLineTool,
  createLauncher,
  inspectLauncher,
  installLauncher,
  isOurLauncher,
  launcherText,
  pathAdvice,
  removeLauncher,
  replaceLauncher,
  targetOf,
} from './cli-install.mjs'

/**
 * The "Install command-line tool…" item, away from Electron.
 *
 * Every test runs on a temporary home that the test makes, and the process's
 * own `HOME` is pointed at another temporary folder for the whole file, so a
 * call that reached for `os.homedir()` by mistake would land there and be
 * caught below, never in a real home. Nothing here touches a real `PATH`
 * folder or a shell file, and nothing runs an installed app: the launcher is
 * run against an app this file builds out of a script.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'hd-cli-install-')))
const realHome = process.env['HOME']
const processHome = join(root, 'process-home')
mkdirSync(processHome)
process.env['HOME'] = processHome

after(() => {
  process.env['HOME'] = realHome
  const strayed = readdirSync(processHome)
  rmSync(root, { recursive: true, force: true })
  assert.deepEqual(strayed, [], 'something wrote to the process HOME instead of the temporary home it was given')
})

let counter = 0
const folder = (label) => {
  const path = join(root, `${label}-${++counter}`)
  mkdirSync(path, { recursive: true })
  return path
}
const makeHome = () => folder('home')

/** Everything under a folder, as relative paths with a marker for folders. */
const tree = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      const shown = full.slice(base.length + 1)
      return entry.isDirectory() ? [`${shown}/`, ...tree(full, base)] : [shown]
    })
    .sort()

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`

const ENTRY_SOURCE = [
  'process.stdout.write(JSON.stringify({',
  '  argv: process.argv.slice(2),',
  '  electron: process.env.ELECTRON_RUN_AS_NODE ?? null,',
  '  entry: process.argv[1],',
  "}) + '\\n')",
  'process.exitCode = Number(process.env.FAKE_EXIT ?? 0)',
  '',
].join('\n')

const IN_APP = {
  runtimeIn: 'Contents/MacOS/HarnessDesk',
  entryIn: 'Contents/Resources/app.asar.unpacked/node_modules/@harnessdesk/cli/dist/src/bin.js',
}

/**
 * An app laid out the way the packaged one is, whose "runtime" is a script
 * that hands everything to this test's own Node. That is the same mechanism
 * the launcher relies on: a runtime, a script for it to run, and the rest of
 * the arguments after them.
 */
const fakeApp = (appDir) => {
  const runtime = join(appDir, IN_APP.runtimeIn)
  const entry = join(appDir, IN_APP.entryIn)
  mkdirSync(dirname(runtime), { recursive: true })
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(runtime, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 })
  chmodSync(runtime, 0o755)
  writeFileSync(entry, ENTRY_SOURCE)
  return { runtime, entry, bundle: { id: BUNDLE_ID, path: appDir, ...IN_APP } }
}

const COMMAND = (home, dir = '.local/bin') => join(home, dir, 'harnessdesk')

const target = (overrides = {}) => ({
  runtime: '/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk',
  entry: `/Applications/HarnessDesk.app/${IN_APP.entryIn}`,
  bundle: { id: BUNDLE_ID, path: '/Applications/HarnessDesk.app', ...IN_APP },
  ...overrides,
})

test('the menu item says what the brief says, and the bundle id is the app id', () => {
  assert.equal(MENU_LABEL, 'Install command-line tool…')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(BUNDLE_ID, manifest.build.appId, 'the launcher finds a moved app by the id the build gives it')
})

test('a packaged app is described by where its runtime and the bundled command line sit inside it', () => {
  const described = targetOf({
    execPath: '/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk',
    entry: `/Applications/HarnessDesk.app/${IN_APP.entryIn}`,
    packaged: true,
  })
  assert.deepEqual(described, target())

  // A development build runs out of a checkout: nothing to search for later.
  const development = targetOf({
    execPath: '/work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    entry: '/work/packages/cli/dist/src/bin.js',
    packaged: false,
  })
  assert.deepEqual(development, {
    runtime: '/work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    entry: '/work/packages/cli/dist/src/bin.js',
    bundle: null,
  })

  // A packaged layout this code does not recognise is not searched for either.
  assert.equal(
    targetOf({ execPath: '/opt/hd/bin/harnessdesk', entry: '/opt/hd/lib/bin.js', packaged: true }).bundle,
    null,
  )
})

test('our launcher is recognised by its marker on the second line, and by nothing else', () => {
  const ours = launcherText(target())
  const lines = ours.split('\n')
  assert.equal(lines[0], '#!/bin/sh')
  assert.equal(lines[1], LAUNCHER_MARKER)
  assert.equal(isOurLauncher(ours), true)

  assert.equal(isOurLauncher(''), false)
  assert.equal(isOurLauncher('#!/bin/sh\necho hello\n'), false)
  // A foreign script that quotes the marker somewhere else is not ours.
  assert.equal(isOurLauncher(`#!/bin/sh\necho hello\n${LAUNCHER_MARKER}\n`), false)
  assert.equal(isOurLauncher(`#!/bin/sh\n${LAUNCHER_MARKER} and more\n`), false)
  assert.equal(isOurLauncher(`#!/bin/bash\n${LAUNCHER_MARKER}\n`), false)
  assert.equal(isOurLauncher(`${LAUNCHER_MARKER}\n#!/bin/sh\n`), false)
  assert.equal(isOurLauncher(`#!/bin/sh\r\n${LAUNCHER_MARKER}\r\n`), false)
})

test('the launcher is one deterministic POSIX script that sets one variable and quotes what it records', () => {
  const text = launcherText(target())
  assert.equal(text, launcherText(target()))
  assert.ok(text.endsWith('\n'))
  const syntax = spawnSync('/bin/sh', ['-n'], { input: text, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  // The only variable it sets for the command line is the one that makes the
  // app's own runtime behave as Node. Nothing in it is a credential.
  const exported = [...text.matchAll(/^\s*export\s+([A-Z_]+)/gm)].map((hit) => hit[1])
  assert.deepEqual(exported, ['ELECTRON_RUN_AS_NODE'])
  assert.doesNotMatch(text, /token|secret|password|credential/i)
  // The arguments reach the program as "$@", and nowhere else.
  assert.deepEqual([...text.matchAll(/\$@|\$\*|\$\{@\}|\beval\b/g)].map((hit) => hit[0]), ['$@'])

  // A development build has no app to search for, so the script carries none.
  const development = launcherText(target({ bundle: null }))
  assert.match(development, /^bundle_id=''$/m)
  assert.equal(spawnSync('/bin/sh', ['-n'], { input: development, encoding: 'utf8' }).status, 0)
})

test('a first install puts the launcher in ~/.local/bin when that folder is on the login PATH', () => {
  const home = makeHome()
  const result = installLauncher({ home, target: target(), loginPath: `/usr/bin:${home}/.local/bin:/bin` })
  assert.deepEqual(result, { status: 'installed', path: COMMAND(home), dir: join(home, '.local', 'bin'), onPath: true })

  assert.equal(readFileSync(result.path, 'utf8'), launcherText(target()))
  assert.equal(lstatSync(result.path).mode & 0o777, 0o755, 'the launcher is executable')
  assert.deepEqual(tree(home), ['.local/', '.local/bin/', '.local/bin/harnessdesk'], 'nothing but the launcher and its folders')
})

test('~/bin is used when it is the owned folder on PATH, and ~/.local/bin wins when both are', () => {
  const only = makeHome()
  assert.equal(installLauncher({ home: only, target: target(), loginPath: `${only}/bin:/usr/bin` }).path, COMMAND(only, 'bin'))

  const both = makeHome()
  mkdirSync(join(both, 'bin'))
  const result = installLauncher({ home: both, target: target(), loginPath: `${both}/bin:${both}/.local/bin` })
  assert.equal(result.path, COMMAND(both))
  assert.equal(result.onPath, true)
})

test('PATH entries are compared as folders, and a folder that is not absolute does not count', () => {
  const home = makeHome()
  assert.equal(installLauncher({ home, target: target(), loginPath: `${home}/.local/bin/` }).onPath, true)

  const doubled = makeHome()
  assert.equal(installLauncher({ home: doubled, target: target(), loginPath: `${doubled}//.local/./bin` }).onPath, true)

  const relative = makeHome()
  assert.equal(installLauncher({ home: relative, target: target(), loginPath: '.local/bin:bin:.:' }).onPath, false)
})

test('with no owned folder on PATH it still installs, says so, and edits no shell file', () => {
  const home = makeHome()
  const profile = join(home, '.zshrc')
  writeFileSync(profile, 'export EDITOR=vim\n')
  const before = tree(home)

  const result = installLauncher({ home, target: target(), loginPath: '/usr/bin:/bin:/opt/homebrew/bin' })
  assert.deepEqual(result, { status: 'installed', path: COMMAND(home), dir: join(home, '.local', 'bin'), onPath: false })
  assert.equal(readFileSync(profile, 'utf8'), 'export EDITOR=vim\n', 'a shell file is never edited')
  assert.deepEqual(
    tree(home).filter((path) => !before.includes(path)),
    ['.local/', '.local/bin/', '.local/bin/harnessdesk'],
  )
})

test('a login PATH that could not be read is reported as unknown, not as absent', () => {
  const home = makeHome()
  assert.equal(installLauncher({ home, target: target(), loginPath: null }).onPath, null)
})

test('an owned folder that cannot be written falls through to the next, and none at all is a refusal', (t) => {
  if (process.getuid?.() === 0) return t.skip('root can write anywhere')
  const home = makeHome()
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  chmodSync(join(home, '.local', 'bin'), 0o555)
  t.after(() => chmodSync(join(home, '.local', 'bin'), 0o755))
  const result = installLauncher({ home, target: target(), loginPath: `${home}/.local/bin:${home}/bin` })
  assert.equal(result.path, COMMAND(home, 'bin'))
  assert.equal(result.onPath, true)

  const blocked = makeHome()
  mkdirSync(join(blocked, '.local'))
  writeFileSync(join(blocked, '.local', 'bin'), 'a file where a folder should be')
  writeFileSync(join(blocked, 'bin'), 'and another')
  assert.throws(
    () => installLauncher({ home: blocked, target: target(), loginPath: '/usr/bin' }),
    (error) => error.code === 'no-folder' && /\.local\/bin/.test(error.message) && /\/bin/.test(error.message),
  )
})

test('installing again over our own launcher replaces it, and leaves nothing behind', () => {
  const home = makeHome()
  const first = installLauncher({ home, target: target(), loginPath: `${home}/.local/bin` })
  const moved = target({
    runtime: '/srv/Jane Doe/Applications/HarnessDesk.app/Contents/MacOS/HarnessDesk',
    entry: `/srv/Jane Doe/Applications/HarnessDesk.app/${IN_APP.entryIn}`,
    bundle: { id: BUNDLE_ID, path: '/srv/Jane Doe/Applications/HarnessDesk.app', ...IN_APP },
  })
  const second = installLauncher({ home, target: moved, loginPath: `${home}/.local/bin` })
  assert.equal(second.status, 'updated')
  assert.equal(second.path, first.path)
  assert.equal(readFileSync(first.path, 'utf8'), launcherText(moved))
  assert.equal(lstatSync(first.path).mode & 0o777, 0o755)

  assert.equal(installLauncher({ home, target: moved, loginPath: `${home}/.local/bin` }).status, 'unchanged')
  assert.deepEqual(tree(home), ['.local/', '.local/bin/', '.local/bin/harnessdesk'], 'no temporary file is left in the folder')
})

test('a harnessdesk that is not ours is never overwritten, whatever it is', () => {
  const cases = {
    'a script of someone else’s': (path) => writeFileSync(path, '#!/bin/sh\necho mine\n', { mode: 0o755 }),
    'a script that only quotes our marker': (path) => writeFileSync(path, `#!/bin/sh\necho mine\n${LAUNCHER_MARKER}\n`),
    'an empty file': (path) => writeFileSync(path, ''),
    'a folder': (path) => mkdirSync(path),
    'a link to a program elsewhere': (path) => {
      const elsewhere = join(dirname(path), '..', '..', 'dev-checkout-bin.js')
      writeFileSync(elsewhere, 'console.log("dev")\n')
      symlinkSync(elsewhere, path)
    },
    'a link to our own launcher': (path) => {
      const copy = join(dirname(path), '..', '..', 'copy-of-ours')
      writeFileSync(copy, launcherText(target()))
      symlinkSync(copy, path)
    },
  }
  for (const [what, make] of Object.entries(cases)) {
    const home = makeHome()
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    make(COMMAND(home))
    const before = tree(home)
    const bytes = lstatSync(COMMAND(home)).isFile() ? readFileSync(COMMAND(home)) : null

    assert.throws(
      () => installLauncher({ home, target: target(), loginPath: `${home}/.local/bin` }),
      (error) => error.code === 'foreign' && error.path === COMMAND(home),
      what,
    )
    assert.deepEqual(tree(home), before, `${what}: nothing was added or removed`)
    if (bytes) assert.deepEqual(readFileSync(COMMAND(home)), bytes, `${what}: the bytes are untouched`)
    assert.equal(inspectLauncher(COMMAND(home)).state, 'foreign', what)
    assert.deepEqual(removeLauncher({ home }), { status: 'foreign', path: COMMAND(home) }, `${what}: and never removed`)
    assert.deepEqual(tree(home), before, `${what}: removing left it alone`)
  }
})

test('a launcher is never created over, or swapped for, something that is there by the time it is written', () => {
  const home = makeHome()
  const dir = join(home, '.local', 'bin')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'harnessdesk')

  // Something of somebody's appeared after the folder was inspected.
  writeFileSync(path, 'theirs\n')
  assert.throws(() => createLauncher(path, launcherText(target())), { code: 'EEXIST' })
  assert.equal(readFileSync(path, 'utf8'), 'theirs\n')
  assert.throws(() => replaceLauncher(path, launcherText(target())), { code: 'foreign' })
  assert.equal(readFileSync(path, 'utf8'), 'theirs\n')
  assert.deepEqual(readdirSync(dir), ['harnessdesk'], 'no temporary file is left behind either way')

  // Ours, by contrast, is replaced, and the result is executable.
  rmSync(path)
  createLauncher(path, launcherText(target()))
  replaceLauncher(path, launcherText(target({ runtime: '/elsewhere/runtime' })))
  assert.match(readFileSync(path, 'utf8'), /runtime='\/elsewhere\/runtime'/)
  assert.equal(lstatSync(path).mode & 0o777, 0o755)
})

test('a foreign harnessdesk in the other candidate folder also stops an install', () => {
  const home = makeHome()
  mkdirSync(join(home, 'bin'))
  writeFileSync(COMMAND(home, 'bin'), '#!/bin/sh\necho theirs\n')
  assert.throws(
    () => installLauncher({ home, target: target(), loginPath: `${home}/.local/bin` }),
    (error) => error.code === 'foreign' && error.path === COMMAND(home, 'bin'),
  )
  assert.equal(existsSync(join(home, '.local')), false, 'two commands of that name would shadow each other')
})

test('removing deletes our launcher and only that', () => {
  const home = makeHome()
  assert.deepEqual(removeLauncher({ home }), { status: 'absent' })

  installLauncher({ home, target: target(), loginPath: `${home}/.local/bin` })
  writeFileSync(join(home, '.local', 'bin', 'other-tool'), 'keep me')
  assert.deepEqual(removeLauncher({ home }), { status: 'removed', path: COMMAND(home) })
  assert.deepEqual(tree(home), ['.local/', '.local/bin/', '.local/bin/other-tool'], 'the folder and its neighbours stay')
  assert.deepEqual(removeLauncher({ home }), { status: 'absent' })

  const elsewhere = makeHome()
  installLauncher({ home: elsewhere, target: target(), loginPath: `${elsewhere}/bin` })
  assert.equal(removeLauncher({ home: elsewhere }).path, COMMAND(elsewhere, 'bin'))
})

test('the one line that puts a folder on PATH is the shell’s own, and never edits a file', () => {
  const home = '/home/user'
  const dir = `${home}/.local/bin`
  assert.deepEqual(pathAdvice({ dir, home, shell: '/bin/zsh' }), {
    file: '~/.zshrc',
    line: 'export PATH="$HOME/.local/bin:$PATH"',
  })
  assert.deepEqual(pathAdvice({ dir: `${home}/bin`, home, shell: '/opt/homebrew/bin/bash' }), {
    file: '~/.bash_profile',
    line: 'export PATH="$HOME/bin:$PATH"',
  })
  assert.deepEqual(pathAdvice({ dir, home, shell: '/opt/homebrew/bin/fish' }), {
    file: null,
    line: 'fish_add_path $HOME/.local/bin',
  })
  assert.deepEqual(pathAdvice({ dir, home, shell: undefined }), {
    file: '~/.profile',
    line: 'export PATH="$HOME/.local/bin:$PATH"',
  })
})

/* ---- a swap between the check and the change ------------------------------------------- */

/**
 * The launcher is looked at, and a moment later changed. Whatever another
 * process does in between (put a script of its own where ours was, a link, a
 * folder, even another copy of our launcher) must never be overwritten or
 * deleted. `hooks.afterCheck` runs at the last instant before the change and
 * `hooks.afterClaim` at the first instant after the file is taken, so every
 * swap below happens at exactly the moment that matters and none of these
 * tests depends on timing.
 */

/** What is at a path, in a form two looks can be compared by, including which file it is. */
const snapshotOf = (path) => {
  const stat = lstatSync(path, { bigint: true })
  const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other'
  return {
    kind,
    ino: stat.ino,
    ...(kind === 'file' ? { text: readFileSync(path, 'utf8') } : {}),
    ...(kind === 'link' ? { to: readlinkSync(path) } : {}),
    ...(kind === 'folder' ? { entries: readdirSync(path).sort() } : {}),
  }
}

const THEIRS = '#!/bin/sh\necho theirs\n'

/** What another process could put where our launcher is, each as a function of the path. */
const SWAPS = {
  'a script of someone else’s': (path) => {
    rmSync(path)
    writeFileSync(path, THEIRS, { mode: 0o755 })
  },
  'a script that only quotes our marker': (path) => {
    rmSync(path)
    writeFileSync(path, `#!/bin/sh\necho theirs\n${LAUNCHER_MARKER}\n`)
  },
  'foreign text written into the same file, which keeps its inode': (path) => {
    writeFileSync(path, THEIRS)
  },
  'a link to a program elsewhere': (path) => {
    const elsewhere = join(dirname(path), '..', '..', 'program.sh')
    writeFileSync(elsewhere, THEIRS)
    rmSync(path)
    symlinkSync(elsewhere, path)
  },
  'a link to a copy of our own launcher': (path) => {
    const copy = join(dirname(path), '..', '..', 'copy-of-ours')
    writeFileSync(copy, launcherText(target()))
    rmSync(path)
    symlinkSync(copy, path)
  },
  'a folder': (path) => {
    rmSync(path)
    mkdirSync(path)
    writeFileSync(join(path, 'inside'), 'theirs')
  },
  'another copy of our own launcher, which is not the file that was looked at': (path) => {
    rmSync(path)
    writeFileSync(path, launcherText(target({ runtime: '/elsewhere/runtime' })), { mode: 0o755 })
  },
}

const NEWER = launcherText(target({ runtime: '/newer/runtime' }))

/** A home with our launcher installed in ~/.local/bin, and what was seen of it. */
const installed = () => {
  const home = makeHome()
  const { path } = installLauncher({ home, target: target(), loginPath: `${home}/.local/bin` })
  return { home, path, looked: inspectLauncher(path) }
}

/** A refusal either restores the exact object or names the exact object held beside it. */
const assertPreserved = (path, after, error, what) => {
  const kept = error.held ?? path
  assert.deepEqual(snapshotOf(kept), after, `${what}: the same object, with the same contents`)
  assert.equal(dirname(kept), dirname(path), 'recovery stays in the original folder')
  assert.deepEqual(readdirSync(dirname(path)), [kept.slice(dirname(path).length + 1)], 'only the preserved object remains')
}

test('a swap between the check and a replacement is caught, and what was swapped in is left exactly as it is', () => {
  for (const [what, swap] of Object.entries(SWAPS)) {
    const { path, looked } = installed()
    let after
    let refused
    assert.throws(
      () => replaceLauncher(path, NEWER, { expected: looked, hooks: { afterCheck: () => { swap(path); after = snapshotOf(path) } } }),
      (error) => { refused = error; return error.code === 'changed' && error.path === path && /changed/.test(error.message) },
      what,
    )
    assertPreserved(path, after, refused, what)
  }
})

test('a swap between the check and a removal is caught, and what was swapped in is left exactly as it is', () => {
  for (const [what, swap] of Object.entries(SWAPS)) {
    const { home, path } = installed()
    let after
    let refused
    assert.throws(
      () => removeLauncher({ home, hooks: { afterCheck: () => { swap(path); after = snapshotOf(path) } } }),
      (error) => { refused = error; return error.code === 'changed' && error.path === path },
      what,
    )
    assertPreserved(path, after, refused, what)
  }
})

test('whatever the call answers, a file swapped in at the last moment is not overwritten by a replacement', () => {
  for (const [what, swap] of Object.entries(SWAPS)) {
    const { path, looked } = installed()
    let after
    let refused
    try {
      replaceLauncher(path, NEWER, { expected: looked, hooks: { afterCheck: () => { swap(path); after = snapshotOf(path) } } })
    } catch (error) {
      refused = error
      // What it answers is for the tests above; this one is about what became of the file.
    }
    assertPreserved(path, after, refused, what)
  }
})

test('whatever the call answers, a file swapped in at the last moment is not deleted by a removal', () => {
  for (const [what, swap] of Object.entries(SWAPS)) {
    const { home, path } = installed()
    let after
    let refused
    try {
      removeLauncher({ home, hooks: { afterCheck: () => { swap(path); after = snapshotOf(path) } } })
    } catch (error) {
      refused = error
      // What it answers is for the tests above; this one is about what became of the file.
    }
    assertPreserved(path, after, refused, what)
  }
})

test('the same swaps are caught through installLauncher, which brings our own launcher up to date', () => {
  for (const [what, swap] of Object.entries(SWAPS)) {
    const { home, path } = installed()
    let after
    let refused
    assert.throws(
      () => installLauncher({
        home,
        target: target({ runtime: '/newer/runtime' }),
        loginPath: null,
        hooks: { afterCheck: () => { swap(path); after = snapshotOf(path) } },
      }),
      (error) => { refused = error; return error.code === 'changed' },
      what,
    )
    assertPreserved(path, after, refused, what)
  }
})

test('without a swap the same hooks change nothing: the launcher is replaced, and removed', () => {
  const calls = []
  const { home, path, looked } = installed()
  replaceLauncher(path, NEWER, { expected: looked, hooks: { afterCheck: () => calls.push('check'), afterClaim: () => calls.push('claim') } })
  assert.deepEqual(calls, ['check', 'claim'], 'the hooks are called once each, in order')
  assert.equal(readFileSync(path, 'utf8'), NEWER)
  assert.equal(lstatSync(path).mode & 0o777, 0o755)
  assert.deepEqual(readdirSync(dirname(path)), ['harnessdesk'])

  assert.deepEqual(removeLauncher({ home, hooks: { afterCheck: () => calls.push('check'), afterClaim: () => calls.push('claim') } }), { status: 'removed', path })
  assert.deepEqual(calls, ['check', 'claim', 'check', 'claim'])
  assert.deepEqual(readdirSync(dirname(path)), [])
})

test('a launcher that has gone by the time it is changed is already removed, and is a refusal to replace', () => {
  const removing = installed()
  assert.deepEqual(removeLauncher({ home: removing.home, hooks: { afterCheck: () => rmSync(removing.path) } }), { status: 'absent' })

  const replacing = installed()
  assert.throws(
    () => replaceLauncher(replacing.path, NEWER, { expected: replacing.looked, hooks: { afterCheck: () => rmSync(replacing.path) } }),
    (error) => error.code === 'changed' && error.path === replacing.path,
  )
  assert.deepEqual(readdirSync(dirname(replacing.path)), [], 'nothing is created where our launcher was')
})

test('something that takes the name while our launcher is set aside is never overwritten', () => {
  const newcomer = (info) => writeFileSync(info.path, 'newcomer\n')

  const replacing = installed()
  assert.throws(
    () => replaceLauncher(replacing.path, NEWER, { expected: replacing.looked, hooks: { afterClaim: newcomer } }),
    (error) => error.code === 'changed',
  )
  assert.equal(readFileSync(replacing.path, 'utf8'), 'newcomer\n', 'the newcomer stays, ours is dropped')
  assert.deepEqual(readdirSync(dirname(replacing.path)), ['harnessdesk'], 'and nothing is left beside it')

  const removing = installed()
  assert.deepEqual(removeLauncher({ home: removing.home, hooks: { afterClaim: newcomer } }), { status: 'removed', path: removing.path })
  assert.equal(readFileSync(removing.path, 'utf8'), 'newcomer\n', 'ours was removed and the newcomer is untouched')
  assert.deepEqual(readdirSync(dirname(removing.path)), ['harnessdesk'])
})

test('when what was swapped in cannot be put back because the name was taken again, it is kept and said where', () => {
  const { path, looked } = installed()
  let refused
  try {
    replaceLauncher(path, NEWER, {
      expected: looked,
      hooks: { afterCheck: () => SWAPS['a script of someone else’s'](path), afterClaim: (info) => writeFileSync(info.path, 'newcomer\n') },
    })
  } catch (error) {
    refused = error
  }
  assert.equal(refused?.code, 'changed')
  assert.equal(readFileSync(path, 'utf8'), 'newcomer\n', 'the newcomer is untouched')
  assert.ok(refused.held, 'the error names where the other file is kept')
  assert.equal(dirname(refused.held), dirname(path))
  assert.equal(readFileSync(refused.held, 'utf8'), THEIRS, 'nothing of anyone else’s was deleted')
  assert.deepEqual(readdirSync(dirname(path)).sort(), ['harnessdesk', refused.held.slice(dirname(path).length + 1)].sort())
})

test('a launcher is read through one open that follows no link and waits on no pipe, and says which file it read', (t) => {
  const { path, looked } = installed()
  const stat = statSync(path, { bigint: true })
  assert.deepEqual(looked.id, { dev: stat.dev, ino: stat.ino }, 'the identity is the one of the file that was read')

  const links = makeHome()
  mkdirSync(join(links, '.local', 'bin'), { recursive: true })
  symlinkSync(join(links, 'nowhere'), COMMAND(links))
  assert.deepEqual(inspectLauncher(COMMAND(links)), { state: 'foreign', why: 'link' }, 'a link that points nowhere is still a link')

  const pipes = makeHome()
  mkdirSync(join(pipes, '.local', 'bin'), { recursive: true })
  try {
    execFileSync('mkfifo', [COMMAND(pipes)])
  } catch {
    return t.skip('no mkfifo on this machine')
  }
  // Read in a child with a hard deadline: a look that waits for a writer to the pipe waits for as long as
  // nobody writes, and neither this runner's timeout nor anything else can interrupt a blocked open.
  const look = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { inspectLauncher } from ${JSON.stringify(new URL('./cli-install.mjs', import.meta.url).href)}\n` +
        `process.stdout.write(JSON.stringify(inspectLauncher(${JSON.stringify(COMMAND(pipes))})))`,
    ],
    { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' },
  )
  assert.equal(look.error?.code, undefined, `the look waited on the pipe: ${look.error?.message ?? ''}`)
  assert.deepEqual(JSON.parse(look.stdout), { state: 'foreign', why: 'file' }, 'a pipe is not read, and is not waited on')
})

/* ---- the launcher, run for real ------------------------------------------------------- */

const ARGUMENTS = [
  'plain',
  'with space',
  "it's",
  '"double"',
  '$HOME',
  '${HOME}',
  '$(touch pwned-by-substitution)',
  '`touch pwned-by-backticks`',
  '; touch pwned-by-semicolon',
  'a|b&c',
  'two\nlines',
  '*',
  '?',
  '~',
  '-n',
  '--',
  '',
  '\\',
  '  padded  ',
  '--flag=$x y',
  'Jane Doe — 東京',
]

/** A small PATH of our own, so a real `mdfind` never answers for an app on this machine. */
const sandboxPath = (mdfind) => {
  const bin = folder('bin')
  if (mdfind !== undefined) {
    writeFileSync(join(bin, 'mdfind'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$0.calls"\n${mdfind}\n`, { mode: 0o755 })
    chmodSync(join(bin, 'mdfind'), 0o755)
  }
  return { bin, PATH: `${bin}:/usr/bin:/bin` }
}

const launch = (launcher, args, { home, PATH, ...env } = {}) =>
  spawnSync(launcher, args, { cwd: home, env: { HOME: home, PATH, ...env }, encoding: 'utf8' })

const asReported = (run) => JSON.parse(run.stdout)

test('the installed launcher hands its arguments to the bundled command line exactly as given', () => {
  const home = makeHome()
  const app = fakeApp(join(home, 'Applications', 'HarnessDesk.app'))
  const { path } = installLauncher({ home, target: app, loginPath: `${home}/.local/bin` })
  const { PATH } = sandboxPath('')

  const run = launch(path, ARGUMENTS, { home, PATH })
  assert.equal(run.status, 0, run.stderr)
  const reported = asReported(run)
  assert.deepEqual(reported.argv, ARGUMENTS, 'spaces, quotes, $, newlines and an empty argument arrive unchanged')
  assert.equal(reported.electron, '1', 'the app’s own runtime is told to behave as Node')
  assert.equal(reported.entry, app.entry)
  assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('pwned')), [], 'nothing in an argument was run')
  assert.equal(readdirSync(home).some((name) => name.includes('pwned')), false)
})

test('the exit status of the command line is the launcher’s own', () => {
  const home = makeHome()
  const app = fakeApp(join(home, 'Applications', 'HarnessDesk.app'))
  const { path } = installLauncher({ home, target: app, loginPath: `${home}/.local/bin` })
  const { PATH } = sandboxPath('')
  for (const code of [0, 3, 4, 8, 130]) {
    assert.equal(launch(path, ['status'], { home, PATH, FAKE_EXIT: String(code) }).status, code)
  }
})

test('a location with spaces, quotes and a newline in it still runs', () => {
  const home = makeHome()
  const odd = join(home, 'it\'s a "dir" $HOME `x`\nsecond line', 'HarnessDesk.app')
  const app = fakeApp(odd)
  const { path } = installLauncher({ home, target: app, loginPath: `${home}/.local/bin` })
  const { PATH } = sandboxPath('')
  const run = launch(path, ['status', 'a b'], { home, PATH })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(asReported(run).argv, ['status', 'a b'])
  assert.equal(asReported(run).entry, app.entry)
})

test('an app that moved is found again at run time, in the folders it is searched for', () => {
  const home = makeHome()
  const gone = join(home, 'Downloads', 'HarnessDesk.app')
  const installed = fakeApp(gone)
  const searched = join(home, 'Applications')
  const { path } = installLauncher({
    home,
    target: installed,
    loginPath: `${home}/.local/bin`,
    searchFolders: ['/nowhere/at/all', searched],
  })
  rmSync(gone, { recursive: true })
  const moved = fakeApp(join(searched, 'HarnessDesk.app'))

  const { PATH, bin } = sandboxPath('')
  const run = launch(path, ['runs', '--json'], { home, PATH })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(asReported(run).entry, moved.entry, 'the launcher followed the app to where it is now')
  assert.equal(existsSync(join(bin, 'mdfind.calls')), false, 'a known folder answered before Spotlight was asked')
})

test('an app that moved somewhere unexpected is found by its bundle id', () => {
  const home = makeHome()
  const gone = join(home, 'Downloads', 'HarnessDesk.app')
  const { path } = installLauncher({
    home,
    target: fakeApp(gone),
    loginPath: `${home}/.local/bin`,
    searchFolders: ['/nowhere/at/all'],
  })
  rmSync(gone, { recursive: true })
  const where = fakeApp(join(home, 'Tools', 'HarnessDesk.app'))

  // Spotlight lists a copy that is not an app first, then the real one.
  const { PATH, bin } = sandboxPath(`printf '%s\\n' ${shellQuote(join(home, 'Trash', 'HarnessDesk.app'))} ${shellQuote(where.bundle.path)}`)
  const run = launch(path, ['teams'], { home, PATH })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(asReported(run).entry, where.entry)
  assert.match(readFileSync(join(bin, 'mdfind.calls'), 'utf8'), /kMDItemCFBundleIdentifier == 'app\.harnessdesk\.desktop'/)
})

test('when the app is nowhere, the launcher says what to do and exits 127', () => {
  const home = makeHome()
  const gone = join(home, 'Downloads', 'HarnessDesk.app')
  const { path } = installLauncher({ home, target: fakeApp(gone), loginPath: `${home}/.local/bin`, searchFolders: ['/nowhere/at/all'] })
  rmSync(gone, { recursive: true })
  const { PATH } = sandboxPath('')
  const run = launch(path, ['status'], { home, PATH })
  assert.equal(run.status, 127)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /^harnessdesk: HarnessDesk was not found/)
  assert.match(run.stderr, /Install command-line tool…/)
})

test('a development build records its own paths and is never searched for', () => {
  const home = makeHome()
  const app = fakeApp(join(home, 'checkout', 'Electron.app'))
  const { path } = installLauncher({
    home,
    target: { runtime: app.runtime, entry: app.entry, bundle: null },
    loginPath: `${home}/.local/bin`,
  })
  const { PATH } = sandboxPath('')
  assert.equal(launch(path, ['desks'], { home, PATH }).status, 0)
  rmSync(join(home, 'checkout'), { recursive: true })
  const run = launch(path, ['desks'], { home, PATH })
  assert.equal(run.status, 127, 'with the checkout gone there is nothing to follow')
})

/* ---- the menu item: what it asks, says and does ---------------------------------------- */

const rig = ({
  home = makeHome(),
  platform = 'darwin',
  shell = '/bin/zsh',
  loginPath,
  answers = [],
  showDialog,
  withApp = true,
  hooks,
} = {}) => {
  const app = withApp ? fakeApp(join(home, 'Applications', 'HarnessDesk.app')) : target({ runtime: join(home, 'missing-runtime'), entry: join(home, 'missing-bin.js'), bundle: null })
  const dialogs = []
  const copied = []
  const logs = []
  const tool = createCommandLineTool({
    platform,
    home,
    shell,
    target: () => app,
    loginPath: loginPath ?? (async () => `/usr/bin:${home}/.local/bin`),
    showDialog: showDialog ?? (async (request) => {
      dialogs.push(request)
      return answers.shift() ?? 0
    }),
    copyText: (text) => copied.push(text),
    log: (message, data) => logs.push([message, data]),
    ...(hooks ? { hooks } : {}),
  })
  return { home, app, tool, dialogs, copied, logs }
}

test('the item is offered where the launcher can work, and nowhere else', () => {
  assert.equal(rig({ platform: 'darwin' }).tool.available, true)
  assert.equal(rig({ platform: 'linux' }).tool.available, true)
  assert.equal(rig({ platform: 'win32' }).tool.available, false)
})

test('a first run installs and says where, in a dialog that names no agent', async () => {
  const { home, tool, dialogs } = rig()
  const result = await tool.run()
  assert.equal(result.outcome, 'installed')
  assert.equal(result.path, COMMAND(home))
  assert.equal(dialogs.length, 1)
  assert.deepEqual(dialogs[0], {
    message: 'The command-line tool is installed',
    detail: 'Run harnessdesk in a terminal to use it. It is at ~/.local/bin/harnessdesk.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  })
  assert.equal(readFileSync(COMMAND(home), 'utf8').startsWith('#!/bin/sh\n'), true)
  assert.doesNotMatch(JSON.stringify(dialogs), /codex|claude|cursor|gemini|deepseek/i)
})

test('when the folder is not on PATH the dialog gives the one line, and Copy Line copies exactly it', async () => {
  const { tool, dialogs, copied } = rig({ loginPath: async () => '/usr/bin:/bin', answers: [1] })
  const result = await tool.run()
  assert.equal(result.outcome, 'installed')
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].message, 'The command-line tool is installed, but its folder is not on your PATH')
  assert.deepEqual(dialogs[0].buttons, ['OK', 'Copy Line'])
  assert.equal(
    dialogs[0].detail,
    [
      'It is at ~/.local/bin/harnessdesk, and that folder is not on your PATH.',
      'To run it as harnessdesk, add this line to ~/.zshrc and open a new terminal window:',
      '',
      'export PATH="$HOME/.local/bin:$PATH"',
    ].join('\n'),
  )
  assert.deepEqual(copied, ['export PATH="$HOME/.local/bin:$PATH"'])

  const declined = rig({ loginPath: async () => '/usr/bin', answers: [0] })
  await declined.tool.run()
  assert.deepEqual(declined.copied, [], 'nothing is copied unless it was asked for')
})

test('a login shell that does not answer is said, and the install still happens', async () => {
  for (const loginPath of [async () => null, async () => { throw new Error('the shell hung') }]) {
    const { home, tool, dialogs } = rig({ loginPath })
    const result = await tool.run()
    assert.equal(result.outcome, 'installed')
    assert.equal(existsSync(COMMAND(home)), true)
    assert.equal(dialogs[0].message, 'The command-line tool is installed')
    assert.match(dialogs[0].detail, /could not read your shell’s PATH/)
    assert.match(dialogs[0].detail, /export PATH="\$HOME\/\.local\/bin:\$PATH"/)
    assert.deepEqual(dialogs[0].buttons, ['OK', 'Copy Line'])
  }
})

test('a second run offers to remove it, and removes it when asked', async () => {
  const { home, tool, dialogs } = rig({ answers: [0, 1, 0] })
  await tool.run()
  assert.equal(existsSync(COMMAND(home)), true)

  const second = await tool.run()
  assert.equal(second.outcome, 'removed')
  assert.deepEqual(dialogs[1], {
    message: 'The command-line tool is already installed',
    detail: 'harnessdesk is at ~/.local/bin/harnessdesk.\n\nRemove it to stop using harnessdesk from a terminal. HarnessDesk itself is not affected.',
    buttons: ['Done', 'Remove'],
    defaultId: 0,
    cancelId: 0,
  })
  assert.equal(existsSync(COMMAND(home)), false)
  assert.deepEqual(dialogs[2], {
    message: 'The command-line tool was removed',
    detail: '~/.local/bin/harnessdesk was deleted. Choose Install command-line tool… to add it again.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  })

  // And it can be put back.
  assert.equal((await tool.run()).outcome, 'installed')
})

test('a second run left at Done changes nothing, and Escape counts as Done', async () => {
  const { home, tool } = rig({ answers: [0, 0, 0] })
  await tool.run()
  const before = readFileSync(COMMAND(home), 'utf8')
  assert.equal((await tool.run()).outcome, 'kept')
  assert.equal(readFileSync(COMMAND(home), 'utf8'), before)
  assert.equal((await tool.run()).outcome, 'kept')
})

test('a second run from an app that moved refreshes our launcher before it offers to remove it', async () => {
  const home = makeHome()
  const old = rig({ home })
  await old.tool.run()
  const before = readFileSync(COMMAND(home), 'utf8')

  const next = fakeApp(join(home, 'Applications', 'HarnessDesk Beta.app'))
  const { dialogs, tool } = (() => {
    const dialogs = []
    const tool = createCommandLineTool({
      platform: 'darwin',
      home,
      shell: '/bin/zsh',
      target: () => next,
      loginPath: async () => `${home}/.local/bin`,
      showDialog: async (request) => { dialogs.push(request); return 0 },
      copyText: () => {},
    })
    return { dialogs, tool }
  })()
  const result = await tool.run()
  assert.equal(result.outcome, 'kept')
  assert.equal(result.refreshed, true)
  assert.notEqual(readFileSync(COMMAND(home), 'utf8'), before)
  assert.equal(readFileSync(COMMAND(home), 'utf8'), launcherText(next))
  assert.equal(dialogs.length, 1)
})

test('a harnessdesk that is not ours is left alone and the dialog says so', async () => {
  const home = makeHome()
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(COMMAND(home), '#!/bin/sh\necho mine\n', { mode: 0o755 })
  const { tool, dialogs } = rig({ home })
  const result = await tool.run()
  assert.equal(result.outcome, 'refused')
  assert.deepEqual(dialogs, [{
    message: 'The command-line tool was not installed',
    detail: '~/.local/bin/harnessdesk is already there, and HarnessDesk did not put it there, so it was left as it is. Move or rename it, then choose Install command-line tool… again.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  }])
  assert.equal(readFileSync(COMMAND(home), 'utf8'), '#!/bin/sh\necho mine\n')
})

test('a build without the bundled command line says so and writes nothing', async () => {
  const { home, tool, dialogs } = rig({ withApp: false })
  const result = await tool.run()
  assert.equal(result.outcome, 'unavailable')
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].message, 'This build of HarnessDesk does not include the command-line tool')
  assert.match(dialogs[0].detail, /missing-bin\.js/)
  assert.deepEqual(tree(home), [], 'nothing was written')
})

test('an install that fails is said plainly, with the folder and the reason', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can write anywhere')
  const home = makeHome()
  mkdirSync(join(home, '.local'))
  writeFileSync(join(home, '.local', 'bin'), 'a file')
  writeFileSync(join(home, 'bin'), 'another')
  const { tool, dialogs } = rig({ home })
  const result = await tool.run()
  assert.equal(result.outcome, 'failed')
  assert.equal(dialogs[0].message, 'The command-line tool could not be installed')
  assert.match(dialogs[0].detail, /~\/\.local\/bin/)
  assert.match(dialogs[0].detail, /~\/bin/)
})

test('a swap while the launcher is brought up to date is said, and what was swapped in is left as it is', async () => {
  const home = makeHome()
  await rig({ home }).tool.run()
  const path = COMMAND(home)
  let after
  const moved = fakeApp(join(home, 'Applications', 'HarnessDesk Beta.app'))
  const dialogs = []
  const tool = createCommandLineTool({
    platform: 'darwin',
    home,
    shell: '/bin/zsh',
    target: () => moved,
    loginPath: async () => `${home}/.local/bin`,
    showDialog: async (request) => { dialogs.push(request); return 0 },
    copyText: () => {},
    hooks: { afterCheck: () => { SWAPS['a script of someone else’s'](path); after = snapshotOf(path) } },
  })
  const result = await tool.run()
  assert.equal(result.outcome, 'changed')
  assert.deepEqual(dialogs, [{
    message: 'The command-line tool was not updated',
    detail: '~/.local/bin/harnessdesk was changed while HarnessDesk was updating it, so it was left as it is. Choose Install command-line tool… to look again.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  }])
  assert.deepEqual(snapshotOf(path), after)
})

test('a swap while the launcher is removed is said, and what was swapped in is left as it is', async () => {
  const home = makeHome()
  const path = COMMAND(home)
  let after
  const { tool, dialogs } = rig({
    home,
    answers: [0, 1, 0],
    hooks: { afterCheck: () => { SWAPS['a folder'](path); after = snapshotOf(path) } },
  })
  // The first run installs; the hook is only reached by a change to an existing launcher.
  await tool.run()
  assert.equal(existsSync(path), true)
  const result = await tool.run()
  assert.equal(result.outcome, 'changed')
  assert.equal(dialogs.at(-1).message, 'The command-line tool was not removed')
  assert.ok(result.held, 'a folder cannot be restored with a hard link, so recovery names it')
  assert.equal(
    dialogs.at(-1).detail,
    `~/.local/bin/harnessdesk was changed while HarnessDesk was removing it, so it was left as it is. What was there is kept as ${result.held.replace(home, '~')}. Choose Install command-line tool… to look again.`,
  )
  assertPreserved(path, after, result, 'the folder swapped in')
})

test('when the other file cannot be put back, the dialog says where it is kept', async () => {
  const home = makeHome()
  const path = COMMAND(home)
  const first = rig({ home })
  await first.tool.run()
  const moved = fakeApp(join(home, 'Applications', 'HarnessDesk Beta.app'))
  const dialogs = []
  const tool = createCommandLineTool({
    platform: 'darwin',
    home,
    shell: '/bin/zsh',
    target: () => moved,
    loginPath: async () => `${home}/.local/bin`,
    showDialog: async (request) => { dialogs.push(request); return 0 },
    copyText: () => {},
    hooks: {
      afterCheck: () => SWAPS['a script of someone else’s'](path),
      afterClaim: (info) => writeFileSync(info.path, 'newcomer\n'),
    },
  })
  assert.equal((await tool.run()).outcome, 'changed')
  assert.match(dialogs[0].detail, /^~\/\.local\/bin\/harnessdesk was changed while HarnessDesk was updating it, so it was left as it is\. What was there is kept as ~\/\.local\/bin\/\.harnessdesk\.\d+\.[0-9a-f-]+\.held\. Choose Install command-line tool… to look again\.$/)
  assert.equal(readFileSync(path, 'utf8'), 'newcomer\n')
})

test('a dialog that fails is logged and never becomes an unhandled rejection', async () => {
  const { tool, logs, home } = rig({ showDialog: async () => { throw new Error('the window closed underneath it') } })
  const result = await tool.run()
  assert.equal(result.outcome, 'installed', 'the install is not undone by a dialog that could not be shown')
  assert.equal(existsSync(COMMAND(home)), true)
  assert.ok(logs.some(([message, data]) => /dialog/.test(message) && /window closed/.test(JSON.stringify(data))))
})

test('a second click while one is in flight is the same run, not a second install', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const dialogs = []
  const { tool, home } = rig({
    showDialog: async (request) => {
      dialogs.push(request)
      await gate
      return 0
    },
  })
  const first = tool.run()
  const second = tool.run()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(dialogs.length, 1)
  assert.deepEqual(a, b)
  assert.equal(existsSync(COMMAND(home)), true)
})

test('where the item is not offered, running it does nothing', async () => {
  const { tool, home, dialogs } = rig({ platform: 'win32' })
  const before = tree(home)
  assert.equal((await tool.run()).outcome, 'unavailable')
  assert.deepEqual(tree(home), before, 'nothing was written')
  assert.deepEqual(dialogs, [])
})

test('the shell adds the item to the HarnessDesk menu and runs this module’s click', () => {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{[^}]*\bMENU_LABEL\b[^}]*\} from '\.\/cli-install\.mjs'/)
  assert.match(source, /label: MENU_LABEL,\s*click: \(\) => void commandLineTool\.run\(\)/)
  // It sits in the HarnessDesk menu, after Settings and before Services.
  const menu = source.slice(source.indexOf("label: 'HarnessDesk',"), source.indexOf("label: 'File',"))
  assert.ok(menu.indexOf("label: 'Settings…'") < menu.indexOf('MENU_LABEL'))
  assert.ok(menu.indexOf('MENU_LABEL') < menu.indexOf("role: 'services'"))
})
