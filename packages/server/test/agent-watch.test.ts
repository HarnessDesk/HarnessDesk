import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { renameSync, realpathSync, symlinkSync, watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { AgentWatch, type Clock, type WatchFn } from '../src/agent-watch.js'
import { Agents } from '../src/agents.js'
import { builtinAgentRoot } from '../src/host.js'
import { Client, shippedAgentsCopy, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The roster, watched. A change under a root is a notice naming whose Agents
 * changed; a root that is not there yet is watched for; a project is watched
 * only while it is open, and never through a link that leads out of it.
 *
 * These wait on the filesystem's own notifications, so each gives the watch a
 * moment to start listening before it changes anything, and waits for what it
 * expects rather than for a fixed time wherever it can. A negative check —
 * nothing arrives — first proves the same watch is live some other,
 * legitimate way: silence is also what a watch that never started gives, and
 * only a check that could have failed is a check that proves anything.
 */

const brief = (words: string) => `---\nname: Scout\n---\n${words}\n`
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, what: string, ms = 5_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await pause(10)
  }
}
const heard = () => {
  const said: (string | null)[] = []
  return { said, changed: (project: string | null) => void said.push(project) }
}

/**
 * The longest `settleMs` any test in this file arms a watch with. `proveLive`
 * waits at least this long between two calls to `touch`, so its own retries
 * can never be the reason a burst never settles: every `#poke` a retry causes
 * pushes the pending notice back out by `settleMs`, so retrying faster than
 * that would keep the debounce resetting itself forever, on a watch that was
 * live the whole time.
 */
const LONGEST_SETTLE_MS = 400

/**
 * A watch can carry startup noise of its own — FSEvents reporting an entry
 * that was created moments before the watch attached, as if it had just
 * changed — and `proveLive`'s own retries settle on their own delay too.
 * Waited out, past every `settleMs` this file uses, before a test clears what
 * it heard and starts trusting silence, or starts counting notices exactly.
 */
const settled = () => pause(LONGEST_SETTLE_MS + 200)

/**
 * Calls `touch` once, then polls for `isHeard` without touching again — a
 * burst does not need a second nudge to settle, only time — and only tries a
 * fresh `touch` once a full settle window has passed with nothing heard.
 * Bounded overall. The proof that a watch is live, in place of a guess at how
 * long "it is probably listening by now" should be — the guess is exactly
 * what let a dead watch and a live one both pass a later check in silence.
 */
const proveLive = async (isHeard: () => boolean, touch: () => Promise<void>, what: string, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  for (;;) {
    await touch()
    const attemptEnd = Math.min(Date.now() + LONGEST_SETTLE_MS, end)
    while (!isHeard() && Date.now() <= attemptEnd) await pause(20)
    if (isHeard()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
  }
}

/** `until`, for a check that has to read something to answer. */
const untilRead = async (check: () => Promise<boolean>, what: string, ms = 5_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await pause(20)
  }
}

/**
 * The real `watch`, remembering every folder it was asked to watch — as a real
 * path, at the moment it was asked — and every one that has reported anything
 * since. A walk-up's watch on a folder above a root raises no notice until the
 * one name it waits for appears, which happens once; so its liveness is proved
 * on what the watch itself reports (`proveWatching`), and where the watch was
 * ever pointed can be checked afterwards.
 */
const recording = () => {
  const watched: string[] = []
  const reported = new Set<string>()
  const watchFn: WatchFn = (dir, options, listener) => {
    let real = dir
    try {
      real = realpathSync(dir)
    } catch {
      // Recorded as asked; the real `watch` below answers for a folder that is not there.
    }
    watched.push(real)
    return watch(dir, options, (event, filename) => {
      reported.add(real)
      listener(event, filename)
    })
  }
  return { watchFn, watched, reported }
}

/**
 * Proves the watch on `dir` itself is live: a scratch file is touched in it
 * until that watch has reported something. No walk-up waits for a name like
 * the scratch file's, so it raises no notice of its own.
 */
const proveWatching = async (probe: ReturnType<typeof recording>, dir: string, what: string): Promise<void> => {
  const real = await realpath(dir)
  let n = 0
  await proveLive(() => probe.reported.has(real), () => writeFile(join(dir, `.probe-${n++}`), ''), what)
}

/** A watcher that reports nothing on its own: for a test that says by hand what a watch reported. */
const quietWatcher = (): FSWatcher => Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher

/**
 * A clock a test moves by hand, for counting how many times a debounced
 * timer fires without betting on real time. Nothing scheduled through it
 * fires on its own — real filesystem events can land in whatever real burst
 * or trickle a loaded machine makes of them, and the pending timer they reset
 * just keeps sliding forward, since "now" never moves until `advance` says
 * so. Only once the test is sure no more real events are coming does it move
 * the clock forward in a single step, which fires whatever is due — once,
 * deterministically, the same way regardless of how unevenly the real events
 * that scheduled it arrived.
 */
const fakeClock = (): Clock & { readonly advance: (ms: number) => void } => {
  let now = 0
  const pending = new Set<{ readonly due: number; readonly callback: () => void; readonly unref: () => void }>()
  return {
    setTimeout: (callback, ms) => {
      const timer = { due: now + ms, callback, unref: () => {} }
      pending.add(timer)
      return timer
    },
    clearTimeout: (timer) =>
      void pending.delete(timer as { readonly due: number; readonly callback: () => void; readonly unref: () => void }),
    advance: (ms) => {
      now += ms
      for (;;) {
        const due = [...pending].filter((timer) => timer.due <= now).sort((a, b) => a.due - b.due)[0]
        if (!due) return
        pending.delete(due)
        due.callback()
      }
    },
  }
}

test('a change under a watched root is a notice, and a burst of them is fewer notices than changes', async (t) => {
  const root = tempDir('hd-agent-watch-')
  await mkdir(join(root, 'scout'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 400 })
  t.after(() => watch.dispose())

  // Liveness first (retried, never a bare sleep): only once a real change has
  // been heard does silence, later, mean anything.
  let n = 0
  await proveLive(() => said.length > 0, () => writeFile(join(root, 'scout', 'AGENT.md'), brief(`Ready ${n++}.`)), 'the watch to prove itself live')
  await settled()
  said.length = 0

  // Eight writes 40ms apart: close enough together that FSEvents' own folding
  // is not what is under test — the settle window is. `settleMs: 400` gathers
  // the lot into at most a couple of notices, never one per write.
  for (let i = 0; i < 8; i += 1) {
    await writeFile(join(root, 'scout', 'AGENT.md'), brief(`Look ${i}.`))
    await pause(40)
  }
  await until(() => said.length > 0, 'a notice for the burst')
  await pause(700) // longer than settleMs: catches a trailing, wrongly-separate notice
  assert.ok(said.every((one) => one === null), 'a change in this machine’s roster names no project')
  assert.ok(said.length <= 2, `${said.length} notices for 8 spaced writes`)
})

test('a root that is not there yet is watched for, and followed once it appears', async (t) => {
  const home = tempDir('hd-agent-watch-')
  const root = join(home, 'agents')
  const probe = recording()
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 30, watchFn: probe.watchFn })
  t.after(() => watch.dispose())
  // A root appearing for the first time happens once, so the ancestor watch
  // (on `home`, for the name `agents`) is proved to be listening before it is
  // made — on what that watch itself reports, rather than a guess at how long
  // it takes to attach. A change made a moment too early is simply missed.
  await proveWatching(probe, home, 'the watch on the folder above the root')
  await mkdir(join(root, 'scout'), { recursive: true })
  await until(() => said.length > 0, 'the root appearing')
  said.length = 0

  // The hand-off to the watch now on `root` itself is repeatable, so it is
  // retried until heard rather than guessed at.
  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(root, 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a change inside the root that appeared',
  )
})

test('a project is watched while it is open, named as it was opened, and not after', async (t) => {
  const project = tempDir('hd-agent-watch-project-')
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the project',
  )
  assert.ok(said.every((one) => one === project))

  await watch.watchProjects([])
  await settled()
  said.length = 0
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look again.'))
  await pause(600)
  assert.deepEqual(said, [], 'a project that is closed is not watched')
})

test("a project's Agent directory that leads out of the project is not watched", async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(join(project, '.harnessdesk'), { recursive: true })
  await mkdir(elsewhere)
  await symlink(elsewhere, join(project, '.harnessdesk', 'agents'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())

  // Liveness proved on a legitimate project in the *same* watch (F5), never
  // on the one whose link is under test: a second, ordinary project, open at
  // the same time.
  const legitimate = tempDir('hd-agent-watch-project-')
  await mkdir(join(legitimate, '.harnessdesk', 'agents', 'real'), { recursive: true })
  await watch.watchProjects([project, legitimate])
  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(legitimate, '.harnessdesk', 'agents', 'real', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the legitimate project, proving the watch is live',
  )
  await settled()
  said.length = 0

  // Now the property under test: changes at what the link points to raise nothing.
  await mkdir(join(elsewhere, 'scout'))
  await writeFile(join(elsewhere, 'scout', 'AGENT.md'), brief('Look.'))
  await pause(600)
  assert.deepEqual(said, [], 'a link leading out of the project raises no notice for what it points at')
})

/*
 * F1 — a project closed while its own follow is still in progress must end up
 * with no watcher, no matter which of `#follow`'s awaits the close lands in.
 * Forcing that landing by timing alone was the original bug's own trouble —
 * "9 of 26 timings" — so this drives it by construction instead: `onFollow`
 * fires synchronously, before `#follow`'s own first `await`, and the hook
 * closes the project from inside it. Every await after that point — direct
 * hit or walk-up, this run or the next — is downstream of a scope `#watch`
 * must refuse by the time it is reached.
 */

test('(F1) closing a project while its own follow is in progress leaves no live watcher on it', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const closing = join(root, 'closing')
  const staying = join(root, 'staying')
  await mkdir(closing, { recursive: true })
  await mkdir(join(staying, '.harnessdesk', 'agents', 'kept'), { recursive: true })
  const { said, changed } = heard()
  const watch = new AgentWatch({
    roots: [],
    changed,
    settleMs: 30,
    // The one moment `#follow` has read `#projects` and found `closing` on
    // it, before its own first await: dropping `closing` here, synchronously,
    // races every await between here and `#watch` by construction rather
    // than by luck.
    onFollow: (follow) => {
      if (follow.scope === closing) void watch.watchProjects([staying])
    },
  })
  t.after(() => watch.dispose())

  // `staying` is opened and proven live (F5) *before* `closing` is ever
  // introduced, so the hook's own re-entrant `watchProjects([staying])` below
  // finds it already watched and does not also re-follow it — the race under
  // test is `closing`'s alone.
  await watch.watchProjects([staying])
  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(staying, '.harnessdesk', 'agents', 'kept', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the project that stayed open',
  )
  await settled()
  said.length = 0

  // Now `closing` joins it: `staying` already holds a watcher, so this call
  // re-follows only `closing`, and the hook fires exactly once, for it.
  await watch.watchProjects([staying, closing])

  // `closing` never finished being followed before it was dropped: nothing
  // that happens in it now, however real, is heard.
  await mkdir(join(closing, '.harnessdesk', 'agents', 'late'), { recursive: true })
  await writeFile(join(closing, '.harnessdesk', 'agents', 'late', 'AGENT.md'), brief('Look.'))
  await pause(600)
  assert.deepEqual(said, [], 'no watcher survived on the project closed mid-follow')
})

/*
 * F2 — a follow that ends with no watcher must be retried, on the honest
 * comment. Three shapes: (a) the Agent directory led out of the project at
 * open, and is later replaced by a real folder; (b) the project folder itself
 * was missing at open, and a later re-open re-follows it; (c) `watch()` threw
 * once, is logged, and is retried on its own backoff — proved with an
 * injected `watch`, an option the host never passes.
 */

test('(F2a) a project opened with an Agent directory that leads out is followed once it is replaced by a real one', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(join(project, '.harnessdesk'), { recursive: true })
  await mkdir(elsewhere)
  await symlink(elsewhere, join(project, '.harnessdesk', 'agents'))
  const { said, changed } = heard()
  const probe = recording()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30, watchFn: probe.watchFn })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  // The link leads out: the walk-up watches `.harnessdesk` itself, for the
  // name `agents` — proved live on what that watch reports before any silence
  // from it is trusted, the same way as the property above.
  await proveWatching(probe, join(project, '.harnessdesk'), 'the watch on .harnessdesk, above the link that leads out')
  await mkdir(join(elsewhere, 'scout'))
  await writeFile(join(elsewhere, 'scout', 'AGENT.md'), brief('Look.'))
  await pause(500)
  assert.deepEqual(said, [], 'a link leading out raises nothing for what it points at')

  // Replaced with a real folder of the same name: the watch the walk-up set
  // up on the parent notices the replacement and follows from there.
  await unlink(join(project, '.harnessdesk', 'agents'))
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Real now.'))
  await until(() => said.some((one) => one === project), 'a notice once the link is replaced by a real folder')
})

test('(F2b) a project missing at open is followed once it exists, on the very next re-open with the same set', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'not-yet')
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())

  await watch.watchProjects([project]) // nothing there yet: nothing followed
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await watch.watchProjects([project]) // re-opened with the identical set

  // Repeatable, so this passes only once the re-opened watch has actually
  // attached — not only when a single write happens to land after it does.
  let n = 0
  await proveLive(
    () => said.some((one) => one === project),
    () => writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    're-opening a project that now exists is what follows it',
  )
})

test('(F2c) a watch that could not be made is logged once and retried on its own backoff', async (t) => {
  const root = tempDir('hd-agent-watch-')
  await mkdir(join(root, 'scout'), { recursive: true })
  const { said, changed } = heard()
  const logs: unknown[] = []
  let calls = 0
  const flaky: WatchFn = (dir, options, listener) => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' })
    return watch(dir, options, listener)
  }
  const watchInstance = new AgentWatch({
    roots: [root],
    changed,
    settleMs: 30,
    watchFn: flaky,
    log: (message, details) => logs.push({ message, details }),
  })
  t.after(() => watchInstance.dispose())

  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(root, 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice once the retried watch succeeds',
  )
  assert.ok(calls >= 2, `watch() was called ${calls} time(s); the failed attempt was never retried`)
  assert.equal(logs.length, 1, `the one failure was logged ${logs.length} time(s), not once`)
})

/*
 * F3 — a link *inside* an Agent directory, not the directory itself. Proven
 * live on the in-project Agent first, then the outside targets both kinds of
 * link name are changed: no notice either way. This property rests only on
 * FSEvents not following a link on its own — a future watcher that did follow
 * one would fail this test, which is the point of keeping it.
 */

test('(F3) a folder link and a file link inside an Agent directory both stay unwatched at their outside target', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const outsideDir = join(root, 'outside-dir')
  const outsideFile = join(root, 'outside-file.md')
  await mkdir(join(project, '.harnessdesk', 'agents', 'real'), { recursive: true })
  await mkdir(outsideDir)
  await writeFile(outsideFile, brief('Original.'))
  await symlink(outsideDir, join(project, '.harnessdesk', 'agents', 'scout'))
  await mkdir(join(project, '.harnessdesk', 'agents', 'in'))
  await symlink(outsideFile, join(project, '.harnessdesk', 'agents', 'in', 'AGENT.md'))

  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(project, '.harnessdesk', 'agents', 'real', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the in-project Agent, proving the watch is live',
  )
  await settled()
  said.length = 0

  await writeFile(join(outsideDir, 'AGENT.md'), brief('Changed.'))
  await mkdir(join(outsideDir, 'nested'))
  await writeFile(outsideFile, brief('Changed.'))
  await pause(600)
  assert.deepEqual(said, [], 'neither outside target raises a notice')
})

/*
 * F7 — a link directly in a root's own top level is a folder the roster
 * admits, and FSEvents does not follow it on its own: this machine's roots
 * follow such a link wherever it leads (the person put it there), and a
 * project's own only where it still resolves inside the project.
 */

test('(F7) a top-level link in this machine’s root is followed wherever it leads', async (t) => {
  const home = tempDir('hd-agent-watch-home-')
  const elsewhere = tempDir('hd-agent-watch-elsewhere-')
  await writeFile(join(elsewhere, 'AGENT.md'), brief('Original.'))
  // A dotfiles checkout linked into this machine's root: `agents.ts`'s `idsIn`
  // names this exact setup as a supported one.
  await symlink(elsewhere, join(home, 'scout'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [home], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  // The base watch on `home` itself can carry its own startup noise — an
  // event for the just-made `scout` link, with no write behind it yet — which
  // a bare "any notice" liveness check could not tell apart from the property
  // under test. Settled and cleared before the one write this test is about.
  await settled()
  said.length = 0

  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(elsewhere, 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the linked Agent’s target',
  )
  assert.ok(said.every((one) => one === null))
})

test('(F7) a top-level link inside a project is followed where it still resolves inside the project', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const shared = join(project, 'shared', 'scout') // inside the project, just not under .harnessdesk
  await mkdir(join(project, '.harnessdesk', 'agents'), { recursive: true })
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'AGENT.md'), brief('Original.'))
  // Relative, as a link committed to a repository is. The roster takes an
  // absolute target only where it names the project's own real path, and
  // `tempDir` spells the project through /var, a link to /private/var — so an
  // absolute link here is one the roster refuses, and the watch refuses it too.
  await symlink(join('..', '..', 'shared', 'scout'), join(project, '.harnessdesk', 'agents', 'scout'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(shared, 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the in-project link’s target',
  )
  assert.ok(said.every((one) => one === project))
  said.length = 0

  // Re-scanned when the top level changes: pointed elsewhere, the old target goes quiet.
  const movedTo = join(project, 'shared', 'moved')
  await mkdir(movedTo, { recursive: true })
  await writeFile(join(movedTo, 'AGENT.md'), brief('Elsewhere now.'))
  await unlink(join(project, '.harnessdesk', 'agents', 'scout'))
  await symlink(join('..', '..', 'shared', 'moved'), join(project, '.harnessdesk', 'agents', 'scout'))
  // The retarget is itself a change under the watched root and is its own
  // notice; wait it out and clear before judging only what follows.
  await until(() => said.length > 0, 'the retarget’s own notice')
  said.length = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(movedTo, 'AGENT.md'), brief(`Moved ${n++}.`)),
    'a notice for the new target',
  )
  await settled()
  said.length = 0
  await writeFile(join(shared, 'AGENT.md'), brief('Stale write.'))
  await pause(600)
  assert.deepEqual(said, [], 'the old target is no longer watched once the link points elsewhere')
})

/*
 * F8 — what `agent/list` actually reads for a linked worktree is
 * `gitOps.topLevel` of the open folder, the worktree's own top; `#repoOf`
 * answers with the main checkout instead. Exercised through the real host, so
 * `#watchProjects`'s own use of both is what is under test, not this file's
 * stand-in for it.
 */

test('(F8) through the host: a folder inside a linked worktree gets the worktree’s own top watched, not only the main checkout', async (t) => {
  const quiet = { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }
  const repo = tempDir('hd-agent-watch-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], quiet)
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], quiet)
  const parent = tempDir('hd-agent-watch-worktree-')
  const tree = join(parent, 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-branch', tree], quiet)
  const treeReal = await realpath(tree)
  const sub = join(tree, 'sub')
  await mkdir(sub)
  // Made before the workspace is opened, so `#watchProjects` finds the
  // worktree's own `.harnessdesk/agents` already there and watches it
  // directly — a walk-up's one-shot "the name appeared" transition would
  // still be correct, but is not what this test is about, and racing it
  // against the host's own startup work is not a risk worth taking on.
  await mkdir(join(treeReal, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  // And one in the main checkout, which a watch on it would find directly too.
  const repoReal = await realpath(repo)
  await mkdir(join(repoReal, '.harnessdesk', 'agents', 'main-scout'), { recursive: true })

  const harness = await start({ builtinAgents: await shippedAgentsCopy() })
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  await client.call('workspace/open', { path: sub })
  const namedTreeReal = () =>
    client.notifications.some(
      (one) => 'method' in one && one.method === 'agent/changed' && one.params.project === treeReal,
    )
  let n = 0
  await proveLive(
    namedTreeReal,
    () => writeFile(join(treeReal, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    `agent/changed naming the worktree’s own top (${treeReal})`,
    8_000,
  )

  /* (G6) The main checkout is not watched: `agent/list` refuses it as a
     project while only a folder of the linked worktree is open
     (`confineGitRoot`), so no Agent read reaches it, and a watch there would
     be telling windows about Agents none of them can list. Proved live just
     above, on the same host's watch, so the silence below is the watch's. */
  await settled()
  client.notifications.length = 0
  await writeFile(join(repoReal, '.harnessdesk', 'agents', 'main-scout', 'AGENT.md'), brief('In the main checkout.'))
  await pause(600)
  assert.deepEqual(
    client.notifications.filter((one) => 'method' in one && one.method === 'agent/changed'),
    [],
    'a change in the main checkout of a linked worktree tells no window',
  )
})

/*
 * F1's "second path" — the host's own `#watchProjects`, fired without being
 * waited on from both `#openWorkspace` and `forgetBoardRoots`. Two calls can
 * race, each awaiting git once per remembered folder, and an *older* call
 * finishing *last* used to re-apply its now-stale answer over a *newer*
 * one's. Driven by construction with a slow stand-in for `git` on `PATH` —
 * see the note on the equivalent `startup.test.ts` case for why not real
 * timing — rather than by hoping two real calls land in the right order.
 */

test('(F1, host) an older #watchProjects call finishing late does not re-add a project a newer one dropped', async (t) => {
  const fakeGitDir = await mkdtemp(join(tmpdir(), 'hd-agent-watch-fakegit-'))
  const fakeGit = join(fakeGitDir, 'git')
  await writeFile(fakeGit, '#!/bin/sh\nsleep 3\nexit 1\n')
  await chmod(fakeGit, 0o755)
  const realPath = process.env['PATH']
  t.after(() => {
    process.env['PATH'] = realPath
  })

  const harness = await start({ builtinAgents: await shippedAgentsCopy() })
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  // Removing this after the host is stopped, not before: a slow #watchProjects
  // call still spawning `fakeGit` out of it could otherwise race the removal (#868).
  t.after(() => rm(fakeGitDir, { recursive: true, force: true }))

  const p = tempDir('hd-agent-watch-project-')
  await mkdir(join(p, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await writeFile(join(p, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look.'))
  await client.call('workspace/open', { path: p })

  const changedP = () =>
    client.notifications.some((one) => 'method' in one && one.method === 'agent/changed' && one.params.project === p)
  // Proved live before anything about it is raced.
  let n = 0
  await proveLive(
    changedP,
    () => writeFile(join(p, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief(`Ready ${n++}.`)),
    'a notice proving the project is watched',
  )
  await settled()
  client.notifications.length = 0

  /* An older `#watchProjects` call, started while `git` is a slow stand-in:
     the workspace list it reads still holds `p`, and the answer it is about
     to spend 3s asking git for is stale by the time it has it. The verb it
     rides in on — `workspace/forget`, on a path that was never open — does
     not wait for it either (F6's own property), so this resolves at once,
     with the slow spawns already under way. */
  process.env['PATH'] = `${fakeGitDir}:${realPath ?? ''}`
  await client.call('workspace/forget', { path: join(p, 'never-opened') })
  process.env['PATH'] = realPath

  // A newer call, with `git` fast again: `p` really is forgotten now.
  await client.call('workspace/forget', { path: p })

  // `p` is not watched: a change in it now raises nothing.
  await writeFile(join(p, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Gone now.'))
  await pause(600)
  assert.ok(!changedP(), 'the project is not watched right after being forgotten')

  /* Waited out, past the older call's own 3s delay — long enough that, left
     unguarded, it would by now have re-added the project and re-established a
     live watcher on it. A change made only after that is the proof: nothing
     to catch it means nothing re-added it. */
  await pause(3_500)
  client.notifications.length = 0
  await writeFile(join(p, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Still gone.'))
  await pause(600)
  assert.ok(!changedP(), 'the older call finishing late did not re-add the project the newer one dropped')
})

/*
 * F9 — a watcher's own `error` event shares F2's logged, backed-off retry,
 * rather than refollowing at once: a persistent error must not tighten into a
 * loop.
 */

test('(F9) a watcher’s own error is logged once and recovers on the same backoff', async (t) => {
  const root = tempDir('hd-agent-watch-')
  await mkdir(join(root, 'scout'), { recursive: true })
  const { said, changed } = heard()
  const logs: unknown[] = []
  const made: FSWatcher[] = []
  const capturing: WatchFn = (dir, options, listener) => {
    const w = watch(dir, options, listener)
    made.push(w)
    return w
  }
  const watchInstance = new AgentWatch({ roots: [root], changed, settleMs: 30, watchFn: capturing, log: (message) => logs.push(message) })
  t.after(() => watchInstance.dispose())

  await until(() => made.length > 0, 'the watch to attach')
  made[0]?.emit('error', Object.assign(new Error('EIO: simulated'), { code: 'EIO' }))
  await until(() => logs.length > 0, 'the error to be logged')
  assert.equal(logs.length, 1, 'a single error is logged more than once')

  let n = 0
  await proveLive(
    () => said.length > 0,
    () => writeFile(join(root, 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice once the watch recovers from the error',
  )
})

/*
 * F10 — nothing this module makes may be the reason a process stays up. A
 * live, un-disposed watcher and a link watcher beside it (`persistent: false`),
 * a pending, un-disposed settle timer and a pending retry of a watch that could
 * not be made (`unref`'d) must all let a process holding nothing else exit on
 * its own. Run as a child so the claim is about the process, not about one
 * Node API's own bookkeeping; any one of the four left holding the process
 * keeps it past the parent's timeout.
 */

test('(F10) a live watch, a linked folder, a pending notice and a pending retry, never disposed, do not keep a process alive on their own', async () => {
  const root = tempDir('hd-agent-watch-child-')
  await mkdir(join(root, 'scout'), { recursive: true })
  // A top-level link, so a link watcher is made beside the root's own.
  const linked = tempDir('hd-agent-watch-child-linked-')
  await symlink(linked, join(root, 'linked'))
  // A second root whose watch can never be made, so a retry of it is always pending.
  const failing = tempDir('hd-agent-watch-child-failing-')
  const target = new URL('../src/agent-watch.js', import.meta.url).href
  const script = `
    import { realpathSync, watch, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { AgentWatch } from ${JSON.stringify(target)}
    const failing = realpathSync(${JSON.stringify(failing)})
    new AgentWatch({
      roots: [${JSON.stringify(root)}, ${JSON.stringify(failing)}],
      changed: () => {},
      settleMs: 5000,
      log: () => {},
      watchFn: (dir, options, listener) => {
        if (realpathSync(dir) === failing) throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' })
        return watch(dir, options, listener)
      },
    })
    setTimeout(() => {
      writeFileSync(join(${JSON.stringify(root)}, 'scout', 'AGENT.md'), '---\\nname: Scout\\n---\\nLook.\\n')
    }, 100)
    // A ref'd timer whose only job is to keep this process alive long enough
    // for the write's own fs event to arrive and the settle timer to be
    // armed — without it, this process could exit before that event ever
    // arrives, which would prove nothing either way. A live recursive watcher,
    // a link watcher, a pending 5s settle timer and a retry on its backoff are
    // all outstanding by the time this fires, and dispose() is deliberately
    // never called: none may be the reason the process is still here after it.
    setTimeout(() => {}, 900)
  `
  const startedAt = Date.now()
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 4_000 })
  const took = Date.now() - startedAt
  assert.ok(took < 2_000, `the child process took ${took}ms to exit on its own`)
})

test("through the host: an Agent written into this machine's roster is a notice to every window", async (t) => {
  // The state directory is made ahead of `start()`, with `agents/scout`
  // already in it, so the host's own machine-root follow is a direct hit from
  // the moment it is made — a walk-up's one-shot "the name appeared"
  // transition would still be correct, but racing it against the host's own
  // startup work (state, rooms, flow runs, names, every registered runtime)
  // is not a risk this test needs to take.
  const stateDir = tempDir('hd-agent-watch-host-')
  await mkdir(join(stateDir, 'agents', 'scout'), { recursive: true })
  // A copy of the shipped Agents: an edit to the real folder while this runs
  // would be a `project: null` notice too, and would pass this vacuously.
  const harness = await start({ builtinAgents: await shippedAgentsCopy() }, stateDir)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const namedNull = () =>
    client.notifications.some((one) => 'method' in one && one.method === 'agent/changed' && one.params.project === null)
  let n = 0
  await proveLive(
    namedNull,
    () => writeFile(join(harness.stateDir, 'agents', 'scout', 'AGENT.md'), brief(`Look ${n++}.`)),
    'agent/changed',
  )
})

/*
 * G1 — a link out at any step above the Agent directory is walked past, never
 * given up on. With `.harnessdesk` itself leading out, the walk-up used to
 * stop at the first folder that resolved outside, leaving no watch at all:
 * replacing the link with a real folder went unnoticed until the project was
 * opened again.
 */

test('(G1) a project whose .harnessdesk leads out is watched from its own folder, and followed once the link is a real folder', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(project)
  await mkdir(join(elsewhere, 'agents', 'scout'), { recursive: true })
  await writeFile(join(elsewhere, 'agents', 'scout', 'AGENT.md'), brief('Outside.'))
  await symlink(elsewhere, join(project, '.harnessdesk'))
  const projectReal = await realpath(project)
  const probe = recording()
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30, watchFn: probe.watchFn })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  // The project's own folder is watched, for the name `.harnessdesk`, and is live.
  await proveWatching(probe, project, 'the watch on the project’s own folder')
  // What the link leads to raises nothing.
  await writeFile(join(elsewhere, 'agents', 'scout', 'AGENT.md'), brief('Outside, changed.'))
  await pause(600)
  assert.deepEqual(said, [], 'what a link out of the project leads to raises nothing')

  // The link replaced by a real folder, and an Agent written into it: noticed without a re-open…
  await unlink(join(project, '.harnessdesk'))
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Inside.'))
  // `some`, not `includes`: the `deepEqual` above narrowed `said` to an empty tuple's type.
  await until(() => said.some((one) => one === project), 'a notice once .harnessdesk is a real folder')
  // …and followed down to the Agent directory itself.
  await settled()
  said.length = 0
  let n = 0
  await proveLive(
    () => said.some((one) => one === project),
    () => writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief(`Inside ${n++}.`)),
    'a notice for an Agent written into the real folder',
  )
  // And at no point was anything outside the project watched.
  assert.ok(
    probe.watched.length > 0 && probe.watched.every((dir) => dir === projectReal || dir.startsWith(projectReal + sep)),
    `only folders inside the project were watched: ${probe.watched.join(', ')}`,
  )
})

/*
 * G2 — a failure that keeps happening backs off, and its run of failures is
 * logged once. A watcher made and then failing every time used to be made
 * again every 200ms, forever, with a line each round: the success of making it
 * reset the backoff before it failed.
 */

/** How long each G2 test watches the retries: 0, 200, 600 and 1400ms fit, the next is at 3000. */
const RETRY_WINDOW_MS = 2_500

test('(G2) a watcher that fails every time it is made backs off, and its run of failures is logged once', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const logs: unknown[] = []
  let attempts = 0
  const failsOnceMade: WatchFn = () => {
    attempts += 1
    const watcher = quietWatcher()
    setImmediate(() => watcher.emit('error', Object.assign(new Error('EIO: simulated'), { code: 'EIO' })))
    return watcher
  }
  const watch = new AgentWatch({ roots: [root], changed: () => {}, settleMs: 30, watchFn: failsOnceMade, log: (message) => logs.push(message) })
  t.after(() => watch.dispose())
  await pause(RETRY_WINDOW_MS)
  assert.ok(attempts >= 2, `made ${attempts} time(s): a failed watch is retried`)
  // Doubling from 200ms, a retry can come no sooner: 0, 200, 600, 1400 are all that fit.
  assert.ok(attempts <= 4, `made ${attempts} times in ${RETRY_WINDOW_MS}ms: the backoff was reset by the making, not by the watch working`)
  assert.equal(logs.length, 1, `${logs.length} lines for one run of failures`)
})

test('(G2) a watch that cannot be made at all backs off the same way, and is logged once', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const logs: unknown[] = []
  let attempts = 0
  const neverMade: WatchFn = () => {
    attempts += 1
    throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' })
  }
  const watch = new AgentWatch({ roots: [root], changed: () => {}, settleMs: 30, watchFn: neverMade, log: (message) => logs.push(message) })
  t.after(() => watch.dispose())
  await pause(RETRY_WINDOW_MS)
  assert.ok(attempts >= 2, `tried ${attempts} time(s): a failed watch is retried`)
  assert.ok(attempts <= 4, `tried ${attempts} times in ${RETRY_WINDOW_MS}ms`)
  assert.equal(logs.length, 1, `${logs.length} lines for one run of failures`)
})

/**
 * Watches made by hand: each is quiet until a test makes it report an event or
 * fail, so what ends a run of failures can be driven exactly.
 */
const byHand = () => {
  const made: { readonly watcher: FSWatcher; readonly listener: (event: string, filename: string | Buffer | null) => void }[] = []
  const watchFn: WatchFn = (_dir, _options, listener) => {
    const watcher = quietWatcher()
    made.push({ watcher, listener })
    return watcher
  }
  return { watchFn, made }
}

const failure = () => Object.assign(new Error('EIO: simulated'), { code: 'EIO' })

test('(G2) a watch that reports an event has worked: a failure after it starts a new run, logged again', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const { watchFn, made } = byHand()
  const logs: unknown[] = []
  const watch = new AgentWatch({ roots: [root], changed: () => {}, settleMs: 30, watchFn, log: (message) => logs.push(message) })
  t.after(() => watch.dispose())
  await until(() => made.length === 1, 'the first watch')
  made[0]?.watcher.emit('error', failure())
  await until(() => made.length === 2, 'the retry')
  assert.equal(logs.length, 1)
  // It reports something — it works — and then fails at once.
  made[1]?.listener('change', 'AGENT.md')
  made[1]?.watcher.emit('error', failure())
  assert.equal(logs.length, 2, 'a failure after the watch worked was taken for the same run')
})

test('(G2) a watch that stayed up as long as the wait before it has worked: a failure after it starts a new run, logged again', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const { watchFn, made } = byHand()
  const logs: unknown[] = []
  const watch = new AgentWatch({ roots: [root], changed: () => {}, settleMs: 30, watchFn, log: (message) => logs.push(message) })
  t.after(() => watch.dispose())
  await until(() => made.length === 1, 'the first watch')
  made[0]?.watcher.emit('error', failure())
  await until(() => made.length === 2, 'the retry, after a 200ms wait')
  assert.equal(logs.length, 1)
  // Up, and quiet, for longer than the 200ms it waited for; then it fails.
  await pause(300)
  made[1]?.watcher.emit('error', failure())
  assert.equal(logs.length, 2, 'a failure after the watch stayed up was taken for the same run')
})

/*
 * G5 — a remembered folder's git top level is asked once, the way `#repoOf`
 * is, until a folder is forgotten. Every open used to ask git once for every
 * remembered folder, and one on a stalled volume held every call for git's
 * timeout. Counted with a stand-in for `git` that records what it was asked
 * and hands on to the real one.
 */

test('(G5) through the host: a remembered folder’s git top level is asked once, until a folder is forgotten', async (t) => {
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim()
  const countingDir = tempDir('hd-agent-watch-countgit-')
  const asked = join(countingDir, 'asked.log')
  await writeFile(asked, '')
  await writeFile(join(countingDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(asked)}\nexec ${JSON.stringify(realGit)} "$@"\n`)
  await chmod(join(countingDir, 'git'), 0o755)
  const realPath = process.env['PATH']
  process.env['PATH'] = `${countingDir}:${realPath ?? ''}`
  t.after(() => {
    process.env['PATH'] = realPath
  })

  const harness = await start({ builtinAgents: await shippedAgentsCopy() })
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const first = tempDir('hd-agent-watch-first-')
  const second = tempDir('hd-agent-watch-second-')
  const topLevelAsks = async (folder: string): Promise<number> =>
    (await readFile(asked, 'utf8')).split('\n').filter((line) => line === `-C ${folder} rev-parse --show-toplevel`).length

  // Two asks per open of a new folder, with the same words: the open's own
  // `git status` asks where the top is, and so does the roster's watch.
  await client.call('workspace/open', { path: first })
  await untilRead(async () => (await topLevelAsks(first)) >= 2, 'the first open asking git about its folder')
  await pause(300)
  const before = await topLevelAsks(first)
  assert.equal(before, 2, 'the open and the watch each asked once')
  await client.call('workspace/open', { path: second })
  // Proof the second open's watch asked git about what it holds: its own folder.
  await untilRead(async () => (await topLevelAsks(second)) >= 2, 'the second open asking git about its folder')
  await pause(300)
  assert.equal(await topLevelAsks(first), before, 'opening a second folder asked git about the first one again')

  // Forgetting a folder is when every answer is asked for again.
  await client.call('workspace/forget', { path: second })
  await untilRead(async () => (await topLevelAsks(first)) === before + 1, 'git asked again about the first folder once a folder was forgotten')
})

/*
 * G7 — no late notice for a closed project. A walk-up's look at the name it
 * was waiting for is asynchronous, and one that comes back after the project
 * closed used to be a notice anyway. What the watches report is said by hand,
 * so the look and the close land in exactly that order.
 */

test('(G7) a walk-up whose look comes back after its project closed tells nobody', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const closing = join(root, 'closing')
  const staying = join(root, 'staying')
  await mkdir(closing)
  await mkdir(staying)
  const listeners = new Map<string, (event: string, filename: string | Buffer | null) => void>()
  const heardByFolder: WatchFn = (dir, _options, listener) => {
    listeners.set(realpathSync(dir), listener)
    return quietWatcher()
  }
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30, watchFn: heardByFolder })
  t.after(() => watch.dispose())
  await watch.watchProjects([closing, staying])
  const [closingReal, stayingReal] = await Promise.all([realpath(closing), realpath(staying)])
  await until(() => listeners.has(closingReal) && listeners.has(stayingReal), 'both walk-ups to watch their project’s own folder')

  // The walk-up's own path, live: on the project that stays open, the name it waits for appears and is a notice.
  await mkdir(join(staying, '.harnessdesk'))
  listeners.get(stayingReal)?.('rename', '.harnessdesk')
  await until(() => said.includes(staying), 'a notice for the project that stayed open')

  // The same report for the other project, and the project closed before the walk-up's look comes back.
  await mkdir(join(closing, '.harnessdesk'))
  listeners.get(closingReal)?.('rename', '.harnessdesk')
  void watch.watchProjects([staying])
  await pause(600)
  assert.ok(!said.includes(closing), 'a project closed while its walk-up was looking was told of anyway')
})

/*
 * G8 — a root's link watchers live and die with it. The link watchers were
 * closed only by a rescan that could read the root, so a root that went away
 * left them watching.
 */

test('(G8) a root’s link watchers go when the root goes', async (t) => {
  const home = tempDir('hd-agent-watch-home-')
  const root = join(home, 'agents')
  await mkdir(root)
  const elsewhere = tempDir('hd-agent-watch-elsewhere-')
  await writeFile(join(elsewhere, 'AGENT.md'), brief('Original.'))
  await symlink(elsewhere, join(root, 'scout'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await settled()
  said.length = 0

  // The link is followed, and live.
  let n = 0
  await proveLive(() => said.length > 0, () => writeFile(join(elsewhere, 'AGENT.md'), brief(`Look ${n++}.`)), 'a notice for the linked folder')
  await settled()
  said.length = 0

  // The root goes — the link with it, not what it pointed at — and that is itself a notice.
  await rm(root, { recursive: true })
  await until(() => said.length > 0, 'a notice for the root going')
  await settled()
  said.length = 0
  await writeFile(join(elsewhere, 'AGENT.md'), brief('After the root went.'))
  await pause(600)
  assert.deepEqual(said, [], 'a link watcher outlived the root it was read from')
})

/*
 * The other half of G8: two readings of a root's top level can finish out of
 * order, and only the later one may be applied. The first reading is held, by
 * the test-only `onRescan`, between reading the link and applying it; the link
 * is pointed elsewhere and a later reading applies that; then the first is let
 * go.
 */

test('(G8) a reading of a root’s links that a later one overtook applies nothing', async (t) => {
  const home = tempDir('hd-agent-watch-home-')
  const first = tempDir('hd-agent-watch-first-')
  const second = tempDir('hd-agent-watch-second-')
  await writeFile(join(first, 'AGENT.md'), brief('First.'))
  await writeFile(join(second, 'AGENT.md'), brief('Second.'))
  await symlink(first, join(home, 'scout'))
  const { said, changed } = heard()
  let holdNext = false
  // Asserted, not annotated: set inside a callback, which narrowing from `null` would not see.
  let release = null as (() => void) | null
  const watch = new AgentWatch({
    roots: [home],
    changed,
    settleMs: 30,
    onRescan: () => {
      if (!holdNext) return
      holdNext = false
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })
  t.after(() => {
    release?.()
    watch.dispose()
  })
  await settled()
  said.length = 0
  let n = 0
  await proveLive(() => said.length > 0, () => writeFile(join(first, 'AGENT.md'), brief(`First ${n++}.`)), 'the link followed to where it first led')
  await settled()
  said.length = 0

  // A reading that sees "scout leads to first", held before it applies that.
  holdNext = true
  await writeFile(join(home, 'nudge'), 'a change at the top level, which reads it again')
  await until(() => release !== null, 'a reading of the top level to be held')
  await settled()
  said.length = 0

  // The link now leads to second, and a later reading applies that.
  await unlink(join(home, 'scout'))
  await symlink(second, join(home, 'scout'))
  await until(() => said.length > 0, 'the change to the link’s own notice')
  await settled()
  said.length = 0
  await proveLive(() => said.length > 0, () => writeFile(join(second, 'AGENT.md'), brief(`Second ${n++}.`)), 'the link followed to where it leads now')
  await settled()
  said.length = 0

  // The held reading finishes last. Where the link leads now is still watched, and where it used to lead is not.
  release?.()
  await settled()
  await proveLive(() => said.length > 0, () => writeFile(join(second, 'AGENT.md'), brief(`Second ${n++}.`)), 'the link still followed to where it leads now')
  await settled()
  said.length = 0
  await writeFile(join(first, 'AGENT.md'), brief('Stale.'))
  await pause(600)
  assert.deepEqual(said, [], 'a reading that was overtaken put back a link watcher the later one had closed')
})

/*
 * G9 — a project's links are judged the way the roster judges them: step by
 * step, never looking outside (`resolveWithin`). A link that leaves the
 * project and comes back resolves inside by `realpath`, and was watched,
 * though the roster refuses to read it.
 */

test('(G9) a link that leaves a project and comes back is not watched, just as the roster does not read it', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const outside = join(root, 'outside')
  await mkdir(outside)
  // A top-level link in the Agent directory that leaves the project and comes back into it.
  const project = join(root, 'project')
  await mkdir(join(project, '.harnessdesk', 'agents', 'real'), { recursive: true })
  await mkdir(join(project, 'shared', 'scout'), { recursive: true })
  await writeFile(join(project, 'shared', 'scout', 'AGENT.md'), brief('Original.'))
  await symlink(join('..', 'project', 'shared', 'scout'), join(outside, 'back'))
  await symlink(join('..', '..', '..', 'outside', 'back'), join(project, '.harnessdesk', 'agents', 'scout'))
  // An Agent directory that itself leaves its project and comes back into it.
  const other = join(root, 'other')
  await mkdir(join(other, '.harnessdesk'), { recursive: true })
  await mkdir(join(other, 'real-agents', 'scout'), { recursive: true })
  await writeFile(join(other, 'real-agents', 'scout', 'AGENT.md'), brief('Original.'))
  await symlink(join('..', 'other', 'real-agents'), join(outside, 'agents-back'))
  await symlink(join('..', '..', 'outside', 'agents-back'), join(other, '.harnessdesk', 'agents'))

  // The roster reads neither.
  const roster = new Agents({ user: join(root, 'user'), builtin: join(root, 'builtin') })
  const read = await roster.list(project)
  assert.match(read.find((one) => one.id === 'scout')?.problems[0]?.text ?? '', /links outside the project/)
  const readOther = await roster.list(other)
  assert.match(readOther.find((one) => one.id === '.harnessdesk/agents')?.problems[0]?.text ?? '', /links outside the project/)

  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project, other])
  let n = 0
  await proveLive(
    () => said.includes(project),
    () => writeFile(join(project, '.harnessdesk', 'agents', 'real', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the project’s own real Agent',
  )
  await settled()
  said.length = 0

  await writeFile(join(project, 'shared', 'scout', 'AGENT.md'), brief('Changed.'))
  await writeFile(join(other, 'real-agents', 'scout', 'AGENT.md'), brief('Changed.'))
  await pause(600)
  assert.deepEqual(said, [], 'the watch followed a link the roster refuses to read')
})

/*
 * The roster's walk trusts the project's real path, found when the project
 * was opened, to still be one. So the system's own answer is asked as well,
 * once the walk says "inside", and must agree: a project folder swapped for a
 * link to somewhere else — here, in the one moment between the project being
 * resolved and its follow looking — is not watched there.
 */

test('(G9) a project whose own folder is swapped for a link while it is followed is not watched where the link leads', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const outside = join(root, 'outside')
  await mkdir(join(project, '.harnessdesk', 'agents', 'real'), { recursive: true })
  await mkdir(join(outside, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await writeFile(join(outside, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Outside.'))
  const outsideReal = await realpath(outside)
  const legitimate = tempDir('hd-agent-watch-project-')
  await mkdir(join(legitimate, '.harnessdesk', 'agents', 'real'), { recursive: true })
  const probe = recording()
  const { said, changed } = heard()
  let swapped = false
  const watch = new AgentWatch({
    roots: [],
    changed,
    settleMs: 30,
    watchFn: probe.watchFn,
    onFollow: (follow) => {
      if (swapped || follow.scope !== project) return
      swapped = true
      renameSync(project, join(root, 'project-was'))
      symlinkSync(outside, project)
    },
  })
  t.after(() => watch.dispose())
  await watch.watchProjects([project, legitimate])
  assert.ok(swapped)
  let n = 0
  await proveLive(
    () => said.includes(legitimate),
    () => writeFile(join(legitimate, '.harnessdesk', 'agents', 'real', 'AGENT.md'), brief(`Look ${n++}.`)),
    'a notice for the other project, proving the watch is live',
  )
  await settled()
  said.length = 0
  await writeFile(join(outside, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Outside, changed.'))
  await pause(600)
  assert.deepEqual(said, [], 'a change where the swapped folder leads raised a notice')
  assert.ok(
    probe.watched.every((dir) => dir !== outsideReal && !dir.startsWith(outsideReal + sep)),
    `a folder outside the project was watched: ${probe.watched.join(', ')}`,
  )
})

/*
 * P3 (final Part A review): `reach`'s own walk had no rule against a link
 * resolving *above* the very Agents folder it was asked about — the project
 * root itself, chief among them — so a committed `.harnessdesk/agents -> ..`
 * turned a project's roster watch into a recursive watch on the whole
 * checkout: every write anywhere in it, `node_modules` and `.git` included,
 * became a notice. The walk-up now treats such a resolution exactly like one
 * that leads nowhere — `.harnessdesk` itself is watched, non-recursively,
 * for the name `agents` to become a real folder, proved live below — so the
 * project's own root is never handed to a watcher at all.
 */
test('(P3) a committed .harnessdesk/agents -> .. is never watched recursively as the project root', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  await mkdir(join(project, '.harnessdesk'), { recursive: true })
  await mkdir(join(project, 'build'), { recursive: true })
  await symlink('..', join(project, '.harnessdesk', 'agents'))
  const projectReal = await realpath(project)
  const probe = recording()
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30, watchFn: probe.watchFn })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  // Proves the walk-up's watch on `.harnessdesk` is live before any silence from it is trusted.
  await proveWatching(probe, join(project, '.harnessdesk'), 'the walk-up watch on .harnessdesk')
  assert.ok(
    probe.watched.every((dir) => dir !== projectReal),
    `the project root was itself handed to a watcher: ${probe.watched.join(', ')}`,
  )

  await settled()
  said.length = 0
  for (let n = 0; n < 5; n++) {
    await writeFile(join(project, 'build', `out${n}.js`), 'x')
    await pause(60)
  }
  await pause(600)
  assert.deepEqual(said, [], 'a recursive watch on the project root reported changes under build/')
})

/**
 * The identical hazard one level down: the Agents folder itself is real, but
 * a link directly inside it reaches the project root the same way
 * `.harnessdesk/agents -> ..` does above. `#rescanLinks` had no rule against
 * adding a recursive watch wherever such a link resolved. The Agents folder's
 * own watch stays exactly as it should be — recursive, and live — while the
 * link that reaches above it is simply left unwatched.
 */
test('(P3) a top-level link inside the Agents folder that reaches the project root is left unwatched', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  await mkdir(join(project, '.harnessdesk', 'agents'), { recursive: true })
  await mkdir(join(project, 'build'), { recursive: true })
  await symlink(join('..', '..'), join(project, '.harnessdesk', 'agents', 'x'))
  const projectReal = await realpath(project)
  const probe = recording()
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30, watchFn: probe.watchFn })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  // Proves the Agents folder's own recursive watch is live before any silence about the link is trusted.
  await proveWatching(probe, join(project, '.harnessdesk', 'agents'), "the Agents folder's own watch")
  assert.ok(
    probe.watched.every((dir) => dir !== projectReal),
    `the link's target — the project root — was itself handed to a watcher: ${probe.watched.join(', ')}`,
  )

  await settled()
  said.length = 0
  for (let n = 0; n < 5; n++) {
    await writeFile(join(project, 'build', `out${n}.js`), 'x')
    await pause(60)
  }
  await pause(600)
  assert.deepEqual(said, [], 'a link inside the Agents folder that reaches the project root was watched recursively')
})

/**
 * `#rescanLinks` used to run once per event the root's own recursive watch
 * reported — a `readdir` of the root, plus a `reach` (its own `lstat`s and
 * `realpath`s) per top-level link found, on every single file changed
 * anywhere beneath it. It now runs once per settled burst, on the same clock
 * `#poke`'s own notice already settles on — proved here by counting
 * `onRescan` across a burst of rapid changes, once the watch is proved live.
 *
 * A real settle timer used to gather that burst: fine when the 20 real
 * writes below land close enough together in real time, but a loaded machine
 * can space a plain sequential loop of them out past even a generous window,
 * and once any real gap outlasts `settleMs` the timer fires mid-burst —
 * several genuinely separate "settled" windows, not one. The debounce logic
 * itself resets correctly on every event; only counting it against a real
 * clock was the flake. A `fakeClock` fixes that: nothing it schedules fires
 * until `advance` says so, so however unevenly the real events land while
 * the test waits for them, the pending timer they keep resetting never gets
 * the chance to expire early. Only once the test is done waiting for the
 * real writes to be heard does it move the clock forward, in one step,
 * settling the whole burst exactly once — deterministically, regardless of
 * load.
 */
test('(P3) the top-level link rescan runs once per settled burst, not once per file changed beneath the root', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Original.'))
  const elsewhere = tempDir('hd-agent-watch-linked-')
  await symlink(elsewhere, join(project, '.harnessdesk', 'agents', 'shared'))

  let rescans = 0
  const probe = recording()
  const { changed } = heard()
  const clock = fakeClock()
  const watch = new AgentWatch({
    roots: [],
    changed,
    settleMs: 30,
    watchFn: probe.watchFn,
    clock,
    onRescan: () => void rescans++,
  })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])
  await proveWatching(probe, join(project, '.harnessdesk', 'agents'), "the Agents folder's own watch")
  // Real time, not the fake clock: lets whatever the setup above scheduled —
  // the initial follow's own rescan, and any settle timer the liveness probe
  // above reset — actually be pending, so the advance right after can flush
  // it before the count below starts from a clean zero.
  await settled()
  clock.advance(1_000)
  rescans = 0

  for (let n = 0; n < 20; n++) await writeFile(join(project, '.harnessdesk', 'agents', 'scout', `f${n}.txt`), 'x')
  // Real time again: gives the OS as long as `settled()` ever did to deliver
  // every one of the 20 real events. None of them can expire the debounce
  // timer early, however they are spaced, because the clock that timer runs
  // on is frozen until the `advance` below moves it.
  await settled()
  clock.advance(1_000)
  assert.equal(rescans, 1, `20 rapid changes beneath the root caused ${rescans} rescans, not one settled burst`)
})

/*
 * G4 — the tests that count `agent/changed` point their host's built-in root
 * at a copy, so an edit to `packages/server/agents` cannot land in a count.
 * This one does not: it is the app's own setup, and proves the real folder the
 * Agents ship in is watched. Only the folder's own times are touched — nothing
 * in it changes, and nothing that lists it sees a difference — and they are
 * put back.
 */

test('(G4) through the host: the Agents that ship with the app are watched where they ship', async (t) => {
  // No `agents` in this state directory, so a notice for this machine's roster can only be the built-in one's.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const shipped = builtinAgentRoot()
  const was = await stat(shipped)
  t.after(() => utimes(shipped, was.atime, was.mtime))
  const namedNull = () =>
    client.notifications.some((one) => 'method' in one && one.method === 'agent/changed' && one.params.project === null)
  let n = 0
  await proveLive(
    namedNull,
    async () => {
      const at = new Date(was.mtimeMs + ++n * 1_000)
      await utimes(shipped, at, at)
    },
    'agent/changed for the Agents that ship with the app',
  )
})

test('(G4) through the host: a host pointed at a copy of the shipped Agents watches the copy, and not the real folder', async (t) => {
  const copy = await shippedAgentsCopy()
  const harness = await start({ builtinAgents: copy })
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const shipped = builtinAgentRoot()
  const was = await stat(shipped)
  t.after(() => utimes(shipped, was.atime, was.mtime))
  const agentChanged = () => client.notifications.filter((one) => 'method' in one && one.method === 'agent/changed')
  // Listed from the copy, as the app lists it from the real one.
  const listed = (await client.call('agent/list', {})) as { readonly id: string; readonly origin: string; readonly path: string }[]
  const builtin = listed.filter((one) => one.origin === 'builtin')
  assert.ok(builtin.length > 0 && builtin.every((one) => one.path.startsWith(copy + sep)), 'the built-in Agents are read from the copy')
  // The copy is watched…
  let n = 0
  await proveLive(
    () => agentChanged().length > 0,
    async () => {
      const at = new Date(Date.now() + ++n * 1_000)
      await utimes(copy, at, at)
    },
    'agent/changed for the copy',
  )
  await settled()
  client.notifications.length = 0
  // …and the real folder, touched the same way, is not.
  const at = new Date(was.mtimeMs + 60_000)
  await utimes(shipped, at, at)
  await pause(600)
  assert.deepEqual(agentChanged(), [], 'the real shipped folder is still watched by a host pointed at a copy')
})
