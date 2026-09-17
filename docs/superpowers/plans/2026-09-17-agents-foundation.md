# Agents Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an Agent — a named, reusable directory holding a brief, a permission ceiling and a seating preference — a real object the desk can list, resolve and open a conversation as.

**Architecture:** Three new modules, following the split this codebase already uses between pure decisions and effects (`flow.ts` decides, `flows.ts` acts). `agent-def.ts` parses one `AGENT.md` and never touches disk. `agent-seating.ts` picks a seat from ordered candidates and never touches the network. `agents.ts` walks three directories, applies precedence, and marks what it shadowed. One wire module answers `agent/*`, which a prerequisite task frees up by moving the ACP registry verbs into an `acp/*` namespace.

**Tech Stack:** TypeScript (ESM, `node16` resolution — every relative import ends `.js`), `node:test` + `node:assert/strict` for server tests, the repository's own `parseYaml` (`packages/server/src/yaml.ts` — there is no YAML dependency), pnpm workspaces.

## Global Constraints

- **This plan is phase 1 of 10.** It ships Agents only: no Goal, no Evidence, no flow-engine change, no binding. The other plans are listed at the bottom; do not reach into them.
- **Design source:** `docs/superpowers/specs/2026-09-17-agents-and-goals-design.md`. Where this plan and the spec disagree, the spec is right and the plan is a bug.
- **No competitor or third-party product names** in code, comments, commit messages, PR titles or PR bodies. Prior-art reasoning lives outside the repository.
- **`permission` is a ceiling, never a grant.** A Seat gets `min(agent ceiling, step grant)` and a step grants `read` by default. Nothing in this plan may widen an Agent's permission.
- **Refuse, never substitute.** When no candidate seat can be opened, the error names every candidate and why each failed. Silently seating a different model is the one outcome this feature must never produce.
- **`agents.json` is not renamed.** It faces the Agent Client Protocol, where "agent" is the correct word for an installed CLI. Only wire verbs and human-facing labels move.
- **Precedence is project → user → built-in**, and a shadowed Agent is listed and marked, never hidden.
- **Every test must be able to fail.** A test that would pass against an empty implementation is not a test; assert the specific value, not that something is truthy.
- **Commit after every task.** Run `pnpm verify` before a commit and read its exit status directly — never pipe it, because the pipe discards the status and a failing gate looks green.

---

### Task 1: Free the `agent/*` namespace

The wire's `agents/*` prefix is six methods that mix two unrelated jobs: five read or write `agents.json` (the ACP registry) and two answer questions about one runtime's install on this machine. Moving them by what they touch frees both `agent/*` and `agents/*` for the new noun, with no singular-plural trap left behind.

**Files:**
- Modify: `packages/protocol/src/wire.ts` (the six `agents/*` declarations)
- Modify: `packages/protocol/src/wire-validators.ts` (their param validators)
- Modify: `packages/server/src/methods/accounts.ts` (the handlers)
- Modify: `packages/server/src/methods/index.ts` (the docstring naming which module takes which prefix)
- Modify: every renderer caller — find them with the grep in Step 1
- Test: `packages/server/test/methods.test.ts` (asserts every declared method has exactly one handler — this is the control, not `conformance.test.ts`, which is the adapter suite and says nothing about the method table)

**Interfaces:**
- Consumes: nothing.
- Produces: the names `acp/registry`, `acp/register`, `acp/remove`, `acp/update`, `acp/catalog`, `runtime/installs`, `runtime/installs/use`. Task 5 relies on `agent/*` being unused.

- [ ] **Step 1: Find every caller before changing anything**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -rn "agents/registry\|agents/register\|agents/remove\|agents/update\|agents/catalog\|agents/installs" \
  packages --include='*.ts' --include='*.tsx' | grep -v '/dist/'
```

Expected: hits in `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts`, `packages/server/src/methods/accounts.ts`, and renderer callers under `packages/ui/src/`. Write the list down; every one of them changes in Step 3.

- [ ] **Step 2: Run the method-table test to see it green before the move**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/methods.test.js`
Expected: PASS. This is the control: it must pass now, fail in the middle of the rename, and pass again at the end. A rename that never reddens it is a rename that did not take.

- [ ] **Step 3: Rename the five registry verbs and move the two install verbs**

In `packages/protocol/src/wire.ts`, `wire-validators.ts`, `packages/server/src/methods/accounts.ts` and every caller from Step 1, apply exactly this mapping:

| From | To |
| --- | --- |
| `agents/registry` | `acp/registry` |
| `agents/register` | `acp/register` |
| `agents/remove` | `acp/remove` |
| `agents/update` | `acp/update` |
| `agents/catalog` | `acp/catalog` |
| `agents/installs` | `runtime/installs` |
| `agents/installs/use` | `runtime/installs/use` |

Do not change any handler body, any param shape or any result shape. This task is names only.

In `packages/server/src/methods/index.ts`, the docstring says `accounts` holds `agents/*`. Change that clause to say it holds `acp/*` and the account and API-key verbs, and that `runtime/installs*` sits with the rest of `runtime/` in `runtimes.ts` — or, if moving the two handlers between modules is more churn than the sentence is worth, say plainly that `accounts.ts` also answers `runtime/installs*` and why.

- [ ] **Step 4: Build (which typechecks), then run the method-table test**

Run: `pnpm run build:node`
Expected: PASS. A missed caller fails here, because `HostMethodName` is a union of the declared names, and the build is what typechecks the server packages.

Do **not** use `pnpm run typecheck`: `tsc -b --noEmit` is incompatible with this repository's composite project references and fails with `TS6310` regardless of your changes. `pnpm verify` does not use it either.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/methods.test.js`
Expected: PASS.

- [ ] **Step 5: Verify no stale name survives**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -rn "'agents/" packages --include='*.ts' --include='*.tsx' | grep -v '/dist/'
```

Expected: no output. Any hit is a caller Step 1 missed.

- [ ] **Step 6: Update the documentation this rename makes wrong**

`docs/agents.md` is titled for the installed CLIs and `docs/README.md` describes
it as "which copy of an agent runs". Both become wrong the moment the interface
says Runtime, so they move with the code rather than after it:

- Rename `docs/agents.md` to `docs/runtimes.md` with `git mv`, and change its
  prose from "agent" to "runtime" wherever it means the installed CLI. Leave
  every mention that means an ACP agent alone — `agents.json` keeps its name and
  its sentences.
- Update the row for it in `docs/README.md`, and every inbound link:
  `grep -rn 'agents\.md' docs/ README.md CONTRIBUTING.md`.
- In `docs/multi-agent.md`, leave the delegation section as it is. It is already
  correct and this rename does not touch it.

Do **not** describe Agents, Goals or Evidence in `docs/` yet. Those pages
describe what ships, and none of it ships until its phase lands; the table at the
end of this plan says which page each later phase owes.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm verify
git add packages/protocol/src packages/server/src packages/ui/src
git commit -m "refactor(wire): the ACP registry verbs move under acp/

Five of the six agents/* verbs read or write agents.json, which is the ACP
registry; two answer questions about one runtime's install on this machine and
already resolve a runtime from their params. Splitting them by what they touch
puts the install pair with its siblings under runtime/ and frees agent/* for a
noun that is not a runtime."
```

---

### Task 2: `AgentDefinition`, and a parser that never throws

**Files:**
- Create: `packages/protocol/src/agent.ts`
- Modify: `packages/protocol/src/index.ts` (add the export)
- Create: `packages/server/src/agent-def.ts`
- Test: `packages/server/test/agent-def.test.ts`

**Interfaces:**
- Consumes: `FlowSeat` and `seatAt` from `packages/protocol/src/flow.ts` and `packages/server/src/flow.ts` — the seat-spec type and its parser already exist and this task must not duplicate them.
- Produces:
  - `AgentDefinition` — `{ id, name, description, permission, answers, produces, skills, prefer, brief }`
  - `AgentProblem` — `{ level: 'error' | 'warning', at: string, text: string }`
  - `parseAgentDefinition(source: string, id: string): { agent: AgentDefinition | null; problems: AgentProblem[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/agent-def.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAgentDefinition } from '../src/agent-def.js'

/**
 * One AGENT.md, read. The parser reports problems and never throws, the way
 * `parseFlow` does, because a file somebody is still editing must not take a
 * listing down with it.
 */

const REVIEWER = `---
name: Code reviewer
description: Reads a diff it did not write and reports findings.
permission: read
answers: [approve, request-changes]
produces: [review]
skills: [review-checklist]
prefer: [cursor=gemini-3.8-flash/high, claude=opus-5/high]
---

Sweep the whole diff before reporting.
`

test('a complete definition parses, and the body is the brief', () => {
  const { agent, problems } = parseAgentDefinition(REVIEWER, 'code-reviewer')
  assert.deepEqual(problems, [])
  assert.equal(agent?.id, 'code-reviewer')
  assert.equal(agent?.name, 'Code reviewer')
  assert.equal(agent?.permission, 'read')
  assert.deepEqual(agent?.answers, ['approve', 'request-changes'])
  assert.deepEqual(agent?.produces, ['review'])
  assert.deepEqual(agent?.skills, ['review-checklist'])
  assert.equal(agent?.brief, 'Sweep the whole diff before reporting.')
})

test('prefer is parsed with the seat grammar the flow engine already uses', () => {
  const { agent } = parseAgentDefinition(REVIEWER, 'code-reviewer')
  assert.equal(agent?.prefer.length, 2)
  assert.deepEqual(agent?.prefer[0], {
    runtime: 'cursor',
    model: 'gemini-3.8-flash',
    effort: 'high',
    thinking: false,
  })
  assert.equal(agent?.prefer[1]?.runtime, 'claude')
})

test('permission defaults to read, the narrowest ceiling', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Scout\n---\nLook around.\n', 'scout')
  assert.deepEqual(problems, [])
  assert.equal(agent?.permission, 'read')
})

test('an unknown permission is an error, not a silent widening', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Bad\npermission: admin\n---\nx\n',
    'bad',
  )
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.level, 'error')
  assert.equal(problems[0]?.at, 'permission')
  assert.match(problems[0]?.text ?? '', /read, publish or merge/)
})

test('a file with no front matter is the brief, and says a name is missing', () => {
  const { agent, problems } = parseAgentDefinition('Just a brief.\n', 'plain')
  assert.equal(agent?.name, 'plain')
  assert.equal(agent?.brief, 'Just a brief.')
  assert.equal(problems.some((one) => one.level === 'warning' && one.at === 'name'), true)
})

test('an empty brief is an error — an Agent with no instructions is not an Agent', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Hollow\n---\n\n', 'hollow')
  assert.equal(agent, null)
  assert.equal(problems[0]?.at, 'brief')
})

test('broken YAML is reported at the line, and throws nothing', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: [unclosed\n---\nx\n', 'broken')
  assert.equal(agent, null)
  assert.equal(problems[0]?.level, 'error')
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/agent-def.js'`.

- [ ] **Step 3: Write the protocol types**

Create `packages/protocol/src/agent.ts`:

```ts
import type { FlowPermission, FlowSeat } from './flow.js'

/**
 * An Agent: **who** does the work, as opposed to which runtime runs it.
 *
 * A directory on disk, because a team's reviewer is a team decision and a
 * decision nobody can diff is a decision nobody can argue with. The brief is
 * the body of `AGENT.md`; everything above is its front matter.
 *
 * Deliberately absent: credentials and session history. Both already have a
 * plane, and two planes holding one fact are two planes that will disagree.
 */
export interface AgentDefinition {
  /** The directory name. Small, lowercase, and what a flow's `uses:` names. */
  readonly id: string
  readonly name: string
  readonly description?: string | null
  /**
   * A **ceiling**, never a grant. A Seat gets the narrower of this and the
   * step's grant, and a step grants `read` unless it says otherwise — so
   * writing needs the Agent and the step to agree.
   */
  readonly permission: FlowPermission
  /** The only words this Agent may report. Empty means the step decides. */
  readonly answers: readonly string[]
  /** Evidence kinds it must leave behind. */
  readonly produces: readonly string[]
  /** Skills it may load, by name. Empty means whatever the runtime already has. */
  readonly skills: readonly string[]
  /**
   * Ordered seat preference — the first candidate that is installed, signed in
   * and unspent is taken. The same grammar a flow role's `seats` uses, because
   * it is the same thing: `runtime[=model][/effort][+thinking]`.
   */
  readonly prefer: readonly FlowSeat[]
  /** The body of the file: what this Agent is for, in its author's words. */
  readonly brief: string
}

/** Where an Agent was found. Project beats user beats built-in. */
export type AgentOrigin = 'project' | 'user' | 'builtin'

/** The directory name, which an entry has even when its file does not parse. */
export type AgentId = string

/** One Agent as a listing shows it, with what it hid. */
export interface AgentEntry {
  /**
   * Null when the file did not parse. The entry still exists so the roster can
   * show what is broken and where — an unusable Agent that vanishes from the
   * list is the same defect as a shadowed one that vanishes.
   */
  readonly definition: AgentDefinition | null
  /** The directory name. Present even when `definition` is null. */
  readonly id: AgentId
  readonly origin: AgentOrigin
  readonly path: string
  /**
   * Content hash of the file, captured so a Seat can record which brief it ran.
   * Named `digest` rather than `brief` because `AgentDefinition.brief` is the
   * prose: one word for both would hand a later reader a hash where it expected
   * instructions, and the compiler could not object. `agent-inventory` already
   * uses `digest` for exactly this.
   */
  readonly digest: string
  /** Same id, lower precedence. Listed and marked, never hidden. */
  readonly shadows: readonly { readonly origin: AgentOrigin; readonly path: string }[]
  readonly problems: readonly AgentProblem[]
}

/** One thing wrong with a definition, and where. */
export interface AgentProblem {
  readonly level: 'error' | 'warning'
  /** `permission`, `prefer[1]`, `brief` — where to look. */
  readonly at: string
  readonly text: string
}
```

Add to `packages/protocol/src/index.ts`, in the alphabetical position its neighbours keep:

```ts
export type { AgentDefinition, AgentEntry, AgentId, AgentOrigin, AgentProblem } from './agent.js'
```

- [ ] **Step 4: Write the parser**

Create `packages/server/src/agent-def.ts`:

```ts
import type { AgentDefinition, AgentProblem, FlowPermission, FlowSeat } from '@harnessdesk/protocol'

import { seatAt } from './flow.js'
import { parseYaml, YamlError } from './yaml.js'

/**
 * One `AGENT.md`, parsed.
 *
 * Pure: no disk, no network, no clock. `agents.ts` finds the files and this
 * decides what they mean, the same way `flow.ts` decides and `flows.ts` acts.
 *
 * It reports problems and never throws. A listing is drawn while somebody is
 * still typing in one of these files, and one unparseable Agent must cost that
 * Agent rather than the roster.
 */

const PERMISSIONS: readonly FlowPermission[] = ['read', 'publish', 'merge']

const problem = (level: 'error' | 'warning', at: string, text: string): AgentProblem => ({ level, at, text })

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asWords = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((one) => String(one).trim()).filter(Boolean) : []

/** Splits `---` front matter from the body. A file with neither is all body. */
const split = (source: string): { front: string; body: string } => {
  if (!source.startsWith('---')) return { front: '', body: source }
  const end = source.indexOf('\n---', 3)
  if (end < 0) return { front: '', body: source }
  const after = source.indexOf('\n', end + 1)
  return {
    front: source.slice(source.indexOf('\n', 0) + 1, end),
    body: after < 0 ? '' : source.slice(after + 1),
  }
}

export const parseAgentDefinition = (
  source: string,
  id: string,
): { agent: AgentDefinition | null; problems: AgentProblem[] } => {
  const problems: AgentProblem[] = []
  const { front, body } = split(source)

  let head: Record<string, unknown> = {}
  if (front.trim()) {
    try {
      head = asRecord(parseYaml(front)) ?? {}
    } catch (error) {
      return {
        agent: null,
        problems: [
          problem(
            'error',
            error instanceof YamlError ? `line ${error.line}` : 'front matter',
            error instanceof Error ? error.message.replace(/^line \d+: /, '') : String(error),
          ),
        ],
      }
    }
  }

  const brief = body.trim()
  if (!brief) {
    problems.push(problem('error', 'brief', 'an Agent is its brief: write below the front matter what this one is for'))
  }

  const name = typeof head['name'] === 'string' && head['name'].trim() ? head['name'].trim() : id
  if (name === id && head['name'] === undefined) {
    problems.push(problem('warning', 'name', `no name, so this Agent is called “${id}” after its folder`))
  }

  let permission: FlowPermission = 'read'
  const declared = head['permission']
  if (declared !== undefined) {
    const word = String(declared).trim()
    if (!PERMISSIONS.includes(word as FlowPermission)) {
      problems.push(problem('error', 'permission', `“${word}” is not a permission: read, publish or merge`))
    } else {
      permission = word as FlowPermission
    }
  }

  const prefer: FlowSeat[] = []
  const wanted = Array.isArray(head['prefer']) ? head['prefer'] : []
  wanted.forEach((one, index) => {
    const seat = seatAt(String(one).trim())
    if (!seat) {
      problems.push(problem('error', `prefer[${index}]`, `“${String(one)}” is not a seat: runtime[=model][/effort]`))
      return
    }
    prefer.push(seat)
  })

  if (problems.some((one) => one.level === 'error')) return { agent: null, problems }

  return {
    agent: {
      id,
      name,
      description: typeof head['description'] === 'string' ? head['description'].trim() : null,
      permission,
      answers: asWords(head['answers']),
      produces: asWords(head['produces']),
      skills: asWords(head['skills']),
      prefer,
      brief,
    },
    problems,
  }
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-def.test.js`
Expected: PASS, 7 tests.

If `seatAt` is not exported from `packages/server/src/flow.ts`, export it there rather than copying the grammar — one parser for seat specs is the point.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm verify
git add packages/protocol/src/agent.ts packages/protocol/src/index.ts packages/server/src/agent-def.ts packages/server/test/agent-def.test.ts
git commit -m "feat(agents): an Agent definition, and a parser that reports instead of throwing

The brief is the body; the front matter is the ceiling, the vocabulary and the
seat preference. Permission defaults to read and an unknown one is refused
rather than widened. Seat specs reuse the flow engine's grammar and parser
because they are the same thing."
```

---

### Task 3: Find them, in precedence order, marking what is shadowed

**Files:**
- Create: `packages/server/src/agents.ts`
- Test: `packages/server/test/agents.test.ts`

**Interfaces:**
- Consumes: `parseAgentDefinition` from Task 2; `AgentEntry` and `AgentOrigin` from `@harnessdesk/protocol`.
- Produces: `class Agents { constructor(roots: AgentRoots); list(project?: string): Promise<AgentEntry[]>; read(id: string, project?: string): Promise<AgentEntry | null> }` and `interface AgentRoots { readonly user: string; readonly builtin: string }`. Every entry carries `id` and `problems`; `definition` is null when the file did not parse, and callers must narrow before reading it.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/agents.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Agents } from '../src/agents.js'

/**
 * Three directories, one winner, and the losers still visible.
 *
 * Hiding a shadowed Agent is how somebody spends an afternoon wondering why
 * their edit does nothing, so the rule the plugin roster already follows
 * applies here: listed and marked, never hidden.
 */

const write = async (dir: string, id: string, body: string) => {
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, 'AGENT.md'), body, 'utf8')
}

const brief = (name: string) => `---\nname: ${name}\n---\n${name} does the work.\n`

const rig = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agents-'))
  const project = join(root, 'project')
  const roots = { user: join(root, 'user'), builtin: join(root, 'builtin') }
  await mkdir(join(project, '.harnessdesk', 'agents'), { recursive: true })
  await mkdir(roots.user, { recursive: true })
  await mkdir(roots.builtin, { recursive: true })
  return { root, project, roots, agents: new Agents(roots) }
}

test('a project Agent beats a user one, which beats a built-in', async () => {
  const { project, roots, agents } = await rig()
  await write(join(project, '.harnessdesk', 'agents'), 'reviewer', brief('Project reviewer'))
  await write(roots.user, 'reviewer', brief('User reviewer'))
  await write(roots.builtin, 'reviewer', brief('Built-in reviewer'))

  const listed = await agents.list(project)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.definition?.name, 'Project reviewer')
  assert.equal(listed[0]?.origin, 'project')
})

test('what it beat is listed on it, in precedence order', async () => {
  const { project, roots, agents } = await rig()
  await write(join(project, '.harnessdesk', 'agents'), 'reviewer', brief('Project reviewer'))
  await write(roots.user, 'reviewer', brief('User reviewer'))
  await write(roots.builtin, 'reviewer', brief('Built-in reviewer'))

  const [entry] = await agents.list(project)
  assert.deepEqual(
    entry?.shadows.map((one) => one.origin),
    ['user', 'builtin'],
  )
})

test('without a project, the user roster is what there is', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'scout', brief('Scout'))
  const listed = await agents.list()
  assert.deepEqual(listed.map((one) => one.id), ['scout'])
  assert.equal(listed[0]?.origin, 'user')
})

test('the digest is stable for the same text and differs for different text', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'a', brief('Same'))
  await write(roots.user, 'b', brief('Same'))
  await write(roots.user, 'c', brief('Different'))
  const listed = await agents.list()
  const by = new Map(listed.map((one) => [one.id, one.digest]))
  assert.equal(by.get('a'), by.get('b'))
  assert.notEqual(by.get('a'), by.get('c'))
})

test('one broken Agent costs itself, not the roster', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'good', brief('Good'))
  await write(roots.user, 'broken', '---\npermission: admin\n---\nx\n')
  const listed = await agents.list()
  assert.equal(listed.map((one) => one.id).includes('good'), true)
  const bad = listed.find((one) => one.id === 'broken')
  // A broken Agent is listed, carries its problems, and has no definition —
  // rather than a hollow one a caller could mistake for a working Agent.
  assert.equal(bad?.definition, null)
  assert.equal(bad?.problems.some((one) => one.level === 'error'), true)
})

test('a missing directory is an empty roster, not a crash', async () => {
  const agents = new Agents({ user: join(tmpdir(), 'hd-absent-user'), builtin: join(tmpdir(), 'hd-absent-builtin') })
  assert.deepEqual(await agents.list(), [])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/agents.js'`.

- [ ] **Step 3: Write the discovery module**

Create `packages/server/src/agents.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { digestOf } from '@harnessdesk/agent-inventory'
import type { AgentEntry, AgentOrigin } from '@harnessdesk/protocol'

import { parseAgentDefinition } from './agent-def.js'

/**
 * The Agent roster: three directories, one winner per id.
 *
 * Project beats user beats built-in, and **what lost is listed on what won**.
 * A roster that quietly drops the copy somebody is editing is a roster that
 * costs them an afternoon, which is why the plugin roster states the same rule.
 */

export interface AgentRoots {
  /** `~/.harnessdesk/agents` — this machine. */
  readonly user: string
  /** Ships with the build. */
  readonly builtin: string
}

/** Where a project keeps the Agents it shares with everyone who clones it. */
export const PROJECT_AGENT_DIR = join('.harnessdesk', 'agents')

const FILE = 'AGENT.md'

const idsIn = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((one) => one.isDirectory()).map((one) => one.name).sort()
  } catch {
    // A roster directory nobody has made yet is an empty roster.
    return []
  }
}

export class Agents {
  constructor(private readonly roots: AgentRoots) {}

  /** Highest precedence first, so the first hit for an id is the winner. */
  private places(project?: string): { origin: AgentOrigin; dir: string }[] {
    const places: { origin: AgentOrigin; dir: string }[] = []
    if (project) places.push({ origin: 'project', dir: join(project, PROJECT_AGENT_DIR) })
    places.push({ origin: 'user', dir: this.roots.user })
    places.push({ origin: 'builtin', dir: this.roots.builtin })
    return places
  }

  async list(project?: string): Promise<AgentEntry[]> {
    const found = new Map<string, AgentEntry>()
    for (const place of this.places(project)) {
      for (const id of await idsIn(place.dir)) {
        const path = join(place.dir, id, FILE)
        const winner = found.get(id)
        if (winner) {
          found.set(id, {
          id, ...winner, shadows: [...winner.shadows, { origin: place.origin, path }] })
          continue
        }
        let source: string
        try {
          source = await readFile(path, 'utf8')
        } catch {
          // A directory with no AGENT.md is not an Agent.
          continue
        }
        const { agent, problems } = parseAgentDefinition(source, id)
        found.set(id, {
          // Null rather than a hollow stand-in: a definition that parsed and one
          // that did not must not be the same shape, or every later reader has
          // to guess which it got.
          definition: agent,
          origin: place.origin,
          path,
          // `digestOf` trims before hashing, so an inline copy of this would
          // disagree with every other digest in the desk on trailing whitespace.
          digest: digestOf(source),
          shadows: [],
          problems,
        })
      }
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  async read(id: string, project?: string): Promise<AgentEntry | null> {
    return (await this.list(project)).find((one) => one.id === id) ?? null
  }
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agents.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm verify
git add packages/server/src/agents.ts packages/server/test/agents.test.ts
git commit -m "feat(agents): the roster, in precedence order, marking what it shadowed

Project beats user beats built-in, and the copies that lost are listed on the
one that won. One unparseable definition costs itself and not the roster, and a
directory nobody has created is an empty roster rather than an error."
```

---

### Task 4: Pick a seat, or refuse and say what is missing

**Files:**
- Create: `packages/server/src/agent-seating.ts`
- Test: `packages/server/test/agent-seating.test.ts`

**Interfaces:**
- Consumes: `FlowSeat` from `@harnessdesk/protocol`.
- Produces:
  - `interface SeatOffer { readonly runtime: string; readonly models: readonly string[]; readonly efforts: readonly string[]; readonly signedIn: boolean; readonly spent: boolean }`
  - `type Seating = { readonly seat: FlowSeat; readonly passed: readonly PassedOver[] } | { readonly seat: null; readonly passed: readonly PassedOver[] }`
  - `interface PassedOver { readonly seat: FlowSeat; readonly why: string }`
  - `chooseSeat(candidates: readonly FlowSeat[], offers: readonly SeatOffer[]): Seating`
  - `explainRefusal(passed: readonly PassedOver[]): string`

Pure on purpose: the caller builds `offers` from the runtime registry, the accounts plane and the limits it already reads, so this file has no clock, no disk and no network and its every branch is reachable from a test.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/agent-seating.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chooseSeat, explainRefusal, type SeatOffer } from '../src/agent-seating.js'

/**
 * Ordered candidates, and an honest refusal.
 *
 * The one outcome this must never produce is a quiet substitution: a review
 * signed by a model that did not write it is worse than no review, so when
 * nothing can be seated the answer names every candidate and why each failed.
 */

const seat = (runtime: string, model?: string, effort?: string) => ({
  runtime,
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
  thinking: false,
})

const offer = (runtime: string, over: Partial<SeatOffer> = {}): SeatOffer => ({
  runtime,
  models: ['m1'],
  efforts: ['high'],
  signedIn: true,
  spent: false,
  ...over,
})

test('the first candidate that can be seated wins', () => {
  const chosen = chooseSeat([seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')], [offer('cursor'), offer('claude')])
  assert.equal(chosen.seat?.runtime, 'cursor')
  assert.deepEqual(chosen.passed, [])
})

test('a runtime that is not installed is passed over, with the reason', () => {
  const chosen = chooseSeat([seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')], [offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.equal(chosen.passed.length, 1)
  assert.match(chosen.passed[0]?.why ?? '', /not installed/)
})

test('signed out is passed over — and is not the same reason as absent', () => {
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')],
    [offer('cursor', { signedIn: false }), offer('claude')],
  )
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /signed out/)
})

test('a spent lane is passed over', () => {
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')],
    [offer('cursor', { spent: true }), offer('claude')],
  )
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /spent/)
})

test('a model the runtime does not offer is passed over, and the model is named', () => {
  const chosen = chooseSeat([seat('cursor', 'gone', 'high'), seat('claude', 'm1', 'high')], [offer('cursor'), offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /gone/)
})

test('an effort the runtime does not offer is passed over rather than dropped', () => {
  const chosen = chooseSeat([seat('cursor', 'm1', 'xhigh'), seat('claude', 'm1', 'high')], [offer('cursor'), offer('claude')])
  assert.equal(chosen.seat?.runtime, 'claude')
  assert.match(chosen.passed[0]?.why ?? '', /xhigh/)
})

test('a candidate with no model asks only for the runtime', () => {
  const chosen = chooseSeat([seat('cursor')], [offer('cursor', { models: [] })])
  assert.equal(chosen.seat?.runtime, 'cursor')
})

test('nothing seatable refuses, and the refusal names every candidate', () => {
  const chosen = chooseSeat(
    [seat('cursor', 'm1', 'high'), seat('claude', 'm1', 'high')],
    [offer('cursor', { signedIn: false })],
  )
  assert.equal(chosen.seat, null)
  assert.equal(chosen.passed.length, 2)
  const said = explainRefusal(chosen.passed)
  assert.match(said, /cursor/)
  assert.match(said, /claude/)
  assert.match(said, /signed out/)
})

test('an empty candidate list refuses rather than choosing for you', () => {
  const chosen = chooseSeat([], [offer('cursor')])
  assert.equal(chosen.seat, null)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/agent-seating.js'`.

- [ ] **Step 3: Write the chooser**

Create `packages/server/src/agent-seating.ts`:

```ts
import type { FlowSeat } from '@harnessdesk/protocol'

/**
 * Which seat an Agent takes here, and why not the ones above it.
 *
 * Pure: the caller builds the offers from the runtime registry, the accounts
 * plane and the limits it already reads. Every branch below is therefore
 * reachable from a test, which matters because the expensive failure of this
 * feature is silent: seating a different model than the one asked for.
 *
 * So there is no fallback that guesses. A candidate either matches an offer
 * exactly or is passed over with a reason a person can act on.
 */

export interface SeatOffer {
  readonly runtime: string
  /** Models this runtime currently offers. Empty means it does not take a model. */
  readonly models: readonly string[]
  readonly efforts: readonly string[]
  readonly signedIn: boolean
  /** Its window is exhausted; seating it now would fail or queue. */
  readonly spent: boolean
}

export interface PassedOver {
  readonly seat: FlowSeat
  readonly why: string
}

export interface Seating {
  readonly seat: FlowSeat | null
  readonly passed: readonly PassedOver[]
}

export const seatLabel = (seat: FlowSeat): string =>
  `${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}`

/** Why this candidate cannot be taken, or null when it can. */
const whyNot = (seat: FlowSeat, offers: readonly SeatOffer[]): string | null => {
  const offer = offers.find((one) => one.runtime === seat.runtime)
  if (!offer) return `${seat.runtime} is not installed`
  if (!offer.signedIn) return `${seat.runtime} is signed out`
  if (offer.spent) return `${seat.runtime}'s window is spent`
  if (seat.model && !offer.models.includes(seat.model)) {
    return `${seat.runtime} does not offer ${seat.model}`
  }
  if (seat.effort && !offer.efforts.includes(seat.effort)) {
    return `${seat.runtime} does not offer ${seat.effort} effort`
  }
  return null
}

export const chooseSeat = (candidates: readonly FlowSeat[], offers: readonly SeatOffer[]): Seating => {
  const passed: PassedOver[] = []
  for (const seat of candidates) {
    const why = whyNot(seat, offers)
    if (!why) return { seat, passed }
    passed.push({ seat, why })
  }
  return { seat: null, passed }
}

export const explainRefusal = (passed: readonly PassedOver[]): string => {
  if (passed.length === 0) return 'No seat was offered for this Agent.'
  const lines = passed.map((one) => `  ${seatLabel(one.seat)} — ${one.why}`)
  return `No seat could be opened for this Agent:\n${lines.join('\n')}`
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seating.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm verify
git add packages/server/src/agent-seating.ts packages/server/test/agent-seating.test.ts
git commit -m "feat(agents): choose a seat from ordered candidates, or refuse and say why

No guessing fallback: a candidate matches an offer or is passed over with a
reason. Not installed, signed out, spent, wrong model and wrong effort are five
different sentences because they need five different actions from the reader."
```

---

### Task 5: `agent/list` and `agent/read`

**Files:**
- Create: `packages/server/src/methods/agents.ts`
- Modify: `packages/protocol/src/wire.ts` (declare both)
- Modify: `packages/protocol/src/wire-validators.ts` (validate `agent/read`'s params)
- Modify: `packages/server/src/methods/index.ts` (import and spread `agentMethods`)
- Modify: `packages/server/src/methods/context.ts` (add `agents` to `HostContext`)
- Test: `packages/server/test/agent-methods.test.ts`

**Interfaces:**
- Consumes: `Agents` from Task 3.
- Produces: `agent/list` → `readonly AgentEntry[]`; `agent/read` → `AgentEntry | null`. Task 6 calls `ctx.agents.read`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/agent-methods.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Agents } from '../src/agents.js'
import { agentMethods } from '../src/methods/agents.js'

/**
 * The two read verbs, against a real roster on disk and a context stub.
 *
 * Only the wiring is under test here: the precedence rules have their own test
 * and are not re-proved through the wire.
 */

const ctxWith = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agent-methods-'))
  const user = join(root, 'user')
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(
    join(user, 'reviewer', 'AGENT.md'),
    '---\nname: Reviewer\npermission: read\n---\nRead the diff.\n',
    'utf8',
  )
  return { agents: new Agents({ user, builtin: join(root, 'builtin') }) } as never
}

test('agent/list answers the roster', async () => {
  const ctx = await ctxWith()
  const listed = await agentMethods['agent/list'](ctx, {})
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.definition?.name, 'Reviewer')
  assert.equal(listed[0]?.origin, 'user')
})

test('agent/read answers one, by id', async () => {
  const ctx = await ctxWith()
  const one = await agentMethods['agent/read'](ctx, { id: 'reviewer' })
  assert.equal(one?.definition?.permission, 'read')
})

test('agent/read answers null for an id nobody defined', async () => {
  const ctx = await ctxWith()
  assert.equal(await agentMethods['agent/read'](ctx, { id: 'nobody' }), null)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/methods/agents.js'`.

- [ ] **Step 3: Declare the two methods**

In `packages/protocol/src/wire.ts`, beside the other read verbs:

```ts
  'agent/list': {
    params: { readonly project?: string }
    result: readonly AgentEntry[]
  }
  'agent/read': {
    params: { readonly id: string; readonly project?: string }
    result: AgentEntry | null
  }
```

Import `AgentEntry` at the top of `wire.ts` from `./agent.js`.

In `packages/protocol/src/wire-validators.ts`, add a validator for `agent/read` matching how its neighbours check a required string param — `agent/list` takes only an optional string and needs whatever its neighbours with optional-only params have.

- [ ] **Step 4: Write the module**

Create `packages/server/src/methods/agents.ts`:

```ts
import type { MethodsUnder } from './context.js'

/**
 * The Agent roster, read.
 *
 * Reads only. Writing an Agent is editing a file, and the desk has an editor
 * plane for that — a second write path for the same file is a second answer to
 * "what does this Agent say".
 */
export const agentMethods = {
  'agent/list': (ctx, params) => ctx.agents.list(params.project),
  'agent/read': (ctx, params) => ctx.agents.read(params.id, params.project),
} satisfies MethodsUnder<'agent/'>
```

In `packages/server/src/methods/context.ts`, add to `HostContext`:

```ts
  /** The Agent roster: who can be seated, and what each one is for. */
  readonly agents: Agents
```

importing `Agents` from `../agents.js`. In `packages/server/src/methods/index.ts`, import `agentMethods` and spread it into `hostMethods` beside the others.

- [ ] **Step 5: Run the tests**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-methods.test.js packages/server/dist/test/methods.test.js`
Expected: PASS. `methods.test.js` proves both declared methods have exactly one handler.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm verify
git add packages/protocol/src packages/server/src packages/server/test/agent-methods.test.ts
git commit -m "feat(agents): agent/list and agent/read

Reads only. Writing an Agent is editing a file, and a second write path for the
same file would be a second answer to what that Agent says."
```

---

### Task 6: Open a conversation as an Agent

The payoff: `agent/seat` resolves the Agent's preference against what this machine offers, opens a conversation on the seat it chose, hands the brief over as the standing order, and records which Agent and which brief it was — or refuses and names every candidate.

**Files:**
- Modify: `packages/server/src/methods/agents.ts` (add `agent/seat`)
- Modify: `packages/protocol/src/wire.ts`, `wire-validators.ts`
- Modify: `packages/protocol/src/session.ts` (`SessionSettings` gains `agent` and `brief`)
- Test: `packages/server/test/agent-seat.test.ts`

**Interfaces:**
- Consumes: `chooseSeat`, `explainRefusal`, `seatLabel` (Task 4); `ctx.agents.read` (Task 5).
- Produces: `agent/seat` → `Session`. The session's settings carry `agent: string` and `brief: string` (the hash from Task 3), which the provenance plan later reads.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/agent-seat.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { digestOf } from '@harnessdesk/agent-inventory'

import { Agents } from '../src/agents.js'
import { agentMethods } from '../src/methods/agents.js'

/**
 * Seating an Agent: the chosen seat, the brief handed over once, and the
 * refusal that names every candidate.
 *
 * The seat and the standing order are recorded so a later reader can ask which
 * Agent wrote a change and which version of its brief it was running.
 */

const rig = async (prefer: string) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agent-seat-'))
  const user = join(root, 'user')
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(
    join(user, 'reviewer', 'AGENT.md'),
    `---\nname: Reviewer\npermission: read\nprefer: [${prefer}]\n---\nRead the diff.\n`,
    'utf8',
  )
  const created: { runtime: string; model?: string; cwd: string }[] = []
  const ordered: string[] = []
  const ctx = {
    agents: new Agents({ user, builtin: join(root, 'builtin') }),
    offers: () => [
      { runtime: 'claude', models: ['opus-5'], efforts: ['high'], signedIn: true, spent: false },
    ],
    openSession: async (runtime: string, options: { model?: string; cwd: string }) => {
      created.push({ runtime, ...(options.model ? { model: options.model } : {}), cwd: options.cwd })
      return { runtime, sessionId: 's1', settings: {} }
    },
    order: async (_runtime: string, _sessionId: string, text: string) => {
      ordered.push(text)
    },
  } as never
  return { ctx, created, ordered, root }
}

test('it seats the first candidate this machine can offer', async () => {
  const { ctx, created } = await rig('cursor=gemini-3.8-flash/high, claude=opus-5/high')
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
})

test('the brief is handed over as the standing order, once', async () => {
  const { ctx, ordered } = await rig('claude=opus-5/high')
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.equal(ordered.length, 1)
  assert.match(ordered[0] ?? '', /Read the diff\./)
})

test('the session records the Agent and the brief it ran', async () => {
  const { ctx } = await rig('claude=opus-5/high')
  const session = await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.equal(session.settings.agent, 'reviewer')
  // Asserted as the digest of the real brief, not merely as a non-empty string:
  // the defect this guards is a hash and prose being swapped, and a length check
  // cannot see that.
  assert.equal(session.settings.briefDigest, digestOf('Read the diff.\n'))
})

test('nothing seatable refuses, names every candidate, and opens nothing', async () => {
  const { ctx, created } = await rig('cursor=gemini-3.8-flash/high, codex=gpt-5.3/xhigh')
  await assert.rejects(
    () => agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => /cursor/.test(error.message) && /codex/.test(error.message) && /not installed/.test(error.message),
  )
  assert.deepEqual(created, [])
})

test('an Agent nobody defined refuses by name', async () => {
  const { ctx } = await rig('claude=opus-5/high')
  await assert.rejects(
    () => agentMethods['agent/seat'](ctx, { id: 'ghost', cwd: '/tmp/x' }),
    /ghost/,
  )
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js`
Expected: FAIL — `agent/seat` is not a function.

- [ ] **Step 3: Add `agent` and `brief` to the session's settings**

In `packages/protocol/src/session.ts`, add to `SessionSettings`:

```ts
  /** The Agent this conversation was seated as, when it was seated as one. */
  readonly agent?: string
  /**
   * Content hash of the brief it was handed, captured at seating. Named for the
   * digest it is: `brief` alone would read as the prose, and the prose goes to
   * the standing order, not here.
   *
   * A project Agent is versioned by git; a user-level one is versioned by
   * nothing. The hash is what makes "at the version of its brief" answerable
   * either way, and it is the same reason a flow run freezes its flow.
   */
  readonly briefDigest?: string
```

- [ ] **Step 4: Declare `agent/seat`**

In `packages/protocol/src/wire.ts`:

```ts
  'agent/seat': {
    params: {
      readonly id: string
      readonly cwd: string
      readonly project?: string
      /** Overrides the Agent's own preference for this one seating. */
      readonly seats?: readonly FlowSeat[]
    }
    result: Session
  }
```

Add a validator in `wire-validators.ts` checking `id` and `cwd` are non-empty strings.

- [ ] **Step 5: Implement it**

Add to `packages/server/src/methods/agents.ts`:

```ts
  'agent/seat': async (ctx, params) => {
    const entry = await ctx.agents.read(params.id, params.project)
    if (!entry) throw new Error(`No Agent called “${params.id}”.`)
    const problem = entry.problems.find((one) => one.level === 'error')
    if (problem) throw new Error(`${entry.path} cannot be used: ${problem.at} — ${problem.text}`)
    // The problem check above is why this cannot be null; the guard keeps that
    // reasoning checkable by the compiler rather than trusting it.
    if (!entry.definition) throw new Error(`${entry.path} did not parse.`)

    const candidates = params.seats?.length ? params.seats : entry.definition.prefer
    const chosen = chooseSeat(candidates, ctx.offers())
    if (!chosen.seat) throw new Error(explainRefusal(chosen.passed))

    const opened = await ctx.openSession(chosen.seat.runtime, {
      cwd: params.cwd,
      ...(chosen.seat.model ? { model: chosen.seat.model } : {}),
      ...(chosen.seat.effort ? { effort: chosen.seat.effort } : {}),
      agent: entry.definition.id,
      briefDigest: entry.digest,
    })
    // The brief goes over once, as the standing order. Re-sending it every turn
    // would pay for it every turn and say nothing new.
    await ctx.order(opened.runtime, opened.sessionId, entry.definition.brief)
    return opened
  },
```

Import `chooseSeat`, `explainRefusal` from `../agent-seating.js`. Add `offers()`, `openSession()` and `order()` to `HostContext` in `context.ts` if they are not there under other names — check first, and reuse whatever the flow engine's port already calls them rather than adding a second way to open a conversation.

- [ ] **Step 6: Run the test to see it pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/agent-seat.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `pnpm test`
Expected: PASS.

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm verify
git add packages/protocol/src packages/server/src packages/server/test/agent-seat.test.ts
git commit -m "feat(agents): seat a conversation as an Agent

Resolves the Agent's preference against what this machine offers, hands the
brief over once as the standing order, and records which Agent and which brief
version it ran. When no candidate can be seated it opens nothing and names
every candidate with the reason it failed."
```

---

## Self-review against the spec

Checked each section of `docs/superpowers/specs/2026-09-17-agents-and-goals-design.md` that this phase claims:

| Spec requirement | Task |
| --- | --- |
| Agent is a directory; `AGENT.md` front matter plus a brief body | 2 |
| Project beats user beats built-in; shadowed is listed and marked | 3 |
| `permission` is a ceiling, defaults to the narrowest | 2 |
| `prefer` is ordered seat specs, same grammar and parser as a role's `seats` | 2, 4 |
| First seatable candidate wins; a round's `seats` overrides | 4, 6 |
| Refuse and name what is missing; never substitute | 4, 6 |
| The brief is captured by hash at seating | 3, 6 |
| `agents.json` is not renamed | Global constraints, Task 1 |
| `acp/*` for the registry, `runtime/installs*` for the machine | 1 |
| Credentials and history stay in their own planes | 2 (the type omits them) |

**Deliberately not in this phase**, and each has a plan of its own below: the machine-level seating override file, the built-in Agents that ship with the app, the Settings roster surface, and everything to do with Goal, Evidence, findings, bindings and lanes.

**One thing to check before Task 6 rather than assume:** `HostContext` may already expose conversation-opening and standing-order verbs under the names the flow engine's `FlowPort` uses (`seat`, `order`). Reuse them. A second way to open a conversation is a second set of bugs.

## The plans after this one

This is phase 1 of 10. Each produces working software on its own; none may be started before the one above it lands, except where noted.

1. **Agents foundation** — this plan.
2. **The evidence ledger** — the `Evidence` type and store, staleness at a revision, the producers (check, diff, pr, ci), the immutable Seat record, and the board's columns derived from facts rather than dragged.
3. **Goal** — Room and `Plan` merged into a container that finishes, membership derived from assignment, wrap and receipt, `dependsOn` between Goals, and the migration of existing rooms.
4. **Flows on the new nouns** — `uses`, `grant`, evidence guards, one level of evidence templating, and the migration of committed flow files.
5. **The findings ledger** — stable ids, the repair delta, the shrinking blocking set, bounded rounds that end at a person, and where each finding was published.
6. **Intake** — bindings on the Project, the dedupe key, concurrency, budget, and named stop reasons.
7. **Provenance** — the ref observer independent of turns, patch-id reconciliation through rewrites, and capture health per Project. Can run in parallel with 4 and 5; needs 2.
8. **The interface** — the common shapes reachable without writing a file, and the file it wrote shown afterwards. This is the phase that stops the answer to "have three reviewers look at this" being *write YAML*.
9. **Insight** — what a wrapped Goal cost, broken down by Agent, by seat, by what was loaded and by delegation. Mostly a join rather than new plumbing once 2 lands, because `spend` is evidence, evidence carries its Seat, and the Library already prices every skill and MCP server per turn. Gives comparison a second axis — same Goal, and now which Agent got there for fewer tokens — and eventually lets an Agent's `prefer` be answered from its own record instead of guessed once by its author.
10. **Cross-Agent memory, skills and MCP** — per-Agent allowlists actually driving each runtime's own loading mechanism, and shared knowledge living on the Project where it can be diffed and cited by revision. Cross-agent *tools* already work through the one MCP surface, so this narrows rather than widens.

## Documentation each phase owes

`docs/` describes what ships. So no page below is touched before its phase lands,
and none is left behind after it does — a page that describes the previous noun
model is worse than no page, because a reader cannot tell which parts still hold.

| Phase | Page | What changes |
| --- | --- | --- |
| 1 (this plan) | `docs/agents.md` → `docs/runtimes.md`, `docs/README.md` | "agent" means the installed CLI throughout; ACP-facing mentions and `agents.json` keep the word |
| 1 | new `docs/agents.md` | Reintroduced for the *new* noun once Task 6 lands: the directory, the front matter, precedence, seating and the refusal |
| 2 | `docs/interface.md` | Board columns derived from evidence rather than dragged |
| 3 | `docs/multi-agent.md`, `docs/interface.md`, `docs/README.md` | Room and `Plan` become Goal; membership derived; the receipt a wrap leaves |
| 4 | `docs/flows.md` | `uses`, `grant`, evidence guards, one level of evidence templating; `seats` narrowed to seating only |
| 4 | `docs/multi-agent.md` | `/race` restated as one Agent on two seats |
| 5 | `docs/flows.md` | The findings ledger and how a review round converges |
| 6 | `docs/multi-agent.md`, `docs/data-boundaries.md` | Bindings, the dedupe key, concurrency, budget; and what a forge watch reads |
| 7 | `docs/architecture.md`, `docs/decisions.md` | The ref observer, patch-id reconciliation, capture health |
| 8 | `docs/interface.md`, `docs/getting-started.md` | Starting the common shapes without writing a file |

Two pages need no change at any phase, and the reason is worth stating so nobody
"tidies" them: `docs/multi-agent.md`'s delegation section and
`docs/context-usage.md`'s account of what a session delegated are already right.
The desk observes and measures a runtime's own subagents and does not execute
them, and this design does not alter that — it only says where a delegation sits
in the noun model, which is inside a Seat.
