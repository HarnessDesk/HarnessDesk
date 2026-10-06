import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ExtensionKernel, type HarnessContext, type HarnessPlugin } from '../src/index.js'

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


test('shell calls keep concurrent invocation checkouts separate and confine explicit cwd to each', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-shell-lanes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const one = join(root, 'one')
  const two = join(root, 'two')
  await Promise.all([mkdir(project), mkdir(two), mkdir(join(one, 'child'), { recursive: true })])
  await symlink(two, join(one, 'escape'))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: project, branch: 'main' })
  await kernel.load({
    manifest: { id: 'shell-lanes', name: 'Shell lanes', permissions: { workspace: { read: true }, shell: true } },
    plugin: {
      name: 'shell-lanes', inject: ['tools', 'shell'],
      apply(ctx: HarnessContext) {
        ctx.tools.register({
          name: 'where', description: '', inputSchema: { type: 'object' },
          execute: async (args: { cwd?: string; delay?: boolean }) => {
            if (args.delay) await new Promise((resolve) => setTimeout(resolve, 40))
            return (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], args)).stdout
          },
        })
      },
    },
  } as HarnessPlugin)
  await settle()
  const id = kernel.list('tool')[0]!.id
  const run = (workspaceRoot: string | undefined, args = {}) => kernel.invokeTool(id, args, workspaceRoot ? { workspaceRoot } : {})
  const output = (result: Awaited<ReturnType<typeof run>>) => result.ok ? result.content : result.error
  const [first, second] = await Promise.all([run(one, { delay: true }), run(two)])
  assert.deepEqual(output(first), [{ type: 'text', text: await realpath(one) }])
  assert.deepEqual(output(second), [{ type: 'text', text: await realpath(two) }])
  assert.deepEqual(output(await run(one, { cwd: 'child' })), [{ type: 'text', text: await realpath(join(one, 'child')) }])
  for (const cwd of [project, two, '../two', 'escape']) {
    const refused = await run(one, { cwd })
    assert.equal(refused.ok, false, cwd)
    assert.match(String(output(refused)), /is outside the checkout this call runs in$/)
  }
  assert.deepEqual(output(await run(undefined)), [{ type: 'text', text: await realpath(project) }])
})


test('in-process shell refuses explicit cwd with a POSIX slash/backslash collision', { skip: process.platform === 'win32' }, async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-shell-collision-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const admitted = join(base, 'a', 'b')
  const foreign = join(base, 'a\\b')
  await Promise.all([mkdir(admitted, { recursive: true }), mkdir(foreign)])
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: admitted, branch: null })
  kernel.setShellWorkspaceResolver(async () => admitted)
  await kernel.load({
    manifest: { id: 'where', name: 'Where', permissions: { workspace: { read: true }, shell: true } },
    plugin: {
      name: 'where', inject: ['tools', 'shell'],
      apply(ctx: HarnessContext) {
        ctx.tools.register({
          name: 'where', description: '', inputSchema: { type: 'object' },
          execute: async (args: { cwd?: string }) =>
            (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], args)).stdout,
        })
      },
    },
  } as HarnessPlugin)
  await settle()
  const id = kernel.list('tool')[0]!.id
  assert.deepEqual(await kernel.invokeTool(id, { cwd: admitted }, {}), { ok: true, content: [{ type: 'text', text: admitted }] })
  const refused = await kernel.invokeTool(id, { cwd: foreign }, {})
  assert.equal(refused.ok, false, JSON.stringify(refused))
  if (!refused.ok) assert.match(refused.error, /outside the open workspace/)
})
