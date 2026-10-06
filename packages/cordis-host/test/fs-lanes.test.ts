import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { ExtensionKernel, setEditorEngine, type HarnessContext, type HarnessPlugin } from '../src/index.js'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))
const missing = async (path: string): Promise<boolean> => stat(path).then(() => false, () => true)

type Probe = { delay?: boolean; read?: string; write?: string; open?: string; cwd?: string }

/** One tool that reports, through every workspace capability, where its call ran. */
const probePlugin = {
  manifest: { id: 'fs-lanes', name: 'File lanes', permissions: { workspace: { read: true, write: true }, editor: true, shell: true } },
  plugin: {
    name: 'fs-lanes', inject: ['tools', 'fs', 'workspace', 'harness', 'editor', 'shell'],
    apply(ctx: HarnessContext) {
      ctx.tools.register({
        name: 'probe', description: '', inputSchema: { type: 'object' },
        execute: async (args: Probe) => {
          if (args.delay) await new Promise((resolve) => setTimeout(resolve, 40))
          if (args.read !== undefined) return await ctx.fs.read(args.read)
          if (args.write !== undefined) {
            await ctx.fs.write(args.write, basename(ctx.workspace.root ?? ''))
            return 'written'
          }
          if (args.cwd !== undefined) return (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: args.cwd })).stdout
          if (args.open !== undefined) {
            await ctx.editor.open(args.open)
            await ctx.editor.decorate(args.open, [])
            return 'opened'
          }
          return JSON.stringify({
            root: basename(ctx.workspace.root ?? ''),
            harness: basename(ctx.harness.workspaceRoot ?? ''),
            branch: ctx.workspace.branch,
            brief: await ctx.fs.read('brief.md'),
            names: (await ctx.fs.list('.')).map((entry) => entry.name).sort(),
            hasOne: await ctx.fs.exists('only-one.md'),
          })
        },
      })
    },
  },
} as unknown as HarnessPlugin

const probing = async (kernel: ExtensionKernel) => {
  await kernel.load(probePlugin)
  await settle()
  const id = kernel.list('tool')[0]!.id
  const run = (workspaceRoot: string | undefined, args: Probe = {}) => kernel.invokeTool(id, args, workspaceRoot ? { workspaceRoot } : {})
  const answer = async (workspaceRoot: string | undefined, args: Probe = {}) => {
    const result = await run(workspaceRoot, args)
    if (!result.ok) assert.fail(result.error)
    const part = result.content[0]
    if (part?.type !== 'text') assert.fail('the probe answers in text')
    return JSON.parse(part.text)
  }
  return { run, answer }
}

/** A folder per name under one real temp root, each with the same relative name and contents of its own. */
const folders = async (t: { after: (fn: () => unknown) => void }, ...names: string[]) => {
  // The real path: the host admits a call's checkout by its real path (macOS's /var is a link).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hd-fs-lanes-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of names) {
    const folder = join(root, name)
    await mkdir(folder, { recursive: true })
    // The same relative name in every folder with different contents, and one file only that folder has: a read, a
    // listing or an existence check answered from the wrong folder shows in the answer.
    await writeFile(join(folder, 'brief.md'), `${basename(folder)} brief`)
    await writeFile(join(folder, `only-${basename(folder)}.md`), '')
  }
  return root
}

test('a tool call reads, lists, writes, shows and names the root of its own checkout, and stays inside it', async (t) => {
  const root = await folders(t, 'project', 'one', 'two')
  const [project, one, two] = ['project', 'one', 'two'].map((name) => join(root, name)) as [string, string, string]
  const shown: string[] = []
  setEditorEngine({
    open: async (path: string) => { shown.push(`open ${path}`) },
    decorate: async (path: string) => { shown.push(`decorate ${path}`) },
    close: async () => {},
    applyEdits: async () => ({ hash: '' }),
    drain: async () => [],
  })
  const kernel = new ExtensionKernel()
  t.after(() => {
    kernel.dispose()
    setEditorEngine(null)
  })
  kernel.setWorkspace({ root: project, branch: 'main' })
  const { run, answer } = await probing(kernel)

  // Two seats at once, each in its own checkout, while the desk has a third folder open. The first is still working
  // when the second starts, so a root shared between calls would hand the first the second's answers.
  const [first, second] = await Promise.all([answer(one, { delay: true }), answer(two)])
  // The branch is a fact about the open folder only: unknown in another checkout, as context resolution reports it.
  assert.deepEqual(first, { root: 'one', harness: 'one', branch: null, brief: 'one brief', names: ['brief.md', 'only-one.md'], hasOne: true })
  assert.deepEqual(second, { root: 'two', harness: 'two', branch: null, brief: 'two brief', names: ['brief.md', 'only-two.md'], hasOne: false })

  // A write lands in the caller's checkout, never in the open workspace.
  assert.deepEqual(await run(one, { write: 'note.md' }), { ok: true, content: [{ type: 'text', text: 'written' }] })
  assert.equal(await readFile(join(one, 'note.md'), 'utf8'), 'one')
  assert.equal(await missing(join(project, 'note.md')), true)

  // The editor shows the caller's file, so a seat working in its own clone puts that clone's file in front of the
  // person; with no checkout it is the open workspace's, as before.
  assert.deepEqual(await run(one, { open: 'brief.md' }), { ok: true, content: [{ type: 'text', text: 'opened' }] })
  assert.deepEqual(await run(undefined, { open: 'brief.md' }), { ok: true, content: [{ type: 'text', text: 'opened' }] })
  assert.deepEqual(shown, [
    `open ${join(one, 'brief.md')}`, `decorate ${join(one, 'brief.md')}`,
    `open ${join(project, 'brief.md')}`, `decorate ${join(project, 'brief.md')}`,
  ])

  // The caller's checkout is the boundary, for reading, writing and showing: the open workspace and a sibling are
  // outside it, and the refusal names the checkout the call runs in rather than the desk's folder.
  for (const path of [join(two, 'brief.md'), '../two/brief.md', join(project, 'brief.md')]) {
    for (const args of [{ read: path }, { write: path.replace('brief.md', 'escaped.md') }, { open: path }, { cwd: path }]) {
      const refused = await run(one, args)
      assert.equal(refused.ok, false, JSON.stringify(args))
      assert.match(refused.ok ? '' : refused.error, /is outside the checkout this call runs in$/)
    }
  }
  const outside = await run(undefined, { read: join(two, 'brief.md') })
  assert.match(outside.ok ? '' : outside.error, /is outside the open workspace$/)
  assert.equal(await missing(join(two, 'escaped.md')), true)
  assert.equal(await missing(join(project, 'escaped.md')), true)
  assert.equal(shown.length, 4)

  // A call whose checkout is the open folder knows its branch; a call with no checkout is the open workspace, as before.
  assert.equal((await answer(project)).branch, 'main')
  assert.deepEqual(await answer(undefined), { root: 'project', harness: 'project', branch: 'main', brief: 'project brief', names: ['brief.md', 'only-project.md'], hasOne: false })
})

test('a call admitted to the checkout of the open folder runs in that folder as it was opened', async (t) => {
  const root = await folders(t, 'repo', join('repo', 'app'), 'linked', 'other')
  const [repo, app, linked, other] = ['repo', join('repo', 'app'), 'linked', 'other'].map((name) => join(root, name)) as [string, string, string, string]
  const alias = join(root, 'alias')
  await symlink(repo, alias)
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  // As the host admits it: a Seat's own checkout when the conversation has one, and otherwise the open project's main
  // checkout by its real path, which is the repository itself for a folder opened inside it.
  let admitted = repo
  kernel.setShellWorkspaceResolver(async (scope) => scope.workspaceRoot ?? admitted)
  const { answer } = await probing(kernel)
  const opened = { root: 'repo', harness: 'repo', branch: 'main', brief: 'repo brief', names: ['app', 'brief.md', 'only-repo.md'], hasOne: false }

  // Reached through a link: the call is admitted to the real path, and still runs in the folder as opened.
  kernel.setWorkspace({ root: alias, branch: 'main', admitted: [repo, repo] })
  assert.deepEqual(await answer(undefined), { ...opened, root: 'alias', harness: 'alias' })
  // A host that lists nothing still counts the open folder's own real path.
  kernel.setWorkspace({ root: alias, branch: 'main' })
  assert.deepEqual(await answer(undefined), { ...opened, root: 'alias', harness: 'alias' })

  // Opened at a subfolder: the call is admitted to the repository, and relative paths still resolve from the subfolder.
  kernel.setWorkspace({ root: app, branch: 'main', admitted: [repo, repo] })
  assert.deepEqual(await answer(undefined), { root: 'app', harness: 'app', branch: 'main', brief: 'app brief', names: ['brief.md', 'only-app.md'], hasOne: false })

  // A linked worktree: a conversation with no checkout of its own is admitted to the project's main checkout, one
  // started there to the worktree; both run in the worktree, on its branch.
  kernel.setWorkspace({ root: linked, branch: 'feature', admitted: [linked, repo] })
  const worktree = { root: 'linked', harness: 'linked', branch: 'feature', brief: 'linked brief', names: ['brief.md', 'only-linked.md'], hasOne: false }
  assert.deepEqual(await answer(undefined), worktree)
  assert.deepEqual(await answer(linked), worktree)

  // Any other checkout is entered as it is, with its branch unknown.
  assert.deepEqual(await answer(other), { root: 'other', harness: 'other', branch: null, brief: 'other brief', names: ['brief.md', 'only-other.md'], hasOne: false })
  admitted = other
  assert.equal((await answer(undefined)).root, 'other')
})
