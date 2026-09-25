#!/usr/bin/env node
/**
 * Stage a desk worth photographing, out of nothing.
 *
 * Every screenshot in `docs/images/` is the real Electron app — the window,
 * the sidebar, the panes — driven against **this** home rather than the one
 * you work in. That distinction is the whole point. The first hero image in
 * this README was a photograph of a real desk, and it carried real room names
 * tied to real pull requests, a real branch name and a real account label into
 * a file meant for strangers. A screenshot rig that borrows your desk will do
 * that every time; one that builds its own cannot.
 *
 * So this writes a complete, invented world: twelve agents that are all the
 * same fake ACP fixture wearing different brands, their conversation histories,
 * three repositories with real git objects and a branchy history for the graph
 * to draw, and the workspace list that ties them together. It is idempotent —
 * run it before every take, because a take leaves its own turns behind.
 *
 *   node script/shots/seed.mjs            # stage the rig's own temp-dir home
 *   node script/shots/seed.mjs --clean    # tear it down and stage it again
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAST, CONVERSATIONS, HISTORY, PRIMARY, REPOS, rigRuntimeId } from './cast.mjs'
import { HOME, NATIVE_CODEX, SHOT_ENV, WORK } from './config.mjs'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/* `agent.mjs`, not the repository's `fake-acp-agent.mjs` fixture: that one is
   written to be deliberately un-Codex and answers "hearing: … done.", which is
   correct for the adapter's tests and unpublishable in a screenshot. */
const AGENT = join(APP, 'script/shots/agent.mjs')
// The built-in Codex adapter is the one row that can ever hold a ceiling
// (`NATIVE_CODEX`, `config.mjs`, #927) — on by default, so the camera-only
// ACP row must leave the `codex` id free unless staging was asked for the
// all-camera desk (`HD_SHOTS_NATIVE_CODEX=0`).
const REGISTERED_CAST = NATIVE_CODEX
  ? CAST.filter((agent) => agent.id !== 'codex')
  : CAST

/**
 * The repositories live under `WORK`, a "person" folder nested one level
 * inside the staged home — never under this machine's real `$HOME`.
 *
 * The project path is on camera — the board header prints it and so does the
 * approval dialog — and the app writes it with a tilde where it can. The
 * drivers (`shoot.mjs`, `gif.mjs`) shorten `WORK`'s parent folder to `~`
 * rather than `WORK` itself, so a folder that physically sits under
 * `HOME/person/work` still photographs as `~/work/storefront`, which reads
 * like somebody's checkout, without ever putting a real repository under this
 * machine's actual home (`config.mjs`).
 */
const say = (line) => process.stdout.write(`  ${line}\n`)

/**
 * Every take starts from the same desk.
 *
 * The app writes as it runs — rooms into `team/`, turns into `transcripts/`,
 * a priced ledger into `usage.sqlite` — and none of that is seeded, so it
 * accumulates across takes. Three runs of the room scene put three rooms of
 * one name in the sidebar, two of them empty, which is a picture of a rig
 * rather than of a product.
 *
 * `usage.sqlite` matters for a second reason: it is the ledger's own store,
 * and a ledger that ever ran unstubbed has this machine's real spend in it.
 * Deleting it every take means a stale one can never be photographed.
 *
 * `goals/` is the one that bites hardest. Every Goal — the room the board and
 * room scenes build, and the one the flow and flow-board scenes create fresh
 * — lives there as its own document. Left unswept, a Goal from take one is
 * still on disk for take two, and `GoalPlane` re-installs it as a Team
 * projection on every boot: its sentence is a permanent, agent-less row in
 * the sidebar — "Working"/"Needs you" with "No agents in here yet", because
 * the room and its agents are gone but the Goal document is not. The memory
 * citation archive lives under `goals/memory-archive`, so clearing the one
 * directory clears both.
 *
 * A Goal document carries no Seat of its own — the schema forbids a
 * `members` field — so this is not what made `--scene room` refuse "This
 * conversation already holds a Seat." A Seat is `evidence/`'s to keep, and
 * `evidence/` was already cleared here before this fix. That refusal comes
 * from running takes without a reseed between them: a Seat this desk opened
 * stays open — by design, the same way it would across a real restart —
 * until something closes it, so a `shoot.mjs` invocation that follows another
 * one on the same un-reseeded home can still find its first session already
 * seated. Reseeding before every take, which this file's own header has
 * always said to do, already prevents that; nothing here changes it.
 *
 * The rest of this list is every other place a later phase taught the host to
 * write beside `goals/`: the Flows engine's own run records (`flows/`,
 * `flows-v2/`, and the change-notice snapshot in `flow-updates/`), a Seat's
 * attachment receipts and staged/frozen copies (`attachments/` and
 * `attachment-trust.json`), a trigger's consent, cursor and post bookkeeping
 * (`intake.json` and the `triggers-*` files), the session archive and its
 * names (`archive.json`, `names.json`), stored credentials nothing here
 * should ever populate (`credentials.json`), the worktree-lane allocator
 * (`lanes/`, `worktrees/`), the library's own writes (`library/`), and the
 * desk's own write lease, which a killed take can leave mid-recovery
 * (`desk-writer.lock`, `desk-writer-recovery`).
 *
 * `browser-profile/` is cleared too — it is the in-app browser tool's own
 * webview partition, and no scene relies on anything a previous take left in
 * it (the browser scene always opens its own fresh local fixture). The
 * Chromium profile under `electron/` is left alone, because that one *is*
 * relied on: it is the Electron shell's own profile, not app state, and
 * rebuilding it costs seconds of cold start for nothing.
 */
const RESIDUE = [
  'team', 'transcripts', 'cache', 'stores', 'usage.sqlite', 'audit.ndjson', 'state.json',
  'agents.json', 'agents', 'seating.json', 'window.json', 'codex-version', 'evidence',
  'provenance', 'provenance-preferences.json', 'provenance-shots.json', 'commands-seen.json',
  'commands-seen.key', 'seat-record-scene.json',
  'goals', 'flows', 'flows-v2', 'flow-updates', 'attachments', 'attachment-trust.json',
  'intake.json', 'triggers-machine.json', 'triggers-key.bin', 'triggers-preferences.json',
  'triggers-desk-posts.json', 'triggers-cursors.json', 'archive.json', 'names.json',
  'credentials.json', 'lanes', 'worktrees', 'desk-writer.lock', 'desk-writer-recovery',
  'browser-profile', 'library',
]

/**
 * A folder this rig has actually staged before, the one it stages by
 * default, or one with nothing in it yet. Anything else is refused outright,
 * before a single byte is written.
 *
 * Widening `RESIDUE` — and `--clean` has always removed the whole folder —
 * raises what a mistaken `HD_SHOTS_HOME` costs: pointed at a real desk's
 * `~/.harnessdesk`, or at `$HOME` itself, either one would now delete real
 * credentials, real Goals and real git worktrees rather than a rig's own
 * (#909 review, P3-3). Anything has to prove it is this rig's own folder,
 * which it does by carrying the marker an earlier seed wrote, or by being
 * empty. That includes the default path: it earned no special trust here —
 * `config.mjs` already refuses to hand back a default that is a symlink
 * rather than a real folder, but a real folder holding somebody else's
 * files is a mistake this guard exists to catch regardless of whether the
 * path came from an override or was never asked for at all.
 *
 * A first version of this guard skipped the deletions on an unmarked folder
 * but still wrote the marker and then went on to overwrite `agents.json`,
 * `state.json` and the rest of a fresh seed over whatever was there — so a
 * mistaken `HD_SHOTS_HOME` lost its registry and state on the first run and
 * its credentials, Goals and worktrees on the very next one, once that first
 * run had marked it (#909 review, P2-2). "Leave it alone" only holds if nothing
 * is written at all: the marker is earned by being empty, not merely unmarked,
 * and an unmarked folder that already holds something refuses the whole run,
 * this line included, rather than seeding around the question.
 */
const MARKER_NAME = '.rig-home.json'
const MARKER = join(HOME, MARKER_NAME)
const empty = !existsSync(HOME) || readdirSync(HOME).length === 0
const rigOwnsHome = empty || existsSync(MARKER)

if (!rigOwnsHome) {
  process.stderr.write(
    `\n  HD_SHOTS_HOME (${HOME}) is not empty and carries no ${MARKER_NAME} from an earlier seed, so this rig cannot tell it apart from a real desk's home. Refusing to write anything here.\n` +
      `  Point HD_SHOTS_HOME at an empty folder, the default (a fixed folder under the OS temp directory), or one seed.mjs has already staged.\n\n`,
  )
  process.exit(1)
}

/**
 * Refuses the whole run, before a single deletion, if any entry `RESIDUE` is
 * about to clear is a symlink rather than a real file or folder this rig
 * staged.
 *
 * `rmSync(recursive: true)` never follows a symlink it is handed directly —
 * given one, it unlinks the link itself and leaves whatever it points to
 * alone, proven in this file's own tests — so a link left in `RESIDUE`'s
 * place is not a deletion hazard by itself. It is still refused: a link
 * standing where this rig's own file belongs means something other than a
 * normal take put it there, and continuing would seed a fresh file or folder
 * right beside a stranger's link rather than say so. Checked as one pass
 * over every entry before any of them is touched, so a link found on entry
 * twelve does not leave the first eleven already deleted.
 */
for (const name of RESIDUE) {
  let info
  try {
    info = lstatSync(join(HOME, name))
  } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
  if (info.isSymbolicLink()) {
    process.stderr.write(
      `\n  ${join(HOME, name)} is a symlink, not a file or folder this rig staged. Refusing to delete through it.\n` +
        `  Remove it by hand if you put it there on purpose, then reseed.\n\n`,
    )
    process.exit(1)
  }
}

for (const name of RESIDUE) rmSync(join(HOME, name), { recursive: true, force: true })
if (process.argv.includes('--clean')) {
  rmSync(HOME, { recursive: true, force: true })
  for (const repo of REPOS) rmSync(join(WORK, repo.dir), { recursive: true, force: true })
  say(`cleaned ${HOME} and ${REPOS.length} repositories`)
}

mkdirSync(HOME, { recursive: true })
writeFileSync(MARKER, `${JSON.stringify({ version: 1, rig: 'harnessdesk-shots' })}\n`)

mkdirSync(join(HOME, 'stores'), { recursive: true })
mkdirSync(SHOT_ENV.CODEX_HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })

// ------------------------------------------------------------ the repositories
/**
 * A repository with a history the graph pane can draw.
 *
 * `HISTORY` is replayed literally: `from` starts a branch off another, `merge`
 * joins one back with `--no-ff` so the merge commit exists as an object rather
 * than being fast-forwarded away. A fast-forward makes a correct history and a
 * straight line, and a straight line is not worth a screenshot.
 */
const buildRepo = (dir, blurb) => {
  const at = join(WORK, dir)
  if (existsSync(join(at, '.git'))) return at
  mkdirSync(join(at, 'src'), { recursive: true })

  const git = (...args) => execFileSync('git', args, { cwd: at, stdio: 'pipe' })
  const commit = (message, n) => {
    writeFileSync(join(at, 'src', `step-${n}.ts`), `// ${message}\nexport const step = ${n}\n`)
    git('add', '-A')
    git('commit', '-m', message)
  }

  writeFileSync(join(at, 'README.md'), `# ${dir}\n\n${blurb}\n`)
  writeFileSync(join(at, 'package.json'), `${JSON.stringify({ name: dir, private: true, version: '2.4.1' }, null, 2)}\n`)
  git('init', '--initial-branch=main')
  // Set locally, never globally: `user.*` names both the author and the
  // committer, and the graph pane draws that name. Left unset, git would sign
  // these commits with whoever owns the machine — which is the leak this rig
  // exists to prevent, one pane over from where it was first found.
  git('config', 'user.email', PRIMARY.email)
  git('config', 'user.name', PRIMARY.name)
  // A machine with commit signing on globally would otherwise stop here
  // waiting for a passphrase, with no output to say why.
  git('config', 'commit.gpgsign', 'false')

  /* `current` is tracked rather than checked out every time, because
     `git checkout main` on a repository with no commits yet fails — the
     initial branch is where HEAD points, not a ref that exists. */
  let step = 0
  let current = 'main'
  const goTo = (branch) => {
    if (current === branch) return
    git('checkout', branch)
    current = branch
  }
  for (const entry of HISTORY) {
    step += 1
    if (entry.merge) {
      goTo(entry.into)
      git('merge', '--no-ff', entry.merge, '-m', entry.message)
      continue
    }
    if (entry.from) {
      git('checkout', '-b', entry.branch, entry.from)
      current = entry.branch
    } else goTo(entry.branch)
    commit(entry.message, step)
  }
  goTo('main')
  return at
}

const roots = Object.fromEntries(REPOS.map((repo) => [repo.dir, buildRepo(repo.dir, repo.blurb)]))
say(`repositories: ${REPOS.map((one) => one.dir).join(', ')}  (under ${WORK})`)

// ------------------------------------------------------------------ the check
if (!existsSync(join(roots.storefront, '.harnessdesk', 'checks.yml'))) {
  mkdirSync(join(roots.storefront, '.harnessdesk'), { recursive: true })
  mkdirSync(join(roots.storefront, 'test'), { recursive: true })
  writeFileSync(join(roots.storefront, '.harnessdesk', 'checks.yml'), 'verify: { run: node --test, timeout: 120 }\n')
  writeFileSync(
    join(roots.storefront, 'test', 'retry.test.mjs'),
    "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n\ntest('a 502 is retried', () => {\n  assert.ok([502, 503, 504].includes(502))\n})\n",
  )
  const git = (...args) => execFileSync('git', args, { cwd: roots.storefront, stdio: 'pipe' })
  git('add', '-A')
  git('commit', '-m', 'Name the verify check')
}
say('checks: storefront names verify (node --test)')

// ------------------------------------------------------------------ the desks
/**
 * One conversation store per agent, in the shape `fake-acp-agent.mjs` reads.
 *
 * `turns` carries the ask as the agent stored it, which is what `session/list`
 * serves back and what the sidebar row shows. `updatedAt` is what it sorts by,
 * so the ages in `cast.mjs` decide the order the reader sees.
 */
const storeFor = (agentId) =>
  Object.fromEntries(
    (CONVERSATIONS[agentId] ?? []).map(([title, minutesAgo, repo, answer], n) => {
      const id = `${agentId}-${n}`
      return [
        id,
        {
          sessionId: id,
          cwd: roots[repo],
          title,
          updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          turns: [[title, answer]],
        },
      ]
    }),
  )

for (const agent of CAST) {
  writeFileSync(join(HOME, 'stores', `${agent.id}.json`), JSON.stringify(storeFor(agent.id), null, 1))
}

/**
 * Windsurf's own sign-in answer: signed out.
 *
 * The host reads whether a seat is signed in from the runtime itself, not
 * from the renderer's account rows the rig answers — so the one runtime the
 * Agent scenes need signed out has to say so where the host asks. Windsurf,
 * because no other scene seats it.
 */
const SIGNED_OUT = { command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({ loggedIn: false }))'] }

writeFileSync(
  join(HOME, 'agents.json'),
  `${JSON.stringify(
    {
      agents: REGISTERED_CAST.map((agent, n) => ({
        id: rigRuntimeId(agent.id),
        name: agent.name,
        brand: agent.brand,
        tagline: agent.tagline,
        command: 'node',
        args: [AGENT],
        env: {
          SHOT_AGENT_NAME: agent.name,
          SHOT_STORE: join(HOME, 'stores', `${agent.id}.json`),
          SHOT_MODELS: agent.models,
          /* Which scripted turn this seat plays. The room seats the first four
             of the cast, so 0-3 land one distinct turn on each of them. */
          SHOT_TURN: String(n % 4),
        },
        ...(agent.id === 'windsurf' ? { account: { status: SIGNED_OUT } } : {}),
      })),
    },
    null,
    2,
  )}\n`,
)

/**
 * `preferences` starts empty on every seed, deliberately — it is not merged
 * with whatever a previous take's app process wrote here while it ran.
 *
 * `preferences.layouts` is where the renderer persists each workspace's pane
 * arrangement (`packages/ui/src/state/store.ts`'s `#keepWorkbench`), and a
 * layout can hold a docked browser pane — its tabs, and each tab's URL. An
 * earlier `browser` take leaves exactly that behind: run it, then shoot a
 * later scene against the same un-reseeded home, and that scene's window
 * restores with the previous take's browser panel still docked, address bar
 * and all. Writing `{}` here rather than reading and merging the file this
 * would otherwise overwrite is what clears it — RESIDUE already deletes this
 * file outright, so a hand-merge would have nothing of the rig's own to lose,
 * only ever a previous take's panel and dock state.
 */
writeFileSync(
  join(HOME, 'state.json'),
  `${JSON.stringify(
    {
      version: 1,
      installId: 'shots',
      workspaces: REPOS.map((repo, n) => ({
        id: `ws-${repo.dir}`,
        path: roots[repo.dir],
        name: repo.name,
        lastOpenedAt: Date.now() - n * 60_000,
      })),
      preferences: {},
    },
    null,
    2,
  )}\n`,
)

// ------------------------------------------------------------------ the Agents
/**
 * Agents, in all three places the roster reads: the storefront's own Code
 * reviewer, which shadows the one that ships; one of yours that nothing here
 * can seat; and this Mac's seats for the project's reviewer, the first of
 * them passed over on the way. Seats name the rig's runtimes, except the one
 * meant to be missing, so no Agent reads through to a CLI on this machine.
 */
const agentFile = ({ name, description, prefer, brief }) =>
  `---\nname: ${name}\ndescription: ${description}\npermission: read\nanswers: [approve, request-changes]\nproduces: [review]\nprefer: [${prefer.join(', ')}]\n---\n\n${brief}\n`

const writeAgent = (dir, source) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENT.md'), source)
}

writeAgent(
  join(roots.storefront, '.harnessdesk', 'agents', 'code-reviewer'),
  agentFile({
    name: 'Code reviewer',
    description: 'The storefront’s reviewer: reads a change against the checkout rules before anyone merges it.',
    prefer: ['codex'],
    brief:
      'You review a change to the storefront that somebody else wrote. Read the whole diff before you report, and hold every change to the checkout rules: money in minor units, retries capped, nothing charged twice.\n\n## How to report\n\nEvery finding with its file and line, blocking ones first, then a verdict: approve, or request changes.',
  }),
)

/* The evidence scenes run a check bound to a commit. The project Agent is a
   project file too, so leaving it untracked would make that check about dirty
   work and its passing fact could never make the card Ready. */
{
  const status = execFileSync('git', ['-C', roots.storefront, 'status', '--porcelain', '--', '.harnessdesk/agents'], {
    encoding: 'utf8',
  })
  if (status.trim()) {
    execFileSync('git', ['-C', roots.storefront, 'add', '.harnessdesk/agents'], { stdio: 'pipe' })
    execFileSync('git', ['-C', roots.storefront, 'commit', '-m', 'Add the storefront reviewer'], { stdio: 'pipe' })
  }
}

writeAgent(
  join(HOME, 'agents', 'release-checker'),
  agentFile({
    name: 'Release checker',
    description: 'Reads a release branch against its changelog before it is tagged.',
    // Signed out, then not added here at all: two reasons, two fixes, and no seat.
    prefer: [rigRuntimeId('windsurf'), 'claude-code'],
    brief:
      'You check a release branch before it is tagged: every change in the changelog is in the branch, and every change in the branch is in the changelog.\n\n## How to report\n\nWhat is missing from each side, then a verdict.',
  }),
)

writeFileSync(
  join(HOME, 'seating.json'),
  `${JSON.stringify({ 'code-reviewer': [rigRuntimeId('windsurf'), `${rigRuntimeId('claude-code')}=opus`] }, null, 2)}\n`,
)
say('agents: storefront’s Code reviewer (shadows the one that ships), Release checker (yours), seats for this Mac')

say(`agents: ${REGISTERED_CAST.length} registered  (${REGISTERED_CAST.map((one) => one.name).join(', ')})`)

/* The optional provenance takes start with historical Phase 4 facts, not a
   renderer-only response. The host still discovers/reconciles commits after
   it starts. A small JSON manifest is a rig seam, not production state: the
   camera driver reads it without importing this staging script (which would
   rebuild the desk while the app is running). */
if (process.env.HD_SHOTS_PROVENANCE === '1') {
  const { EvidenceStore } = await import('../../packages/server/dist/src/evidence/store.js')
  const project = realpathSync(roots.storefront)
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()
  const commits = git('rev-list', '--reverse', '--no-merges', 'HEAD').split('\n').slice(1, 3)
  if (commits.length !== 2) throw new Error('The provenance camera needs two non-root changes.')
  const evidence = new EvidenceStore(join(HOME, 'evidence'))
  const at = Date.now()
  const observations = []
  for (const [index, sha] of commits.entries()) {
    const agent = REGISTERED_CAST[index]
    if (!agent) throw new Error('The provenance camera needs two scripted agents.')
    const sessionId = `${agent.id}-0`
    const id = `provenance-seat-${index + 1}`
    const from = git('rev-parse', `${sha}^`)
    const session = { runtime: rigRuntimeId(agent.id), sessionId }
    await evidence.append(project, 'seats', [{
      type: 'seat', record: {
        id, agent: { id: `contributor-${index + 1}`, name: `Contributor ${index + 1}`, origin: 'project' },
        briefDigest: null, seat: { runtime: session.runtime }, seatLabel: agent.name, passedOver: [],
        standing: { kind: 'permission', permission: 'read' }, ceiling: null,
        checkout: { cwd: project, project, branch: 'main', head: from }, session, board: null, role: null, openedAt: at - 1,
      },
    }])
    const counts = git('diff', '--numstat', from, sha).split('\n').filter(Boolean).map((line) => line.split('\t'))
    await evidence.append(project, 'evidence', [{
      type: 'evidence', record: {
        id: `provenance-fact-${index + 1}`,
        fact: { kind: 'diff', files: counts.length, added: counts.reduce((sum, line) => sum + (Number(line[0]) || 0), 0), removed: counts.reduce((sum, line) => sum + (Number(line[1]) || 0), 0), from, to: sha },
        seat: id, checkout: { cwd: project, branch: 'main' }, observedAt: at,
      },
    }])
    observations.push({ project, sha, seat: id, name: `Contributor ${index + 1}` })
  }
  await evidence.flush()
  writeFileSync(join(HOME, 'provenance-shots.json'), `${JSON.stringify(observations)}\n`)
  say('provenance: two synthetic Seats and local diff facts')
}

say(`home:   ${HOME}`)
