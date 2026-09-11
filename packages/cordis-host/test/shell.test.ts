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
  // The control: a command's own exit keeps its number.
  assert.equal((await run('sh', ['-c', 'exit 1'])).exitCode, 1)
  assert.equal((await run('sh', ['-c', 'exit 2'])).exitCode, 2)
})
