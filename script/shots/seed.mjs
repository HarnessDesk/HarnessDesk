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
 *   node script/shots/seed.mjs            # stage ~/.harnessdesk-shots
 *   node script/shots/seed.mjs --clean    # tear it down and stage it again
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAST, CONVERSATIONS, HISTORY, PRIMARY, REPOS } from './cast.mjs'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/* `agent.mjs`, not the repository's `fake-acp-agent.mjs` fixture: that one is
   written to be deliberately un-Codex and answers "hearing: … done.", which is
   correct for the adapter's tests and unpublishable in a screenshot. */
const AGENT = join(APP, 'script/shots/agent.mjs')

export const HOME = process.env['HD_SHOTS_HOME'] ?? join(homedir(), '.harnessdesk-shots')
/**
 * The repositories live under the real `$HOME`, not under the staged home.
 *
 * The project path is on camera — the board header prints it and so does the
 * approval dialog — and the app writes it with a tilde where it can. A folder
 * under `~/work` photographs as `~/work/storefront`, which reads like
 * somebody's checkout. A folder under `~/.harnessdesk-shots/work` photographs
 * as a rig.
 */
export const WORK = process.env['HD_SHOTS_WORK'] ?? join(homedir(), 'work')

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
 * The Chromium profile under `electron/` is left alone — it is a browser
 * profile, not app state, and rebuilding it costs seconds of cold start for
 * nothing.
 */
const RESIDUE = ['team', 'transcripts', 'cache', 'stores', 'usage.sqlite', 'audit.ndjson', 'state.json', 'agents.json', 'window.json']
for (const name of RESIDUE) rmSync(join(HOME, name), { recursive: true, force: true })

if (process.argv.includes('--clean')) {
  rmSync(HOME, { recursive: true, force: true })
  for (const repo of REPOS) rmSync(join(WORK, repo.dir), { recursive: true, force: true })
  say(`cleaned ${HOME} and ${REPOS.length} repositories`)
}

mkdirSync(join(HOME, 'stores'), { recursive: true })
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

writeFileSync(
  join(HOME, 'agents.json'),
  `${JSON.stringify(
    {
      agents: CAST.map((agent, n) => ({
        id: agent.id,
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
      })),
    },
    null,
    2,
  )}\n`,
)

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

say(`agents: ${CAST.length}  (${CAST.map((one) => one.name).join(', ')})`)
say(`home:   ${HOME}`)
