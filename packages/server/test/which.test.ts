import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import { defaultShell } from '../src/terminals.js'
import { whichOnPath } from '../src/installs/which.js'

/**
 * Where a command on PATH is.
 *
 * Two byte-identical copies of this ran `/usr/bin/which`, an absolute POSIX
 * path in a project that ships a Windows build — where the spawn throws
 * `ENOENT`, the `catch` answers null, and every agent reads as not installed
 * beside a working Node. `/usr/bin/which` is also absent on several Linux
 * distributions and from minimal images, which reads the same way.
 *
 * These run against a real directory on a real PATH rather than a stub,
 * because the thing under test is a filesystem question and a stub of the
 * filesystem would only re-state the implementation.
 */

const bin = (): string => mkdtempSync(join(tmpdir(), 'hd-which-'))

const put = (dir: string, name: string, mode: number): string => {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, mode)
  return path
}

test('a command on PATH is found where it actually is', () => {
  const dir = bin()
  const path = put(dir, 'hd-fake-tool', 0o755)
  assert.equal(whichOnPath('hd-fake-tool', { env: { PATH: dir } }), path)
})

test('the first directory on PATH wins, the way a shell would resolve it', () => {
  const first = bin()
  const second = bin()
  const winner = put(first, 'hd-fake-tool', 0o755)
  put(second, 'hd-fake-tool', 0o755)
  assert.equal(whichOnPath('hd-fake-tool', { env: { PATH: [first, second].join(delimiter) } }), winner)
})

test('a command that is not there is null, and so is one PATH cannot run', () => {
  const dir = bin()
  assert.equal(whichOnPath('hd-not-a-tool', { env: { PATH: dir } }), null)
  /* Present and not executable is the case a naive `existsSync` gets wrong:
     a shell would keep looking, and so must this. Skipped where the mode bits
     do not decide — Windows has no execute bit, and root ignores it. */
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    put(dir, 'hd-unrunnable', 0o644)
    assert.equal(whichOnPath('hd-unrunnable', { env: { PATH: dir } }), null)
  }
})

test('an empty or absent PATH answers null rather than throwing', () => {
  assert.equal(whichOnPath('hd-fake-tool', { env: { PATH: '' } }), null)
  assert.equal(whichOnPath('hd-fake-tool', { env: {} }), null)
  assert.equal(whichOnPath('', { env: { PATH: bin() } }), null)
})

test('an empty entry in PATH is skipped, not read as the working directory', () => {
  /* `PATH=/a::/b` is a real spelling and its empty field means "here" to some
     shells. Searching the process's own working directory for an agent binary
     is not a thing this should ever do. */
  const dir = bin()
  const path = put(dir, 'hd-fake-tool', 0o755)
  assert.equal(whichOnPath('hd-fake-tool', { env: { PATH: `${delimiter}${dir}${delimiter}` } }), path)
})

test('a name with a separator in it is answered as given, not searched for', () => {
  const dir = bin()
  const path = put(dir, 'hd-fake-tool', 0o755)
  // `execFile` would run it as given; answering null would be a lie about a
  // command that works.
  assert.equal(whichOnPath(path, { env: { PATH: '' } }), path)
  assert.equal(whichOnPath(join(dir, 'hd-not-a-tool'), { env: { PATH: '' } }), null)
})

/**
 * The Windows half, exercised on whatever machine this runs on.
 *
 * The bug being fixed is a Windows bug, and a Windows rule that can only be
 * checked on Windows is a Windows rule nothing checks — which is how
 * `/usr/bin/which` survived in two files of a project that ships a Windows
 * build. `platform` and `runnable` are parameters so the rules can be asked
 * about directly; the tests above still run against a real filesystem.
 */

/** A pretend disk: these paths exist and can be run, nothing else can. */
const only = (...paths: readonly string[]) => {
  const there = new Set(paths)
  return (path: string) => there.has(path)
}

/**
 * The same, case-insensitively — which is what NTFS is.
 *
 * PATHEXT is spelled in capitals by convention (`.COM;.EXE;.BAT;.CMD`) and the
 * file on disk is `npx.cmd`, so a case-*sensitive* fake answers no to the
 * candidate Windows would answer yes to. The first take of these tests failed
 * for exactly that reason: the fake was wrong about the platform it stood in
 * for, which is the only way a fake can quietly invert a result.
 */
const onlyCaseless = (...paths: readonly string[]) => {
  const there = new Set(paths.map((one) => one.toLowerCase()))
  return (path: string) => there.has(path.toLowerCase())
}

test('on Windows a bare name is tried with each PATHEXT suffix', () => {
  /* `npx` on Windows is `npx.cmd`. A PATH walk that only tried the bare name
     would find nothing and be the same defect in a new spelling. */
  const found = whichOnPath('npx', {
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    runnable: onlyCaseless('C:\\tools\\npx.cmd'),
  })
  /* Compared without case, because the suffix comes from PATHEXT — spelled in
     capitals by convention — while the file on disk is `npx.cmd`. Both name
     the same file on a case-insensitive filesystem, and this is a path to
     spawn rather than a string to display. */
  assert.equal(found?.toLowerCase(), 'c:\\tools\\npx.cmd')
})

test('on Windows PATH is split on semicolons, so a drive letter is not a separator', () => {
  /* `C:\tools;C:\other` split on `:` gives `C`, `\tools;C`, `\other` — every
     entry wrong. Reading the *host's* separator would do exactly that when
     the platform asked about is not the host. */
  const found = whichOnPath('uvx', {
    platform: 'win32',
    env: { PATH: 'C:\\tools;D:\\bin', PATHEXT: '.EXE' },
    runnable: onlyCaseless('D:\\bin\\uvx.exe'),
  })
  assert.equal(found?.toLowerCase(), 'd:\\bin\\uvx.exe')
})

test('on Windows a bare name never resolves to the extensionless file beside it', () => {
  /* This test asserted the opposite in the first version of this change, and
     the opposite was wrong. An official Node install on Windows ships *both*
     `npx` — a POSIX shell script, for Git Bash — and `npx.cmd` in one
     directory, and Windows has no execute bit to tell them apart. Returning
     the script hands `CreateProcess` something it cannot run: "%1 is not a
     valid Win32 application". Found in review. */
  const found = whichOnPath('npx', {
    platform: 'win32',
    env: { PATH: 'C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    runnable: onlyCaseless('C:\\Program Files\\nodejs\\npx', 'C:\\Program Files\\nodejs\\npx.cmd'),
  })
  assert.equal(found?.toLowerCase(), 'c:\\program files\\nodejs\\npx.cmd')
})

test('on Windows a name that already carries a PATHEXT extension is taken as written', () => {
  const found = whichOnPath('tool.exe', {
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE' },
    runnable: onlyCaseless('C:\\tools\\tool.exe'),
  })
  assert.equal(found?.toLowerCase(), 'c:\\tools\\tool.exe')
  // And not doubled up into `tool.exe.exe`.
  assert.equal(
    whichOnPath('tool.exe', {
      platform: 'win32',
      env: { PATH: 'C:\\tools', PATHEXT: '.EXE' },
      runnable: onlyCaseless('C:\\tools\\tool.exe.exe'),
    }),
    null,
  )
})

test('on Windows an ordinary file on PATH is not a command', () => {
  /* Windows has no execute bit, so "is a file" is all `isRunnable` can ask.
     What keeps `README.md` from resolving as a command is that `.md` is not
     in PATHEXT and the bare name is never tried. */
  for (const name of ['README.md', 'package.json', 'notes']) {
    assert.equal(
      whichOnPath(name, {
        platform: 'win32',
        env: { PATH: 'C:\\project', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        runnable: onlyCaseless(`C:\\project\\${name}`),
      }),
      null,
      name,
    )
  }
})

test('off Windows no suffix is tried, so `npx.cmd` is not mistaken for `npx`', () => {
  assert.equal(
    whichOnPath('npx', {
      platform: 'linux',
      env: { PATH: '/opt/bin', PATHEXT: '.COM;.EXE' },
      runnable: only('/opt/bin/npx.exe'),
    }),
    null,
  )
})

test('a machine with no `which` binary at all still answers', () => {
  /* The whole reason this asks no binary anything: `/usr/bin/which` is absent
     on several Linux distributions and from minimal container images, and the
     old implementation answered `null` on every one of them — "Needs npx
     (Node.js), which is not on PATH", beside a working Node. Nothing here
     spawns, so there is nothing to be missing. */
  assert.equal(
    whichOnPath('npx', { platform: 'linux', env: { PATH: '/usr/local/bin' }, runnable: only('/usr/local/bin/npx') }),
    '/usr/local/bin/npx',
  )
})

/**
 * Which shell the dock opens when nothing names one.
 *
 * `SHELL` and `/bin/sh -i` are both POSIX facts, and Windows has neither: no
 * `SHELL` in a standard environment, no `/bin/sh` on disk, and no `-i` on
 * `cmd.exe`. So the fallback spawned `ENOENT` and Open a shell did nothing
 * but throw. Exercised from whatever machine runs this, for the reason the
 * PATH rules above are.
 */

test('on Windows the shell is COMSPEC, without a POSIX interactive flag', () => {
  assert.deepEqual(defaultShell({ platform: 'win32', env: { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' } }), [
    'C:\\Windows\\system32\\cmd.exe',
  ])
  // Windows without COMSPEC is unusual and still has a command processor.
  assert.deepEqual(defaultShell({ platform: 'win32', env: {} }), ['cmd.exe'])
  // The old fallback, which is what a Windows user actually got.
  assert.notDeepEqual(defaultShell({ platform: 'win32', env: {} }), ['/bin/sh', '-i'])
})

test('elsewhere it is the login shell, interactive, and sh when unset', () => {
  assert.deepEqual(defaultShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' } }), ['/bin/zsh', '-i'])
  assert.deepEqual(defaultShell({ platform: 'linux', env: {} }), ['/bin/sh', '-i'])
  // An empty SHELL is the same as none, not a shell called ''.
  assert.deepEqual(defaultShell({ platform: 'linux', env: { SHELL: '' } }), ['/bin/sh', '-i'])
  // And `SHELL` is not read on Windows, where it would name a POSIX path.
  assert.deepEqual(defaultShell({ platform: 'win32', env: { SHELL: '/bin/bash' } }), ['cmd.exe'])
})

test('a quoted PATH entry on Windows names the directory, not a quote', () => {
  /* Windows lets an installer write `"C:\Program Files\nodejs"` into PATH, and
     `where.exe` reads that as the directory. Joining the quotes in looks for a
     file that cannot exist. Raised in review. */
  const found = whichOnPath('npx', {
    platform: 'win32',
    env: { PATH: '"C:\\Program Files\\nodejs";C:\\other', PATHEXT: '.CMD' },
    runnable: onlyCaseless('C:\\Program Files\\nodejs\\npx.cmd'),
  })
  assert.equal(found?.toLowerCase(), 'c:\\program files\\nodejs\\npx.cmd')
})

test('a quote is only stripped as a surrounding pair, and never off Windows', () => {
  /* An unpaired quote is a malformed entry, not a quoted one: it must not be
     read as `C:\half`. What it produces instead is a path that cannot exist
     — `win32.join` treats a leading quote as a relative segment — and that is
     the right outcome for a PATH entry nothing can make sense of. */
  assert.equal(
    whichOnPath('tool', {
      platform: 'win32',
      env: { PATH: '"C:\\half', PATHEXT: '.EXE' },
      runnable: onlyCaseless('C:\\half\\tool.exe'),
    }),
    null,
  )
  /* And a POSIX directory may legitimately be called `"quoted"`, so nothing is
     stripped there — the spelling is a Windows convention, not a path rule. */
  assert.equal(
    whichOnPath('tool', {
      platform: 'linux',
      env: { PATH: '"/opt/quoted"' },
      runnable: only('"/opt/quoted"/tool'),
    }),
    '"/opt/quoted"/tool',
  )
})
