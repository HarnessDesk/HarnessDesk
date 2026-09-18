import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AgentWatch, type WatchFn } from '../src/agent-watch.js'
import { Client, start, stop } from './fixtures/harness.js'
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
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  // The ancestor watch (on `home`, for the name `agents`) needs a moment to
  // attach before the one change it is waiting for can be made — a root
  // appearing for the first time is not repeatable, so this one step keeps a
  // fixed pause, as setup rather than as proof.
  await pause(150)
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
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])

  // The link leads out: no notice for what it points at (re-affirms the property above).
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

  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look.'))
  await until(() => said.some((one) => one === project), 're-opening a project that now exists is what follows it')
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
  await symlink(shared, join(project, '.harnessdesk', 'agents', 'scout'))
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
  await symlink(movedTo, join(project, '.harnessdesk', 'agents', 'scout'))
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

  const harness = await start()
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

  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

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
 * F10 — nothing this module makes may be the reason a process stays up: a
 * live, un-disposed watcher (`persistent: false`) and a pending, un-disposed
 * settle timer (`unref`'d) must both let a process holding nothing else exit
 * on its own. Run as a child so the claim is about the process, not about one
 * Node API's own bookkeeping.
 */

test('(F10) a live watch and a pending notice, never disposed, do not keep a process alive on their own', async () => {
  const root = tempDir('hd-agent-watch-child-')
  await mkdir(join(root, 'scout'), { recursive: true })
  const target = new URL('../src/agent-watch.js', import.meta.url).href
  const script = `
    import { writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { AgentWatch } from ${JSON.stringify(target)}
    new AgentWatch({ roots: [${JSON.stringify(root)}], changed: () => {}, settleMs: 5000 })
    setTimeout(() => {
      writeFileSync(join(${JSON.stringify(root)}, 'scout', 'AGENT.md'), '---\\nname: Scout\\n---\\nLook.\\n')
    }, 100)
    // A ref'd timer whose only job is to keep this process alive long enough
    // for the write's own fs event to arrive and the settle timer to be
    // armed — without it, this process could exit before that event ever
    // arrives, which would prove nothing either way. A live recursive watcher
    // and a pending 5s settle timer are both outstanding by the time this
    // fires, and dispose() is deliberately never called: neither may be the
    // reason the process is still here after it.
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
  const harness = await start({}, stateDir)
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
