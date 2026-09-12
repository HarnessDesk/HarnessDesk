import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import type {
  CapabilityContribution,
  CapabilityRegistry,
  ContributionId,
  ContributionKind,
  ExtensionEvent,
  HookInvocation,
  HookVerdict,
  PluginInstance,
  ScopeQuery,
  SessionSummary,
  ToolResult,
} from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * What a page of conversations costs to name.
 *
 * `automaticContext` walks the context registry and builds a `Set` of the
 * labels this adapter prepends itself, so a conversation is never listed
 * under the adapter's own `Git` block (#231). It is cheap once. Every
 * producer of a preview built its own — one per row of a listing, two per
 * live row — which is the same answer arrived at forty times for a page of
 * forty (#274).
 *
 * These tests count the walks rather than compare the rows. A test that only
 * compared rows would pass just as happily against the code that walked the
 * registry once per row, because the answer was never wrong; only the bill
 * was.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

/**
 * The kernel, with a tally of what the adapter asked of it.
 *
 * `automaticContext` is the only thing in this adapter that lists `context`
 * contributions, so a count of those calls is a count of predicates built.
 * Every answer here is the kernel's own, so the rows these tests see are the
 * rows the real registry produces.
 */
class CountingRegistry implements CapabilityRegistry {
  contextLists = 0

  constructor(private readonly inner: CapabilityRegistry) {}

  list<K extends ContributionKind>(
    kind: K,
    query: ScopeQuery = {},
  ): readonly Extract<CapabilityContribution, { kind: K }>[] {
    if (kind === 'context') this.contextLists += 1
    return this.inner.list(kind, query)
  }

  plugins(): readonly PluginInstance[] {
    return this.inner.plugins()
  }

  invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    return this.inner.invokeTool(id, args, scope)
  }

  runHooks(invocation: HookInvocation): Promise<HookVerdict> {
    return this.inner.runHooks(invocation)
  }

  resolveContext(query: ScopeQuery): Promise<readonly { label: string; text: string }[]> {
    return this.inner.resolveContext(query)
  }

  subscribe(listener: (event: ExtensionEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

/**
 * A runtime seated on a counting registry that holds one non-chip context
 * provider — the `Git` block, registered the way the branch plugin registers
 * it. The tally starts at zero once the runtime is up, so what each test
 * counts is what the call under it asked for.
 */
const seated = async (
  t: { after(fn: () => unknown): void },
): Promise<{ runtime: CodexRuntime; counter: CountingRegistry; kernel: ExtensionKernel }> => {
  const kernel = new ExtensionKernel()
  await kernel.load({
    manifest: { id: 'branch', name: 'branch' },
    plugin: {
      name: 'branch',
      inject: ['context'],
      apply: (ctx: {
        context: { register(entry: { label: string; resolve: () => Promise<string> }): void }
      }) => ctx.context.register({ label: 'Git', resolve: async () => 'On branch main.' }),
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const counter = new CountingRegistry(kernel)
  const runtime = new CodexRuntime({
    binaryPath: FAKE,
    clientName: 'harnessdesk-test',
    capabilities: counter,
  })
  t.after(async () => {
    await runtime.dispose()
    await kernel.dispose()
  })
  await runtime.start()
  counter.contextLists = 0
  return { runtime, counter, kernel }
}

const previewOf = (rows: readonly SessionSummary[], id: string): string | null | undefined =>
  rows.find((row) => String(row.id) === id)?.preview

test('a listed page builds one predicate, not one per conversation on it (#274)', async (t) => {
  const { runtime, counter } = await seated(t)

  const listed = await runtime.listSessions({ pageSize: 10 })

  // Controls first, so that a mutation which changes only the count fails on
  // the count. thread-4 opens with the adapter's own Git block ahead of the
  // person's chip and is named after the chip; thread-e2e is named after the
  // person's own words. Both say the one predicate reached every row.
  assert.equal(listed.data.length, 4, 'control: the page really did carry four rows')
  assert.equal(previewOf(listed.data, 'thread-4'), 'Uncommitted changes')
  assert.equal(previewOf(listed.data, 'thread-e2e'), 'List the files here.')
  assert.equal(counter.contextLists, 1, 'one walk of the registry for the page, not one per row')
})

test('a search page builds one predicate, not one per hit (#274)', async (t) => {
  const { runtime, counter } = await seated(t)

  const found = await runtime.searchSessions('thread')

  assert.equal(found.data.length, 4, 'control: every stored thread matched the term')
  assert.equal(
    previewOf(found.data, 'thread-4'),
    'Uncommitted changes',
    'control: the one predicate still reached the hits',
  )
  assert.equal(counter.contextLists, 1, 'one walk of the registry for the page of hits')
})

test('a live row builds one predicate, not one per field it fills (#274)', async (t) => {
  const { runtime, counter } = await seated(t)
  const session = await runtime.createSession({ cwd: '/w' })
  counter.contextLists = 0

  const row = (session as unknown as { summary(): SessionSummary }).summary()

  // Controls: the row a working conversation is listed under is unchanged.
  assert.equal(row.title, null)
  assert.equal(row.preview, null, 'a thread that has said nothing yet has no opening to show')
  assert.equal(row.cwd, '/w')
  assert.equal(row.status.type, 'idle')
  assert.equal(row.git?.branch, 'main')
  assert.equal(counter.contextLists, 1, 'one walk of the registry for the row, not one per field')
})

test('a page with a working conversation on it walks the registry twice (#274)', async (t) => {
  const { runtime, counter } = await seated(t)
  await runtime.createSession({ cwd: '/w' })
  counter.contextLists = 0

  const listed = await runtime.listSessions({ pageSize: 10 })

  assert.equal(listed.data.length, 4, 'control: the live row was laid over its stored one')
  assert.equal(counter.contextLists, 2, 'one walk for the stored page, one for the live row')
})

test('the predicate is built per invocation, so an unloaded plugin is seen at once (#274)', async (t) => {
  /* The boundary of the fix. Hoisting it out of a `map` is safe because the
     registry cannot change while that `map` runs; keeping it between two
     calls is not, because a plugin can be enabled or disabled while the
     runtime is up, and a conversation would go on being named after a block
     nothing adds any more. */
  const { runtime, counter, kernel } = await seated(t)

  const before = await runtime.listSessions({ pageSize: 10 })
  assert.equal(
    previewOf(before.data, 'thread-4'),
    'Uncommitted changes',
    'control: the adapter’s own Git block is skipped while the plugin is loaded',
  )

  await kernel.unload('branch')
  // The contributions go with the plugin's fiber. Wait for the store to say
  // so rather than for a fixed number of milliseconds; read the kernel
  // directly, so waiting does not count towards what the adapter asked for.
  const deadline = Date.now() + 5_000
  while (kernel.list('context', {}).length > 0) {
    if (Date.now() > deadline) throw new Error('the context contribution outlived its plugin')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const after = await runtime.listSessions({ pageSize: 10 })

  assert.equal(
    previewOf(after.data, 'thread-4'),
    'Git',
    'nothing prepends that block now, so the conversation is named by it again',
  )
  assert.equal(counter.contextLists, 2, 'one walk per listing — hoisted within a call, never kept across two')
})
