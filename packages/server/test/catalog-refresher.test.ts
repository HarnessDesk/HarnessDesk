import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import type {
  AgentRuntime,
  CatalogRefresh,
  InstallationCheck,
  RuntimeHealth,
} from '@harnessdesk/protocol'

import { CatalogRefresher } from '../src/catalog-refresher.js'

/**
 * The schedule that keeps every runtime's "what do you offer?" current. The
 * runtimes are stubs: what is under test is the order of the two calls, the
 * skip after a restart, isolation between runtimes, and that concurrent
 * asks share one run.
 */

const stub = (
  id: string,
  behaviour: {
    health?: RuntimeHealth
    check?: () => Promise<InstallationCheck>
    refresh?: () => Promise<CatalogRefresh>
  } = {},
): AgentRuntime & { calls: string[] } => {
  const calls: string[] = []
  const runtime = {
    calls,
    info: { id, name: id, capabilities: {}, presentation: { name: id } },
    health: () => behaviour.health ?? { state: 'ready' },
    ...(behaviour.check
      ? {
          checkInstallation: async () => {
            calls.push('check')
            return behaviour.check!()
          },
        }
      : {}),
    ...(behaviour.refresh
      ? {
          refreshCatalog: async () => {
            calls.push('refresh')
            return behaviour.refresh!()
          },
        }
      : {}),
  }
  return runtime as unknown as AgentRuntime & { calls: string[] }
}

/**
 * Move the mocked clock, then let whatever the tick started finish. A tick
 * fires its callback synchronously and the work behind it is a promise chain,
 * so yielding once to the real macrotask queue drains it — no wall clock, and
 * nothing to be slow enough to miss.
 */
const tick = async (t: TestContext, ms: number): Promise<void> => {
  t.mock.timers.tick(ms)
  await new Promise((resolve) => setImmediate(resolve))
}

test('a tick checks the installation first, then refreshes the catalogue', async () => {
  const runtime = stub('a', { check: async () => ({ changed: false }), refresh: async () => ({ refreshed: true }) })
  const seen: string[] = []
  const refresher = new CatalogRefresher({ now: () => 1234, onChecked: (id) => seen.push(id) })
  refresher.watch(runtime)
  const result = await refresher.refresh('a' as never)
  assert.deepEqual(runtime.calls, ['check', 'refresh'])
  assert.deepEqual(result, { checkedAt: 1234, installation: { changed: false }, refreshed: true })
  assert.equal(refresher.lastChecked('a' as never), 1234)
  assert.deepEqual(seen, ['a'])
})

test('a restart onto a new build makes the refresh redundant, and is reported', async () => {
  const moved: InstallationCheck = { changed: true, from: '1.0.0', to: '2.0.0', restarted: true }
  const runtime = stub('a', { check: async () => moved, refresh: async () => ({ refreshed: true }) })
  const refresher = new CatalogRefresher()
  refresher.watch(runtime)
  const result = await refresher.refresh('a' as never)
  assert.deepEqual(runtime.calls, ['check'])
  assert.equal(result.installation, moved)
  assert.equal(result.refreshed, true)
})

test('a change the runtime could not act on still gets the catalogue re-read', async () => {
  const busy: InstallationCheck = { changed: true, from: '1.0.0', to: '2.0.0', restarted: false }
  const runtime = stub('a', { check: async () => busy, refresh: async () => ({ refreshed: true }) })
  const refresher = new CatalogRefresher()
  refresher.watch(runtime)
  await refresher.refresh('a' as never)
  assert.deepEqual(runtime.calls, ['check', 'refresh'])
})

test('a runtime that declares neither method is simply checked-at; one that is down is left alone', async () => {
  const bare = stub('bare')
  const down = stub('down', {
    health: { state: 'unavailable', reason: 'crashed', message: 'gone' },
    refresh: async () => ({ refreshed: true }),
  })
  const refresher = new CatalogRefresher({ now: () => 7 })
  refresher.watch(bare)
  refresher.watch(down)
  await refresher.refreshAll()
  // Both answer `refreshed: false`, and each says which kind of nothing it
  // was: a caller relaying this to a person cannot use the flag alone.
  assert.deepEqual(await refresher.refresh('bare' as never), {
    checkedAt: 7,
    installation: null,
    refreshed: false,
    reason: 'It does not re-read its catalogue on request.',
  })
  const asked = await refresher.refresh('down' as never)
  assert.equal(asked.refreshed, false)
  assert.match(asked.reason ?? '', /not running/)
  assert.deepEqual(down.calls, [])
})

test('one runtime failing never stops another from being asked', async () => {
  const failing = stub('f', {
    check: async () => {
      throw new Error('probe exploded')
    },
    refresh: async () => {
      throw new Error('list exploded')
    },
  })
  const fine = stub('ok', { refresh: async () => ({ refreshed: true }) })
  const logged: string[] = []
  const refresher = new CatalogRefresher({ log: (message) => logged.push(message) })
  refresher.watch(failing)
  refresher.watch(fine)
  await refresher.refreshAll()
  assert.deepEqual(fine.calls, ['refresh'])
  assert.deepEqual(failing.calls, ['check', 'refresh'])
  assert.deepEqual(logged, ['installation check failed', 'catalog refresh failed'])
})

test('concurrent asks for one runtime share a single run', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = stub('a', { refresh: () => gate.then(() => ({ refreshed: true })) })
  const refresher = new CatalogRefresher()
  refresher.watch(runtime)
  const first = refresher.refresh('a' as never)
  const second = refresher.refresh('a' as never)
  release()
  await Promise.all([first, second])
  assert.deepEqual(runtime.calls, ['refresh'])
  // And once it is over, the next ask runs again.
  await refresher.refresh('a' as never)
  assert.deepEqual(runtime.calls, ['refresh', 'refresh'])
})

test('the timer ticks on its interval and stops cleanly', async (t) => {
  /* The clock is driven by hand, and the count is exact.
     What this replaces started a 15ms interval, slept 60ms of wall clock and
     asked for "at least two" ticks — a bet that the event loop would be free
     enough to deliver them. Under the full suite in parallel it came back with
     one, which says nothing about the schedule and everything about the
     machine. Widening the window would only have made the same bet at longer
     odds. */
  t.mock.timers.enable({ apis: ['setInterval'] })
  const runtime = stub('a', { refresh: async () => ({ refreshed: true }) })
  const refresher = new CatalogRefresher({ intervalMs: 15 })
  refresher.watch(runtime)
  refresher.start()

  await tick(t, 14)
  assert.deepEqual(runtime.calls, [], 'nothing before the interval is up')
  await tick(t, 1)
  assert.deepEqual(runtime.calls, ['refresh'])
  await tick(t, 15)
  await tick(t, 15)
  assert.deepEqual(runtime.calls, ['refresh', 'refresh', 'refresh'], 'one per interval')

  refresher.stop()
  await tick(t, 15 * 100)
  assert.deepEqual(runtime.calls, ['refresh', 'refresh', 'refresh'], 'no ticks after stop')
})

/**
 * A runtime that has just come up has just declared its catalogue. Left with
 * no timestamp, the renderer read "never checked" as "stale" and restarted
 * every idle agent the first time the window came back into focus after
 * launch — which is how every room lost its members on the first alt-tab.
 */
test('a runtime just watched counts as checked now, so the first focus-return does not restart it', () => {
  const refresher = new CatalogRefresher({ now: () => 4321 })
  refresher.watch(stub('fresh'))
  assert.equal(refresher.lastChecked('fresh' as never), 4321)
  // Forgetting and watching again is a fresh process, checked again now.
  refresher.forget('fresh' as never)
  assert.equal(refresher.lastChecked('fresh' as never), null)
})

/**
 * `Host.dispose()` is the only caller of `stop()`, so stopping means quitting.
 * Clearing the interval only stops the *next* tick; a caller arriving during
 * the shutdown — the menu's "Refresh models" as the window goes — would still
 * be answered, and every answer here can end in a restarted agent. The
 * runtimes refuse that spawn themselves, which is where the invariant lives
 * (see `adapter-acp/test/dispose.test.ts`); this is the schedule not asking
 * for it in the first place.
 */
test('after stop nothing new is asked, and the answer says why', async () => {
  const runtime = stub('a', {
    check: async () => ({ changed: false }),
    refresh: async () => ({ refreshed: true }),
  })
  let clock = 9
  const refresher = new CatalogRefresher({ now: () => clock })
  refresher.watch(runtime)
  refresher.stop()

  clock = 99
  assert.deepEqual(await refresher.refresh('a' as never), {
    checkedAt: 99,
    installation: null,
    refreshed: false,
    reason: 'HarnessDesk is shutting down.',
  })
  await refresher.refreshAll()
  assert.deepEqual(runtime.calls, [], 'the runtime was never reached')
  assert.equal(refresher.lastChecked('a' as never), 9, 'and nothing was recorded as checked')

  // Stopped is a state, not a death: started again, it asks again.
  refresher.start()
  assert.deepEqual(await refresher.refresh('a' as never), {
    checkedAt: 99,
    installation: { changed: false },
    refreshed: true,
  })
  assert.deepEqual(runtime.calls, ['check', 'refresh'])
  refresher.stop()
})

/**
 * One run, one answer.
 *
 * `stop()` does not abort a refresh that has already reached the agent, so
 * during a quit a caller can arrive while one is genuinely in flight. Handing
 * it the shutdown sentence would be two callers getting two different stories
 * about one runtime — and the one who got the refusal would be told nothing
 * was happening while an agent was mid-restart. Only a caller with nothing to
 * join is turned away.
 */
test('a caller that arrives after stop joins a run that is still going', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = stub('a', { refresh: () => gate.then(() => ({ refreshed: true })) })
  const refresher = new CatalogRefresher({ now: () => 5 })
  refresher.watch(runtime)

  const inFlight = refresher.refresh('a' as never)
  refresher.stop()
  const joined = refresher.refresh('a' as never)
  release()

  assert.deepEqual(await joined, await inFlight, 'the same run answered both')
  assert.deepEqual((await joined).refreshed, true, 'and it is the real answer, not the refusal')
  assert.deepEqual(runtime.calls, ['refresh'], 'one run, not two')

  // A runtime with nothing in flight is still refused.
  refresher.watch(stub('b', { refresh: async () => ({ refreshed: true }) }))
  const refused = await refresher.refresh('b' as never)
  assert.equal(refused.refreshed, false)
  assert.match(refused.reason ?? '', /shutting down/)
})

test('a runtime that declines to re-read is reported as such, not as a success', async () => {
  // The case that mattered: an ACP agent refreshes by restarting and will not
  // do it with a turn in flight. It resolves — politely, and without having
  // looked at anything. Reading "it resolved" as "it re-read" is what let the
  // library tell somebody a refusal was a refresh.
  const runtime = stub('a', {
    refresh: async () => ({ refreshed: false, reason: 'A turn is in flight.' }),
  })
  const refresher = new CatalogRefresher({ now: () => 7 })
  refresher.watch(runtime)
  const result = await refresher.refresh('a' as never)
  assert.deepEqual(result, {
    checkedAt: 7,
    installation: null,
    refreshed: false,
    reason: 'A turn is in flight.',
  })
})

