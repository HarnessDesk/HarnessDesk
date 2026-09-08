import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { test } from 'node:test'

import {
  applyLoginShellPath,
  loginShellPath,
  mergePaths,
  pathFromProbe,
  profileFiles,
  resolvePath,
  wellKnownBinDirs,
  type PathCache,
} from '../../src/installs/shell-path.js'

/**
 * The PATH a person's terminal has, given to a process that was not started
 * from one. What these hold to: the shell is asked, not guessed at; asking
 * never blocks and never throws; its answer comes first and in its order;
 * nothing the process had is dropped; the well-known install folders are
 * added only when they exist; and an unchanged setup is never asked twice.
 */

const DELIM = '__HARNESSDESK_PATH__'
const answers = (path: string) => async () => `${DELIM}${path}${DELIM}`

/** Runs a body with `process.env.PATH` restored afterwards. */
const withPath = async (start: string, body: () => Promise<void>): Promise<void> => {
  const before = process.env['PATH']
  process.env['PATH'] = start
  try {
    await body()
  } finally {
    if (before === undefined) delete process.env['PATH']
    else process.env['PATH'] = before
  }
}

test('the PATH is read from between the delimiters, greeting and all', () => {
  assert.equal(pathFromProbe(`Welcome back!\n${DELIM}/opt/homebrew/bin:/usr/bin${DELIM}`), '/opt/homebrew/bin:/usr/bin')
  // Anything after the closing delimiter is the profile talking, not PATH.
  assert.equal(pathFromProbe(`${DELIM}/a:/b${DELIM}\nnvm: v22 is now in use`), '/a:/b')
  assert.equal(pathFromProbe(`${DELIM}${DELIM}`), null)
  assert.equal(pathFromProbe('PATH=/a:/b'), null, 'an unbracketed answer is not an answer')
})

test('the shell is asked interactively, for PATH alone, and only on Unix', async () => {
  const calls: { shell: string; args: readonly string[] }[] = []
  const run = async (shell: string, args: readonly string[]) => {
    calls.push({ shell, args })
    return `${DELIM}/from/shell${DELIM}`
  }
  assert.equal(
    await loginShellPath({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: () => true, run }),
    '/from/shell',
  )
  assert.equal(calls[0]?.args[0], '-ilc')
  // The whole environment is not asked for: an exported function or a
  // multi-line value could otherwise carry a line of its own beginning PATH=.
  assert.match(String(calls[0]?.args.at(-1)), /"\$PATH"/)
  assert.doesNotMatch(String(calls[0]?.args.at(-1)), /(^|[^A-Za-z])env($|[^A-Za-z])/)

  calls.length = 0
  await loginShellPath({ platform: 'linux', env: { SHELL: '/usr/bin/fish' }, exists: () => true, run })
  assert.deepEqual(calls[0]?.args.slice(0, 3), ['-l', '-i', '-c'])
  // Fish holds PATH as a list, so it is joined there rather than interpolated.
  assert.match(String(calls[0]?.args.at(-1)), /string join : \$PATH/)

  assert.equal(await loginShellPath({ platform: 'win32', env: { SHELL: '/bin/zsh' }, run }), null)
  assert.equal(await loginShellPath({ platform: 'darwin', env: {}, run }), null)
  assert.equal(
    await loginShellPath({ platform: 'darwin', env: { SHELL: '/bin/gone' }, exists: () => false, run }),
    null,
  )
})

test('a shell that hangs or fails is no answer, and never a rejection', async () => {
  assert.equal(
    await loginShellPath({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      exists: () => true,
      run: async () => {
        throw new Error('timed out')
      },
    }),
    null,
  )
})

test('well-known folders are included only when present, newest runtime versions first', () => {
  const present = new Set([
    '/opt/homebrew/bin',
    '/Users/x/.local/bin',
    '/Users/x/.nvm/versions/node/v22.1.0/bin',
    '/Users/x/.nvm/versions/node/v25.9.0/bin',
    '/Users/x/.nvm/versions/node/v18.0.0/bin',
    '/Users/x/.nvm/versions/node/v20.0.0/bin',
  ])
  const dirs = wellKnownBinDirs({
    platform: 'darwin',
    home: '/Users/x',
    exists: (path) => present.has(path),
    list: (path) =>
      path === '/Users/x/.nvm/versions/node' ? ['v18.0.0', 'v25.9.0', 'v20.0.0', 'v22.1.0', 'other'] : [],
  })
  assert.deepEqual(dirs, [
    '/opt/homebrew/bin',
    '/Users/x/.local/bin',
    '/Users/x/.nvm/versions/node/v25.9.0/bin',
    '/Users/x/.nvm/versions/node/v22.1.0/bin',
    '/Users/x/.nvm/versions/node/v20.0.0/bin',
  ])
})

test('merging keeps the first occurrence, the order given, and drops empties', () => {
  assert.equal(mergePaths('/a:/b', ['/b', '/c', ''], null, '/a:/d'), ['/a', '/b', '/c', '/d'].join(delimiter))
})

test("the resolved PATH puts the shell's answer first and keeps what the process had", () => {
  const options = {
    platform: 'darwin' as const,
    home: '/Users/x',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', HARNESSDESK_PATH: '/Users/x/tools' },
    exists: (path: string) => path === '/opt/homebrew/bin',
    list: () => [],
  }
  const withShell = resolvePath('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin', options)
  assert.equal(
    withShell.path,
    ['/Users/x/tools', '/Users/x/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter),
  )
  assert.deepEqual(withShell.added, ['/Users/x/tools', '/Users/x/.local/bin', '/opt/homebrew/bin'])

  // With no answer from the shell, the machine's own folders still stand.
  const without = resolvePath(null, options)
  assert.equal(without.path, ['/Users/x/tools', '/usr/bin', '/bin', '/opt/homebrew/bin'].join(delimiter))
  assert.equal(without.shell, null)
})

test('the profile files stamped are the ones that shell actually reads', () => {
  const zsh = profileFiles('/bin/zsh', '/Users/x')
  assert.ok(zsh.includes('/Users/x/.zshrc') && zsh.includes('/Users/x/.zshenv'))
  assert.ok(zsh.includes('/etc/paths'), 'macOS builds PATH from /etc/paths before any profile runs')
  assert.ok(zsh.includes('/bin/zsh'), 'a changed shell is a changed answer')
  assert.ok(profileFiles('/usr/bin/fish', '/Users/x').includes('/Users/x/.config/fish/config.fish'))
  assert.ok(profileFiles('/bin/bash', '/Users/x').includes('/Users/x/.bash_profile'))
})

test('an unchanged setup is never asked twice, and the app never waits on the shell', async () => {
  await withPath('/usr/bin:/bin', async () => {
    const asked: string[] = []
    let stored: PathCache | null = null
    const options = {
      platform: 'darwin' as const,
      home: '/Users/x',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      exists: (path: string) => path === '/bin/zsh',
      list: () => [],
      stampOf: (path: string) => (path === '/Users/x/.zshrc' ? 111 : null),
      cache: {
        read: () => stored,
        write: (entry: PathCache) => {
          stored = entry
        },
      },
      run: async (shell: string) => {
        asked.push(shell)
        return `${DELIM}/from/shell:/usr/bin${DELIM}`
      },
    }

    // First launch: nothing remembered, so the shell is asked — but the PATH
    // in force before it answers is already the machine's own, not a stall.
    const first = applyLoginShellPath(options)
    assert.equal(first.applied.shell, null, 'what is applied at once owes nothing to the shell')
    // The PATH in force the moment the call returns is the machine's own:
    // nothing has waited for the profile to be sourced. (The shell has been
    // *reached* by now — `run` is async — but not waited on.)
    assert.ok(!process.env['PATH']?.includes('/from/shell'), 'the process did not wait for the shell')
    const refined = await first.settled
    assert.equal(asked.length, 1)
    assert.ok(refined.path.startsWith('/from/shell'), "the shell's own order wins once it lands")
    assert.deepEqual(stored, { shell: '/bin/zsh', stamps: { '/Users/x/.zshrc': 111 }, path: '/from/shell:/usr/bin' })

    // Second launch, nothing touched: the remembered answer, no subprocess.
    const second = applyLoginShellPath(options)
    assert.equal(asked.length, 1, 'the shell was not asked again')
    assert.ok(second.applied.path.startsWith('/from/shell'))
    await second.settled

    // The profile is edited: the answer is no longer trusted.
    const edited = applyLoginShellPath({ ...options, stampOf: () => 222 })
    await edited.settled
    assert.equal(asked.length, 2)
  })
})

test('a shell that never answers leaves the machine PATH standing, and settles anyway', async () => {
  await withPath('/usr/bin:/bin', async () => {
    const applied = applyLoginShellPath({
      platform: 'darwin',
      home: '/Users/x',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      exists: (path) => path === '/bin/zsh' || path === '/opt/homebrew/bin',
      list: () => [],
      stampOf: () => null,
      cache: { read: () => null, write: () => {} },
      run: async () => {
        throw new Error('the profile hung and the probe was killed')
      },
    })
    // Homebrew is on the applied PATH before any shell has spoken.
    assert.ok(applied.applied.path.includes('/opt/homebrew/bin'))
    const settled = await applied.settled
    assert.equal(settled.path, applied.applied.path)
    assert.equal(process.env['PATH'], applied.applied.path)
  })
})

test('the cache is only trusted for the shell it was written from', async () => {
  await withPath('/usr/bin', async () => {
    const stored: PathCache = { shell: '/bin/bash', stamps: {}, path: '/from/bash' }
    let asked = 0
    const applied = applyLoginShellPath({
      platform: 'darwin',
      home: '/Users/x',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
      exists: (path) => path === '/bin/zsh',
      list: () => [],
      stampOf: () => null,
      cache: { read: () => stored, write: () => {} },
      run: async () => {
        asked += 1
        return `${DELIM}/from/zsh${DELIM}`
      },
    })
    assert.ok(!applied.applied.path.includes('/from/bash'), "another shell's answer is not this shell's")
    await applied.settled
    assert.equal(asked, 1)
  })
})
