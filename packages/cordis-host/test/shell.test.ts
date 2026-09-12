import assert from 'node:assert/strict'
import test from 'node:test'

import { ExtensionKernel, type HarnessPlugin } from '../src/index.js'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))


test('a command that never finished is not exit 1, and says why (#161)', { skip: process.platform === 'win32' }, async (t) => {
  // Stopped at the timeout, cut off past the output limit, never started: each came back as exit 1 with
  // nothing said, which to ripgrep and grep means "nothing found".
  type Shell = { run(command: string, args?: string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> }
  let shell: Shell | null = null
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({
    manifest: { id: 'sheller', name: 'Sheller', permissions: { shell: true } },
    plugin: {
      name: 'sheller',
      inject: ['shell'],
      apply(ctx: any) {
        shell = ctx.shell
      },
    },
  } as HarnessPlugin)
  await settle()
  const run = (command: string, args: string[] = [], options: { timeoutMs?: number } = {}) => shell!.run(command, args, options)
  const stopped = await run('sleep', ['5'], { timeoutMs: 100 })
  assert.equal(stopped.exitCode, -1)
  assert.match(stopped.stderr, /stopped after 0\.1 s/)
  const flooded = await run('head', ['-c', '17000000', '/dev/zero'])
  assert.equal(flooded.exitCode, -1)
  assert.match(flooded.stderr, /passed 16 MB and was cut there/)
  const missing = await run('no-such-command-harnessdesk')
  assert.equal(missing.exitCode, -1)
  assert.match(missing.stderr, /ENOENT/)
  // Review of #239, round 1: named, so a sentence about it says what stopped. By its first argument too when
  // that is a word, a subcommand; never one that could carry a value, as `5` or a path or a URL could.
  assert.match(stopped.stderr, /^sleep stopped after 0\.1 s$/m)
  assert.match((await run('yes', ['word'])).stderr, /^yes word's output passed 16 MB and was cut there$/m)
  // A child that traps SIGTERM exits with its own code, 0 included, and is still a command cut off at its deadline.
  const trapped = await run('sh', ['-c', 'trap "exit 7" TERM; sleep 5 >/dev/null 2>&1 & wait'], { timeoutMs: 150 })
  assert.equal(trapped.exitCode, -1)
  assert.match(trapped.stderr, /^sh stopped after 0\.15 s$/m)
  const quiet = await run('sh', ['-c', 'trap "exit 0" TERM; sleep 5 >/dev/null 2>&1 & wait'], { timeoutMs: 150 })
  assert.equal(quiet.exitCode, -1)
  assert.match(quiet.stderr, /^sh stopped after 0\.15 s$/m)
  // A signal that is not the deadline's is said once, by name, after the child's own words.
  const crashed = await run('sh', ['-c', 'echo boom >&2; kill -SEGV $$'])
  assert.equal(crashed.exitCode, -1)
  assert.equal(crashed.stderr, 'boom\nsh was killed by SIGSEGV')
  // The control: a command's own exit keeps its number.
  assert.equal((await run('sh', ['-c', 'exit 1'])).exitCode, 1)
  assert.equal((await run('sh', ['-c', 'exit 2'])).exitCode, 2)
})
