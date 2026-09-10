import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ExtensionKernel, type HarnessContext } from '@harnessdesk/cordis-host'
import { runtimeId, type ContributionId, type SessionId, type ToolResult } from '@harnessdesk/protocol'

import {
  builtinPlugins,
  callSignature,
  filesPlugin,
  htmlToText,
  recoveryHint,
  renderTodos,
  todoPlugin,
  gitPlugin,
  testsPlugin,
  guardrailsPlugin,
  searchPlugin,
  webPlugin,
} from '../src/index.js'

/**
 * The built-in plugins, exercised through the real kernel.
 *
 * Running them through `ExtensionKernel` rather than calling their `apply`
 * directly is the point: these are the tests that would catch a plugin that
 * works in isolation but registers nothing under the permission gate.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const text = (result: ToolResult): string =>
  result.ok && result.content[0]?.type === 'text' ? result.content[0].text : `!${result.ok ? '' : result.error}`

const toolNamed = (kernel: ExtensionKernel, name: string): ContributionId => {
  const found = kernel.list('tool').find((entry) => entry.name === name)
  assert.ok(found, `no tool named ${name}`)
  return found.id
}

// ---------------------------------------------------------------- pure logic

test('htmlToText drops scripts and styles rather than reading them aloud', () => {
  const html = '<html><head><style>a{}</style><script>evil()</script></head><body><p>Hello</p><p>World</p></body></html>'
  const result = htmlToText(html)
  assert.equal(result.includes('evil'), false)
  assert.equal(result.includes('a{}'), false)
  assert.match(result, /Hello/)
  assert.match(result, /World/)
})

test('htmlToText decodes entities and collapses whitespace', () => {
  assert.equal(htmlToText('<p>a &amp; b &lt;c&gt;&nbsp;d</p>'), 'a & b <c> d')
})

test('callSignature ignores key order, so a reordered repeat still counts', () => {
  assert.equal(
    callSignature('read', { path: 'a', limit: 2 }),
    callSignature('read', { limit: 2, path: 'a' }),
  )
  assert.notEqual(callSignature('read', { path: 'a' }), callSignature('read', { path: 'b' }))
  assert.notEqual(callSignature('read', { path: 'a' }), callSignature('write', { path: 'a' }))
})

test('renderTodos marks each status distinctly', () => {
  const rendered = renderTodos([
    { task: 'first', status: 'done' },
    { task: 'second', status: 'inProgress' },
    { task: 'third', status: 'pending' },
  ])
  assert.match(rendered, /\[x\] 1\. first/)
  assert.match(rendered, /\[~\] 2\. second/)
  assert.match(rendered, /\[ \] 3\. third/)
})

test('recoveryHint names a command the user can actually run', () => {
  assert.match(recoveryHint('abc123'), /git restore --source abc123/)
})

// ------------------------------------------------------------------ registry

test('every built-in plugin loads active and registers something', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  for (const plugin of builtinPlugins) await kernel.load(plugin)
  await settle()

  for (const plugin of kernel.plugins()) {
    assert.equal(
      plugin.state.type,
      'active',
      `${plugin.identity.id} is ${plugin.state.type}`,
    )
    assert.ok(
      plugin.contributions.length > 0,
      `${plugin.identity.id} contributed nothing`,
    )
  }
})

test('no built-in plugin asks for more than it needs', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  for (const plugin of builtinPlugins) await kernel.load(plugin)
  await settle()

  for (const plugin of kernel.plugins()) {
    // Nothing built in needs to write to the workspace: Codex applies its own
    // patches, and a plugin that can write is a plugin that can clobber.
    assert.equal(
      plugin.permissions.workspace.write,
      false,
      `${plugin.identity.id} requests workspace write`,
    )
    assert.notEqual(
      plugin.permissions.network.hosts.includes('*'),
      true,
      `${plugin.identity.id} requests unrestricted network access`,
    )
  }
})

// ---------------------------------------------------------------------- todo

test('a rewrite that adds an item does not reopen what is already done', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  const write = toolNamed(kernel, 'todo_write')
  await kernel.invokeTool(write, { tasks: [{ task: 'design', status: 'done' }, { task: 'build' }] }, {})

  // A model that re-sends the list to append one item, and does not repeat
  // the statuses, must not silently reopen finished work.
  const rewritten = await kernel.invokeTool(write, { tasks: ['design', 'build', 'ship'] }, {})
  assert.match(text(rewritten), /\[x\] 1\. design/)
  assert.match(text(rewritten), /\[ \] 3\. ship/)

  // An explicit status is still the model's to set, in both directions.
  const reopened = await kernel.invokeTool(write, { tasks: [{ task: 'design', status: 'pending' }] }, {})
  assert.match(text(reopened), /\[ \] 1\. design/)
})

test('the task list is contributed as context only when it has items', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  assert.deepEqual(await kernel.resolveContext({}), [], 'empty list adds nothing to the turn')

  await kernel.invokeTool(toolNamed(kernel, 'todo_write'), { tasks: ['ship it'] }, {})
  const context = await kernel.resolveContext({})
  assert.equal(context.length, 1)
  assert.match(context[0]?.text ?? '', /ship it/)
})

// ---------------------------------------------------------------- guardrails

test('repeated identical calls escalate to the user, once', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(guardrailsPlugin)
  await settle()

  const call = () =>
    kernel.runHooks({
      event: 'preToolUse',
      toolName: 'read_file',
      arguments: { path: 'a.ts' },
      scope: {},
    })

  assert.equal((await call()).decision, 'allow')
  assert.equal((await call()).decision, 'allow')
  const third = await call()
  assert.equal(third.decision, 'ask', 'the third identical call asks')

  // Asking again on every subsequent repeat would turn one loop into a stream
  // of prompts.
  assert.equal((await call()).decision, 'allow')
})

test('different arguments are not a repeat', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(guardrailsPlugin)
  await settle()

  for (const path of ['a', 'b', 'c', 'd']) {
    const verdict = await kernel.runHooks({
      event: 'preToolUse',
      toolName: 'read_file',
      arguments: { path },
      scope: {},
    })
    assert.equal(verdict.decision, 'allow')
  }
})

test('a new turn forgets the previous turn′s repeats', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(guardrailsPlugin)
  await settle()

  const call = () =>
    kernel.runHooks({ event: 'preToolUse', toolName: 'x', arguments: {}, scope: {} })
  await call()
  await call()
  assert.equal((await call()).decision, 'ask')

  await kernel.runHooks({ event: 'preTurn', scope: {} })
  assert.equal((await call()).decision, 'allow', 'asking again is the user, not a loop')
})

// ----------------------------------------------------------------------- web

test('the web plugin reaches nothing until a host is granted', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(webPlugin)
  await settle()

  const result = await kernel.invokeTool(
    toolNamed(kernel, 'fetch_url'),
    { url: 'https://example.com' },
    {},
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /not in this plugin/)
})

// -------------------------------------------------------------------- search

test('search finds real matches in a real directory', async (t) => {
  // Regression: ripgrep reads stdin when stdin is not a TTY, which it never is
  // for a spawned process. Without an explicit search path every query returned
  // "No matches" while looking completely healthy.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const hasRipgrep = await promisify(execFile)('which', ['rg']).then(
    () => true,
    () => false,
  )
  if (!hasRipgrep) {
    t.skip('ripgrep is not installed on this machine')
    return
  }

  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-search-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'target.ts'), 'export const NEEDLE_TOKEN = 1\n')
  await writeFile(join(dir, 'src', 'other.md'), 'NEEDLE_TOKEN in markdown\n')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: dir, branch: null })
  await kernel.load(searchPlugin)
  await settle()

  const found = await kernel.invokeTool(
    toolNamed(kernel, 'search_text'),
    { pattern: 'NEEDLE_TOKEN' },
    {},
  )
  assert.match(text(found), /target\.ts/)

  const filtered = await kernel.invokeTool(
    toolNamed(kernel, 'search_text'),
    { pattern: 'NEEDLE_TOKEN', glob: '*.md' },
    {},
  )
  assert.match(text(filtered), /other\.md/)
  assert.equal(text(filtered).includes('target.ts'), false, 'the glob actually restricts')

  const files = await kernel.invokeTool(
    toolNamed(kernel, 'find_files'),
    { glob: '*.ts' },
    {},
  )
  assert.match(text(files), /target\.ts/)

  const missing = await kernel.invokeTool(
    toolNamed(kernel, 'search_text'),
    { pattern: 'DEFINITELY_NOT_PRESENT_XYZ' },
    {},
  )
  assert.match(text(missing), /No matches/)
})

test('the task list is one per conversation, and a write replaces the whole of it', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')
  const one = { sessionId: 's-one' as SessionId }
  const two = { sessionId: 's-two' as SessionId }

  await kernel.invokeTool(write, { tasks: [{ task: 'design' }, { task: 'build' }] }, one)
  assert.match(text(await kernel.invokeTool(read, {}, one)), /\[ \] 1\. design/)

  // The kernel is one object for the whole app. A second conversation must
  // not be looking at the first one's plan — the bug that put the previous
  // agent's list in the next agent's sidebar.
  assert.match(text(await kernel.invokeTool(read, {}, two)), /empty/)
  await kernel.invokeTool(write, { tasks: [{ task: 'ship', status: 'inProgress' }] }, two)
  assert.match(text(await kernel.invokeTool(read, {}, two)), /\[~\] 1\. ship/)
  assert.match(text(await kernel.invokeTool(read, {}, one)), /\[ \] 2\. build/)

  // One call carries the whole list with its statuses, so the transcript —
  // which is what the panel and every hand-off read — always holds the
  // current plan. A status change that lived only in the plugin left that
  // record stale from the first tick onwards.
  await kernel.invokeTool(
    write,
    { tasks: [{ task: 'design', status: 'done' }, { task: 'build', status: 'inProgress' }] },
    one,
  )
  const after = text(await kernel.invokeTool(read, {}, one))
  assert.match(after, /\[x\] 1\. design/)
  assert.match(after, /\[~\] 2\. build/)

  // And it is that conversation's list that rides along in its turns.
  const context = await kernel.resolveContext(one)
  assert.match(context.find((entry) => entry.label === 'Task list')?.text ?? '', /\[x\] 1\. design/)
  assert.deepEqual(await kernel.resolveContext({ sessionId: 's-three' as SessionId }), [])
})

test('one runtime cannot read another\u2019s list under the same session id', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')
  // Two agents can mint the same session id; every session in this codebase
  // is identified by runtime *and* id for that reason.
  const alpha = { runtime: runtimeId('alpha'), sessionId: 's-same' as SessionId }
  const beta = { runtime: runtimeId('beta'), sessionId: 's-same' as SessionId }
  await kernel.invokeTool(write, { tasks: [{ task: 'alpha\u2019s work' }] }, alpha)
  assert.match(text(await kernel.invokeTool(read, {}, beta)), /empty/)
  assert.match(text(await kernel.invokeTool(read, {}, alpha)), /alpha/)
})

test('the status words every agent actually sends are the three states', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  // Read as an exact match against three words while the panel matched
  // substrings, a task Claude Code marked `completed` — or Cursor
  // `TODO_STATUS_COMPLETED` — was drawn done and handed back still pending.
  const write = toolNamed(kernel, 'todo_write')
  const rendered = text(
    await kernel.invokeTool(
      write,
      {
        tasks: [
          { task: 'one', status: 'completed' },
          { task: 'two', status: 'TODO_STATUS_IN_PROGRESS' },
          { task: 'three', status: 'in_progress' },
          { task: 'four', status: 'TODO_STATUS_PENDING' },
        ],
      },
      {},
    ),
  )
  assert.match(rendered, /\[x\] 1\. one/)
  assert.match(rendered, /\[~\] 2\. two/)
  assert.match(rendered, /\[~\] 3\. three/)
  assert.match(rendered, /\[ \] 4\. four/)
})

test('an empty list puts the plan down; an unreadable one changes nothing', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')
  await kernel.invokeTool(write, { tasks: [{ task: 'a' }, { task: 'b' }] }, {})

  // Entries that carry no readable text are a malformed call, and emptying on
  // one would look exactly like the agent having finished.
  const refused = text(await kernel.invokeTool(write, { tasks: [{ task: { nested: 1 } }] }, {}))
  assert.match(refused, /readable text/)
  assert.match(text(await kernel.invokeTool(read, {}, {})), /\[ \] 1\. a/)

  // Sending nothing is how a plan is put down, and is honoured.
  assert.match(text(await kernel.invokeTool(write, { tasks: [] }, {})), /empty/)
  assert.match(text(await kernel.invokeTool(read, {}, {})), /empty/)
})

test('a cancelled task comes off the list, and a non-list is refused', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')

  // Kept as pending, an abandoned task reaches the next agent's hand-off as
  // work still to do.
  const rendered = text(
    await kernel.invokeTool(
      write,
      { tasks: [{ task: 'keep' }, { task: 'dropped', status: 'cancelled' }] },
      {},
    ),
  )
  assert.match(rendered, /\[ \] 1\. keep/)
  assert.equal(rendered.includes('dropped'), false)

  // The schema says a list; a bare string would otherwise come back a runtime
  // TypeError instead of something the model can act on.
  const refused = text(await kernel.invokeTool(write, { tasks: 'run the tests' }, {}))
  assert.match(refused, /has to be a list/)
  assert.match(text(await kernel.invokeTool(read, {}, {})), /\[ \] 1\. keep/)
})

test('a bare string is still a task, so a model that sends a list of them is not dropped', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()

  const write = toolNamed(kernel, 'todo_write')
  assert.match(text(await kernel.invokeTool(write, { tasks: ['one', '  ', 'two'] }, {})), /\[ \] 2\. two/)
})

test('a contribution added after load announces itself — the live-panel regression', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  /* A panel registered *after* the plugin loaded, which is the shape every
     live panel has and the one the announcement was missing. No built-in
     plugin owns a panel any more — the app's own panels are the app's — so
     the property is pinned here on a plugin written for it. */
  let show: (() => void) | null = null
  await kernel.load({
    manifest: {
      id: 'panel-fixture',
      name: 'Panel fixture',
      description: 'Registers a panel after load.',
      permissions: { ui: { contribute: true } },
    },
    plugin: {
      name: 'panel-fixture',
      inject: ['ui'],
      apply(ctx: HarnessContext) {
        show = () => {
          ctx.ui.register({
            slot: 'sidebar.panel',
            label: 'Fixture',
            component: 'hd.panel',
            data: { title: 'Fixture', blocks: [{ type: 'markdown', text: 'hello' }] },
          })
        }
      },
    },
  })
  await settle()
  assert.equal(kernel.list('ui').length, 0)

  const events: { type: string }[] = []
  kernel.subscribe((event) => events.push(event))
  assert.ok(show, 'the fixture never handed back its register')
  ;(show as unknown as () => void)()
  await settle()

  // The first installed plugin's panel was invisible because only a reload
  // ever emitted contributions/changed. A mid-life registration must announce.
  const announced = events.filter((event) => event.type === 'contributions/changed')
  assert.ok(announced.length >= 1, `expected an announcement; saw ${events.map((e) => e.type).join(', ')}`)
  const last = announced[announced.length - 1] as unknown as {
    contributions: { kind: string }[]
  }
  assert.ok(last.contributions.some((entry) => entry.kind === 'ui'))
})

test('todo_write reads the list under the key an agent uses, and a call with no list changes nothing', async (t) => {
  // #57: Claude Code and Cursor send `todos`. Read from `tasks` alone, that
  // arrived as nothing, which is how a plan is put down, and the plan was wiped.
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()
  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')
  const scope = { sessionId: 's-keys' as SessionId }
  const list = async (): Promise<string> => text(await kernel.invokeTool(read, {}, scope))

  await kernel.invokeTool(write, { tasks: ['design', 'build'] }, scope)
  await kernel.invokeTool(write, { todos: [{ task: 'design', status: 'done' }, { task: 'build', status: 'inProgress' }] }, scope)
  assert.match(await list(), /\[x\] 1\. design/)
  assert.match(await list(), /\[~\] 2\. build/)
  await kernel.invokeTool(write, { plan: [{ task: 'ship' }] }, scope)
  assert.match(await list(), /^\[ \] 1\. ship$/)

  // No list named at all is a malformed call, not a plan put down.
  assert.match(text(await kernel.invokeTool(write, {}, scope)), /takes the whole list/)
  assert.match(await list(), /^\[ \] 1\. ship$/)
  // Putting it down on purpose still works.
  await kernel.invokeTool(write, { tasks: [] }, scope)
  assert.match(await list(), /empty/)
})

test('todo_write takes the list with entries, as the Tasks panel does, and refuses one that is not a list', async (t) => {
  // Round one: an empty `tasks` beside a full `todos` put the plan down here
  // while the panel, which prefers a list with entries, showed the todos.
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()
  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')
  const scope = { sessionId: 's-precedence' as SessionId }
  const list = async (): Promise<string> => text(await kernel.invokeTool(read, {}, scope))

  await kernel.invokeTool(write, { tasks: [], todos: [{ task: 'build' }] }, scope)
  assert.match(await list(), /^\[ \] 1\. build$/)
  assert.match(text(await kernel.invokeTool(write, { todos: 'nope' }, scope)), /"todos" has to be a list/)
  assert.match(await list(), /^\[ \] 1\. build$/, 'refused, and unchanged')
  // Every list empty is the clear.
  await kernel.invokeTool(write, { tasks: [], plan: [] }, scope)
  assert.match(await list(), /empty/)
})

test('cancelling every task puts the plan down, rather than being refused as unreadable', async (t) => {
  // #58: cancelled tasks leave the list, and the readable-text check ran after they had.
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(todoPlugin)
  await settle()
  const write = toolNamed(kernel, 'todo_write')
  const read = toolNamed(kernel, 'todo_read')
  const scope = { sessionId: 's-cancel' as SessionId }

  await kernel.invokeTool(write, { tasks: ['design', 'build'] }, scope)
  const answer = text(
    await kernel.invokeTool(write, { tasks: [{ task: 'design', status: 'cancelled' }, { task: 'build', status: 'cancelled' }] }, scope),
  )
  assert.doesNotMatch(answer, /readable text/)
  assert.match(text(await kernel.invokeTool(read, {}, scope)), /empty/)

  // Entries with nothing readable are still refused, and still leave the list alone.
  await kernel.invokeTool(write, { tasks: ['ship'] }, scope)
  assert.match(text(await kernel.invokeTool(write, { tasks: [{}, 42] }, scope)), /None of those 2 entries had readable text/)
  assert.match(text(await kernel.invokeTool(read, {}, scope)), /^\[ \] 1\. ship$/)
})

// ---------------------------------------------------------------- context chips

test('git contributes chips that stay out of every turn and resolve on demand', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'hd-git-chip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'hello\n')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(gitPlugin)
  await settle()
  kernel.setWorkspace({ root: dir, branch: 'main' })

  const chips = kernel.list('context').filter((entry) => entry.chip)
  assert.deepEqual(
    chips.map((entry) => entry.label).sort(),
    ['GitHub issue or PR', 'Uncommitted changes'],
  )
  const github = chips.find((entry) => entry.label === 'GitHub issue or PR')
  assert.ok(github?.chip?.match, 'the GitHub chip matches pasted URLs')
  assert.match('https://github.com/owner/repo/issues/42', new RegExp(github!.chip!.match!))
  assert.doesNotMatch('https://github.com/owner/repo', new RegExp(github!.chip!.match!))

  // Automatic context is the branch only; the chips wait to be attached.
  const automatic = await kernel.resolveContext({})
  assert.equal(automatic.length, 1)
  assert.match(automatic[0]?.text ?? '', /on git branch/)

  const changes = chips.find((entry) => entry.label === 'Uncommitted changes')!
  const resolved = await kernel.resolveOne(changes.id, undefined, {})
  assert.equal(resolved?.label, 'Uncommitted changes')
  assert.match(resolved?.text ?? '', /a\.txt/)

  await assert.rejects(kernel.resolveOne(github!.id, '', {}), /Which issue/)
})

test('the last test run becomes a chip: nothing before a run, the verdict after', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hd-tests-chip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "console.log(\'1 passing\')"' } }),
  )

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(testsPlugin)
  await settle()
  kernel.setWorkspace({ root: dir, branch: null })

  const chip = kernel.list('context').find((entry) => entry.label === 'Last test run')
  assert.ok(chip?.chip, 'declared as a chip, never automatic context')
  // Before any run there is nothing to attach, and the error says what to do.
  await assert.rejects(kernel.resolveOne(chip!.id, undefined, {}), /No test run recorded yet/)

  const verdict = text(await kernel.invokeTool(toolNamed(kernel, 'run_tests'), {}, {}))
  assert.match(verdict, /PASS/)

  const resolved = await kernel.resolveOne(chip!.id, undefined, {})
  assert.match(resolved?.text ?? '', /Test run from just now/)
  assert.match(resolved?.text ?? '', /PASS/)
})

test('no built-in asks to write the workspace', async () => {
  // the editor-plane decision. HarnessDesk declines ACP's `fs` capability because execution
  // belongs to the agent and its own sandbox; a file write projected to every
  // agent would be that same capability re-admitted through the plugin door —
  // routing around the backend's own approval question and landing outside
  // the profile that governs the agent's own writes.
  //
  // Asserted on the *grant* rather than on tool names, because the grant is
  // what the gate actually enforces: without `workspace.write`, no tool can
  // write a file whatever it is called. (Names would also catch `todo_write`,
  // which writes a task list and no file at all.)
  //
  // Over every built-in, not `files` alone, because the way this gets lost is
  // somebody adding the capability somewhere else.
  const asking = builtinPlugins
    .filter((plugin) => plugin.manifest.permissions?.workspace?.write === true)
    .map((plugin) => plugin.manifest.id)
  assert.deepEqual(asking, [], `a built-in asks to write the workspace: ${asking.join(', ')}`)
})

test('the files built-in asks for read and not write, and offers only reads', async () => {
  assert.equal(filesPlugin.manifest.permissions?.workspace?.write, false)
  assert.equal(filesPlugin.manifest.permissions?.workspace?.read, true)

  const kernel = new ExtensionKernel()
  await kernel.load(filesPlugin)
  await settle()
  try {
    assert.deepEqual(
      kernel
        .list('tool')
        .map((entry) => entry.name)
        .sort(),
      ['list_directory', 'read_file'],
    )
  } finally {
    await kernel.dispose()
  }
})

/**
 * The README counts these, and the app's own sidebar counts them again.
 *
 * Two numbers on the front page were read off the tree once and then left:
 * "Ten built in" when there were twelve, and "36 built-in plugin tools" when
 * the browser plugin alone registers fourteen. A reader who opens the app
 * sees the real figure on the Plugins row, which makes a stale README a claim
 * the product contradicts on its first screen. Counted here so it cannot
 * drift again in silence.
 */
test('the README counts the plugins and tools that actually ship', async (t) => {
  // This file runs from `dist/test`, so walk up to the checkout root rather
  // than counting `..` against wherever it happens to be compiled.
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const up = dirname(root)
    assert.notEqual(up, root, 'ran outside the checkout')
    root = up
  }
  const readme = await readFile(join(root, 'README.md'), 'utf8')

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  for (const plugin of builtinPlugins) await kernel.load(plugin)
  await settle()

  const tools = kernel
    .plugins()
    .flatMap((plugin) => plugin.contributions)
    .filter((contribution) => contribution.kind === 'tool').length

  const spelled = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen']
  const claimed = readme.match(/\*\*Plugins\.\*\*\s+(\w+)\s+built in/)
  assert.ok(claimed, 'README no longer says how many plugins are built in')
  assert.equal(
    claimed[1],
    spelled[builtinPlugins.length - 10] ?? String(builtinPlugins.length),
    `README says "${claimed[1]} built in"; there are ${builtinPlugins.length}`,
  )

  const claimedTools = readme.match(/its (\d+) built-in plugin\s*\n?\s*tools/)
  assert.ok(claimedTools, 'README no longer says how many plugin tools there are')
  assert.equal(
    Number(claimedTools[1]),
    tools,
    `README says ${claimedTools[1]} built-in plugin tools; the kernel registers ${tools}`,
  )
})
