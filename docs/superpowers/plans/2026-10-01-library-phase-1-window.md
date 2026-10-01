# Library Phase 1: Read-only Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a read-only Library window that truthfully shows skills, rules files and MCP servers across agents, with the Option E list/detail layout and routes from the sidebar, ⌘K and Settings.

**Architecture:** Extend the existing `library/read` read model with measured evidence, per-agent answer state, MCP status and rules files. Build a separate `LibraryWindow` from focused toolbar, list, detail and state-word modules, composing the design system and the existing Skills/Extensions surfaces; do not put write flows in this phase. Keep the Settings Skills and Extensions routes until the final parity task proves their existing operations are reachable from the window.

**Tech Stack:** TypeScript, React, Zustand store, `@harnessdesk/protocol`, `@harnessdesk/agent-inventory`, Vitest with jsdom, `node:test`, the public `packages/ui/src/design` API.

## Global Constraints

- Phase 1 is read-only; no new write paths, pending bar, apply flow, receipt, source/update action, or enabled Installed in checkbox.
- Reuse Option E composition in `packages/ui/src/preview/frames-library-dev.tsx`: `ListRow`, `IconTile`, `Tabs variant="line"`, `Segmented`, `Search`, `Checkbox`, `RuntimeMark`, and `Markdown document`.
- The Library window has no rail. Its list and detail panes sit below the toolbar inside `AppWindow`.
- A wire method is three edits in fixed order: declare it in `packages/protocol/src/wire.ts`, validate params in `packages/protocol/src/wire-validators.ts`, answer it in `packages/server/src/methods/<domain>.ts`. `library/read` already exists; preserve its params and extend its result type and implementation only.
- Never branch on a runtime id or brand in rendered UI. Read presentation and capabilities from runtime data; capability facts are set true only on asked evidence.
- A `Loads it` sentence or `CheckIcon` is rendered only for asked (`reported`) evidence. Missing agent answers render a state sentence; they never render an empty cell.
- Issues are exactly: copies differ; edited since the desk wrote it; written but not re-checked; rejected; a receipt target refused or failed; needs sign-in; old-build evidence; update available. `stale` by itself, not measured, on disk but not confirmed for an agent that cannot confirm, and unscanned are never issues. Update available remains a future state and is not generated in phase 1.
- Reuse `ExtensionsSection` and `SkillsSection` parts for the One agent strip and its Store, Sign in, Hooks, skill toggle, plugin install/uninstall, app search, MCP login and reload operations. Do not duplicate those operation implementations.
- Every new component file stays under about 400 lines. Split by pane and put state words/glyph selection in their own module.
- New icons belong in `packages/ui/src/components/Icons.tsx`. Do not draw icons inline.
- Use public design exports only; add no screen-owned `--hd-*` tokens, literals where design tokens exist, overlays, or cross-screen CSS imports. `node script/design-audit.mjs --strict` must add nothing.
- Preserve rule 9: variable descriptions may be subtitles; paraphrases and fixed explanatory sentences belong in `title` or a group `MenuNote`.
- Tasks run in a Codex workspace sandbox. It cannot commit or bind ports, and Vitest runs only in write mode. Write commit steps normally; the parent runs them. Keep each task's working set small enough for a 258k-token context.
- The root package has `pnpm build:node` but protocol and agent-inventory have no package `test` scripts. For Node tests run `pnpm build:node && node --test packages/<package>/dist/test/<file>.test.js`; for UI tests run `pnpm --filter @harnessdesk/ui test -- <file>.test.tsx`. Every task ends with UI typecheck, relevant tests, and `node script/design-audit.mjs --strict`; audit acceptance is no new findings (the repository already has 20 findings). Do not claim the four-agent live rig was run from the workspace sandbox.
- Follow `AGENTS.md` testing conventions: protocol and inventory use `node:test`; UI uses Vitest with jsdom. Public preview identities must be the existing synthetic demo personas.

- **Definition of done (owner):**
  - Every new or changed component has all its real states on the `design.html` catalogue boards and as `preview.html` frames, rendered from the shipped component. That covers the Library list row (presence strip, summary, badges), the detail pane, the *Installed in* lines, every state glyph, the One agent strip, and the Rules, MCP and Hooks tabs.
  - The task that adds the real frames deletes the mockups: `packages/ui/src/preview/frames-library-dev.tsx`, `frames-library-options.tsx` and `library-options-fixture.ts`, together with their registration in `preview/main.tsx`. No second copy of the design survives.

---

### Task 1: Protocol evidence, agent answer states, Rules, and Issues predicate

**Files:**
- Modify: `packages/protocol/src/library.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/agent-inventory/src/index.ts` (existing inventory contracts, also extended in this task)
- Modify: `packages/server/src/host.ts` only in `#inventoryAgents()` to carry `RuntimeInfo.version`; do not read or edit the rest of the file
- Modify: `packages/server/src/methods/context.ts` and `packages/server/src/host.ts` only in `#buildContext()` to provide the machine home path to the inventory handler
- Modify: `packages/adapter-codex/src/runtime.ts`
- Modify: `packages/adapter-codex/test/skills-hooks.test.ts`
- Modify: `packages/adapter-acp/src/runtime.ts`
- Modify: `packages/adapter-acp/test/acp.test.ts`
- Modify: `packages/agent-inventory/src/index.ts` (`reachFor` and `readLibrary` producers)
- Modify: `packages/agent-inventory/test/inventory.test.ts` test `InventoryAgent` helper for required build/folder evidence fields
- Modify: `packages/ui/src/components/Library.test.tsx`
- Modify: `packages/ui/src/components/LibraryActions.test.tsx`
- Modify: `packages/ui/src/components/AppWindow.escape.test.tsx`
- Modify: `packages/ui/src/components/Settings.route.test.tsx` Library fixture (also changed for route assertions in Task 5)
- Modify: `packages/ui/src/preview/harness.tsx`
- Test: `packages/protocol/test/library.test.ts`

**Interfaces:**
- Consumes: existing `Library`, `LibraryEntry`, `LibraryReach`, `ReachBasis`, `entryHasProblem`.
- Produces: `LibraryKind = 'skill' | 'mcp'` (unchanged); read-only `LibraryTabKind = 'skills' | 'rules' | 'mcp' | 'hooks'`; `ReachBasis = 'reported' | 'scanned' | 'table'`; required `LibraryReach.at: number` and `LibraryReach.build: string`; optional `LibraryReach.issue?: LibraryIssue` and `mcpStatus?: 'configured' | 'available' | 'needs-sign-in' | 'failed'`; `LibraryIssue = 'edited' | 'written-needs-recheck' | 'old-build' | 'failed' | 'refused' | 'needs-sign-in' | 'update-available'`; `LibraryEntry.issues?: readonly LibraryIssue[]`; `LibraryAgentState = 'answered' | 'could-not-ask' | 'signed-out' | 'not-installed' | 'unknown-support'`; `LibraryAgent { runtime: RuntimeId; state: LibraryAgentState; folderEvidence: 'asked' | 'build' | 'unknown' }`; `LibraryRulePlace = 'home' | 'repository-root' | 'nested'`; `LibraryRuleReach { runtime: RuntimeId; state: 'read' | 'probably-read' | 'not-measured'; basis: ReachBasis; at: number; build: string }`; `LibraryRuleFile { path: string; place: LibraryRulePlace; name: string; text: string; reach: readonly LibraryRuleReach[] }`; required `Library.agents` and `Library.rules`; and pure `isIssue(entry: LibraryEntry): boolean` beside `entryHasProblem`. Keep `'rules'` out of `LibraryKind`, `LibraryPlannedOp` and `LibraryDefinition`. Hooks have their own window tab and UI row projection while the One agent strip continues to reuse the existing `SkillsSection` hook controls.

- [ ] **Step 1: Add failing protocol tests for issue membership and state/evidence shapes.**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { runtimeId } from '../src/ids.js'
import { isIssue, type LibraryEntry, type LibraryReach } from '../src/library.js'

const reach = (state: LibraryReach['state'], basis: LibraryReach['basis'] = 'scanned'): LibraryReach => ({
  runtime: runtimeId('codex'), state, basis, at: 1_790_000_000_000, build: '1.0.0',
})
const entry = (states: readonly LibraryReach['state'][]): LibraryEntry => ({
  kind: 'skill', name: 'sample', copies: [],
  reach: states.map((state) => reach(state)),
})

test('reach defects and a typed edit issue supplied by the manifest join are issues', () => {
  for (const state of ['differs', 'rejected'] as const) assert.equal(isIssue(entry([state])), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['edited'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['written-needs-recheck'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['old-build'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['refused'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['needs-sign-in'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['update-available'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), issues: ['failed'] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), reach: [reach('reaches', 'scanned')] }), false)
  assert.equal(isIssue({ ...entry(['reaches']), reach: [{ ...reach('reaches'), mcpStatus: 'failed' }] }), true)
  assert.equal(isIssue({ ...entry(['reaches']), reach: [{ ...reach('reaches'), mcpStatus: 'needs-sign-in' }] }), true)
})

test('not measured, on-disk-unconfirmed, and unscanned are not issues by themselves', () => {
  assert.equal(isIssue(entry(['unscanned'])), false)
  assert.equal(isIssue(entry(['reaches'])), false)
  assert.equal(isIssue(entry(['absent'])), false)
  assert.equal(isIssue(entry(['stale'])), false)
})
```

- [ ] **Step 2: Run the protocol test and confirm the missing API/type fails.**

Run: `pnpm build:node && node --test packages/protocol/dist/test/library.test.js`
Expected: FAIL because `isIssue` and the evidence fields do not yet exist.

- [ ] **Step 3: Define the read-model types, update every producer, and compare manifest digests.** Keep `LibraryKind` limited to skill/MCP and add `LibraryTabKind`; define the explicit entry/rule/hook `LibraryRow` union in the UI pane layer in Task 4, not in the protocol. Add required `at` and `build` to every `reachFor` return (`at` is one timestamp per scan and `build` comes from `InventoryAgent.build`, supplied by host `runtime.info.version ?? 'unknown'`); return `agents` and `rules` on `readLibrary` (empty Rules until Task 2 populates them). Add the four capability facts to `RuntimeCapabilities` and `NO_CAPABILITIES`; update Codex's `CAPABILITIES` and ACP's evidence-derived `#capabilities()` as Task 3's source contract. Update every literal before typecheck: the `InventoryAgent` helper and all inline `InventoryAgent` objects in `packages/agent-inventory/test/inventory.test.ts`; every `LibraryReach` and `Library` fixture in `packages/ui/src/components/Library.test.tsx`, `LibraryActions.test.tsx`, `AppWindow.escape.test.tsx`, and `Settings.route.test.tsx`; and the Library read-model fixture in `packages/ui/src/preview/harness.tsx`. Give each reach a concrete `at` and `build`; give every Library literal `agents` and `rules`. `library/read` compares each non-hollow copy digest against `LibraryManifest.find(kind, path, name)` and adds typed `issues: ['edited']` when it differs; do not infer edits from free text. Implement `isIssue` from states, typed `entry.issues`, MCP status, and differing copy digests; `unscanned`, absent, stale, and ordinary scanned `reaches` alone remain false.

```ts
export type LibraryKind = 'skill' | 'mcp'
export type LibraryTabKind = 'skills' | 'rules' | 'mcp' | 'hooks'
export type ReachBasis = 'reported' | 'scanned' | 'table'
export type LibraryIssue = 'edited' | 'written-needs-recheck' | 'old-build' | 'failed' | 'refused' | 'needs-sign-in' | 'update-available'
export type LibraryAgentState = 'answered' | 'could-not-ask' | 'signed-out' | 'not-installed' | 'unknown-support'
export type LibraryRulePlace = 'home' | 'repository-root' | 'nested'

export interface LibraryRuleFile {
  readonly path: string
  readonly place: LibraryRulePlace
  readonly name: string
  readonly text: string
  readonly reach: readonly LibraryRuleReach[]
}

export interface LibraryReach {
  readonly runtime: RuntimeId
  readonly state: ReachState
  readonly basis: ReachBasis
  readonly at: number
  readonly build: string
  readonly issue?: LibraryIssue
  readonly mcpStatus?: 'configured' | 'available' | 'needs-sign-in' | 'failed'
  readonly note?: string
}

export interface LibraryRuleReach {
  readonly runtime: RuntimeId
  readonly state: 'read' | 'probably-read' | 'not-measured'
  readonly basis: ReachBasis
  readonly at: number
  readonly build: string
}

export const isIssue = (entry: LibraryEntry): boolean => {
  if (entry.reach.some(({ state, issue, mcpStatus }) =>
    state === 'differs' || state === 'rejected' ||
    issue !== undefined || mcpStatus === 'needs-sign-in' || mcpStatus === 'failed',
  )) return true
  if (entry.issues?.length) return true
  const digests = new Set(entry.copies.filter((copy) => !copy.hollow).map((copy) => copy.digest))
  return digests.size > 1
}
```

The four `RuntimeCapabilities` facts (`reportsCatalogue`, `reportsRejections`, `skillToggle`, `catalogueRefresh`) and their `NO_CAPABILITIES` defaults are **owned by phase 0, Task 10** (`2026-10-01-library-phase-0-measure.md`), which sets them only behind a measurement result file. Phase 1 consumes them and never sets them. If phase 0 has not landed, stop: phase 1 starts after phase 0 exits. Add `InventoryAgent.build` and `folderEvidence` from the phase-0 location-table record; pass `runtime.info.version ?? 'unknown'` in `Host.#inventoryAgents()`. `scanRuntime` stamps each scan with one `at` and that `build`, and `reachFor` copies those values into each return. `readLibrary` supplies `agents` and `rules: []` so every `Library` producer satisfies the required protocol shape before Task 2 adds Rules.

Do not change the adapters' capability facts here; phase 0 Task 10 set them from result files. Add assertions to `skills-hooks.test.ts` and `acp.test.ts` only if phase 0 did not already cover the values a phase-1 surface reads.

- [ ] **Step 4: Complete protocol tests for all issue and never-issue cases.** Assert every `LibraryIssue` value and both issue MCP statuses; specifically prove that `unscanned`, `absent`, and ordinary scanned reach are never issues, and that a pair of differing copy digests is an issue.

```ts
test('a differing copy digest is an issue even without a reach problem', () => {
  const base = entry(['absent'])
  const copies = [
    { path: '/one', scope: 'user' as const, readBy: [], hollow: false, digest: 'a', readOnly: false },
    { path: '/two', scope: 'project' as const, readBy: [], hollow: false, digest: 'b', readOnly: false },
  ]
  assert.equal(isIssue({ ...base, copies }), true)
})

test('a not-measured reach remains outside Issues', () => {
  assert.equal(isIssue(entry(['unscanned'])), false)
  assert.equal(isIssue(entry(['absent'])), false)
})
```

- [ ] **Step 5: Run protocol and adapter tests, UI typecheck, and strict design audit.**

Run: `pnpm build:node && node --test packages/protocol/dist/test/library.test.js packages/agent-inventory/dist/test/inventory.test.js packages/adapter-codex/dist/test/skills-hooks.test.js packages/adapter-acp/dist/test/acp.test.js`
Expected: PASS; protocol shape, inventory producers, and adapter capability evidence tests all pass.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS; callers may ignore the added fields until Task 3.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 6: Commit the protocol contract.** The Codex executor records this normally; the parent runs the commit outside the sandbox.

```bash
git add packages/protocol/src/library.ts packages/protocol/src/runtime.ts packages/agent-inventory/src/index.ts packages/agent-inventory/test/inventory.test.ts packages/server/src/host.ts packages/adapter-codex/src/runtime.ts packages/adapter-codex/test/skills-hooks.test.ts packages/adapter-acp/src/runtime.ts packages/adapter-acp/test/acp.test.ts packages/ui/src/components/Library.test.tsx packages/ui/src/components/LibraryActions.test.tsx packages/ui/src/components/AppWindow.escape.test.tsx packages/ui/src/components/Settings.route.test.tsx packages/ui/src/preview/harness.tsx packages/protocol/test/library.test.ts
git commit -m "feat(protocol): model phase one library evidence"
```

### Task 2: Inventory and host read model for answers, MCP status, and Rules

**Files:**
- Modify: `packages/agent-inventory/src/locations.ts`
- Modify: `packages/agent-inventory/src/index.ts`
- Modify: `packages/agent-inventory/test/inventory.test.ts`
- Modify: `packages/server/src/methods/library.ts`
- Modify: `packages/server/src/methods/context.ts` and `packages/server/src/host.ts` only at context assembly to add `home: homedir()` to `HostContext`; `StateStore` has `directory`, not a machine-home field
- Test: `packages/server/test/library.test.ts`
- No wire validator edit: `library/read` keeps `{ cwd?: string }` params; only the result type declared in `packages/protocol/src/wire.ts` changes through `Library`.

**Interfaces:**
- Consumes: Task 1 `LibraryAgent`, `LibraryAgentState`, `LibraryRuleFile`, `LibraryRuleReach`, `LibraryReach.at`, `LibraryReach.build`.
- Produces: `readLibrary(runtimes, { cwd, home })` returns `Library` with sorted rule files from independent home/workspace roots and `reach` arrays; the existing `library/read` handler overrides the inventory defaults with the complete host roster states and joins MCP status from `runtime/mcp/list`. It compares each current copy digest against `LibraryManifest.find(kind, path, name)` and adds typed `entry.issues: ['edited']` only when the manifest contains a previous digest and it differs. A missing manifest entry is not an edit.

- [ ] **Step 1: Add a failing inventory test for deterministic rule places and agent answer states.**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLibrary } from '../src/index.js'

test('readLibrary returns sorted home, repository-root and nested rules with reach', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hd-library-home-'))
  const root = mkdtempSync(join(tmpdir(), 'hd-library-project-'))
  try {
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(root, '.agents', 'rules'), { recursive: true })
    mkdirSync(join(root, 'packages', 'ui'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'root guidance')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'home guidance')
    mkdirSync(join(home, '.claude', 'skills', 'sample'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Sample skill\n---\n')
    writeFileSync(join(root, '.agents', 'rules', 'AGENTS.md'), 'hidden nested guidance')
    writeFileSync(join(root, 'packages', 'ui', 'AGENTS.md'), 'nested guidance')
    const result = await readLibrary([agent('claudecode', ['sample']), agent('codex', new Error('offline'))], { cwd: root, home })
    assert.deepEqual(result.rules.map((rule) => rule.path), [...result.rules.map((rule) => rule.path)].sort())
    assert.deepEqual(new Set(result.rules.map((rule) => rule.place)), new Set(['home', 'repository-root', 'nested']))
    assert.equal(result.rules.find((rule) => rule.text === 'home guidance')?.place, 'home')
    assert.equal(result.rules.find((rule) => rule.text === 'hidden nested guidance')?.reach.length, 2)
    assert.equal(result.agents[0]?.state, 'answered')
    assert.equal(result.agents[1]?.state, 'could-not-ask')
    assert.equal(result.entries.find((entry) => entry.name === 'sample')?.reach[0]?.basis, 'reported')
    assert.ok(result.entries.find((entry) => entry.name === 'sample')?.reach[0]?.at)
assert.equal(result.entries.find((entry) => entry.name === 'sample')?.reach[0]?.build, 'unknown')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the inventory test and confirm it fails on missing `rules`.**

Run: `pnpm build:node && node --test packages/agent-inventory/dist/test/inventory.test.js`
Expected: FAIL because `readLibrary` still returns an empty `rules` array and the rule collector/reach records are not implemented.

- [ ] **Step 3: Extend inventory Rules scanning and include explicit hidden rule locations.** Keep `LibraryKind` unchanged. In `locations.ts`, add a `RuleLocationSpec` separately from `LocationSpec`/`McpFileSpec`, plus `RULE_LOCATIONS: Readonly<Record<string, readonly RuleLocationSpec[]>>`; each rule spec has `path`, `scope: 'user' | 'project'`, and optional phase-0 `evidence: { basis: 'asked' | 'build' | 'table' }`. Copy any phase-0 evidence value for the matching agent/path; when no evidence exists, leave it absent and treat it as table evidence. Define entries for home `AGENTS.md`, `.agents/AGENTS.md`, `.claude/CLAUDE.md`, `.codex/AGENTS.md`, `.cursor/rules`, and `.gemini/GEMINI.md`; import this table into `index.ts`. Scan explicit home roots and the workspace root plus nested paths. Do not use `readDir` for traversal because it filters dot entries; enumerate with `readdirSync` and descend only into allowed hidden rule roots (`.agents`, `.claude`, `.codex`, `.cursor`, `.gemini`) plus non-hidden directories, while excluding `.git`, `node_modules`, `vendor`, and `dist`. Read root and nested rule files, attach a `LibraryRuleReach` for every runtime, map `evidence.basis === 'asked'` to `read`/`reported`, `'build'` to `probably-read`/`scanned`, and absent or table evidence to `not-measured`/`table`; sort by normalized path before returning. Preserve `at` and `build` on each rule reach.

```ts
const RULE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'RULES.md', 'INSTRUCTIONS.md'])
const SKIP_RULE_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist'])
const EXPLICIT_HIDDEN_RULE_DIRS = new Set(['.agents', '.claude', '.codex', '.cursor', '.gemini'])
type RuleLocationSpec = { readonly path: string; readonly scope: 'user' | 'project'; readonly evidence?: { readonly basis: 'asked' | 'build' | 'table' } }
// Add to packages/agent-inventory/src/locations.ts.
export const RULE_LOCATIONS: Readonly<Record<string, readonly RuleLocationSpec[]>> = {
  codex: [{ path: 'AGENTS.md', scope: 'project' }, { path: '~/.codex/AGENTS.md', scope: 'user' }],
  claudecode: [{ path: 'AGENTS.md', scope: 'project' }, { path: '~/.claude/CLAUDE.md', scope: 'user' }, { path: '.claude/CLAUDE.md', scope: 'project' }],
  cursor: [{ path: 'AGENTS.md', scope: 'project' }, { path: '~/.cursor/rules', scope: 'user' }, { path: '.cursor/rules', scope: 'project' }],
  geminicli: [{ path: 'GEMINI.md', scope: 'project' }, { path: '~/.gemini/GEMINI.md', scope: 'user' }],
  default: [{ path: 'AGENTS.md', scope: 'project' }, { path: '~/.agents/AGENTS.md', scope: 'user' }],
}

const collectRuleFiles = (home: string, cwd: string | undefined, runtimes: readonly InventoryAgent[]): readonly LibraryRuleFile[] => {
  const found = new Map<string, Omit<LibraryRuleFile, 'reach'>>()
  const addFile = (path: string, place: LibraryRulePlace): void => {
    try {
      if (!statSync(path).isFile()) return
      found.set(path, { path, place, name: basename(path), text: readFileSync(path, 'utf8') })
    } catch { /* missing or unreadable candidates are not returned */ }
  }
  const visit = (root: string, place: LibraryRulePlace): void => {
    const walk = (directory: string, depth: number): void => {
      if (depth > 12) return
      let names: string[]
      try { names = readdirSync(directory) } catch { return }
      for (const name of names) {
        const path = join(directory, name)
        let stat
        try { stat = statSync(path) } catch { continue }
        if (stat.isDirectory()) {
          if (SKIP_RULE_DIRS.has(name) || (name.startsWith('.') && !EXPLICIT_HIDDEN_RULE_DIRS.has(name))) continue
          walk(path, depth + 1)
        } else if (stat.isFile() && (RULE_NAMES.has(name) || (basename(directory) === 'rules' && /\.(md|mdc)$/i.test(name))) {
          addFile(path, directory === root && place === 'repository-root' ? place : place === 'home' ? 'home' : 'nested')
        }
      }
    }
    walk(root, 0)
  }
  for (const runtime of runtimes) for (const spec of RULE_LOCATIONS[runtime.brand] ?? RULE_LOCATIONS.default!) {
    if (spec.scope !== 'user') continue
    const candidate = expand(spec.path, home)
    try { if (statSync(candidate).isDirectory()) visit(candidate, 'home'); else addFile(candidate, 'home') } catch { /* optional home location */ }
  }
  if (cwd) visit(cwd, 'repository-root')
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({
    ...file, reach: runtimes.map((runtime) => ruleReachFor(file.path, runtime, home, cwd, Date.now())),
  }))
}
```

Add this typed mapper beside the collector; `LOCATIONS` and `expand` already live in `locations.ts`, so import the new Rules table plus `expand`. `basename`, `join`, `readdirSync`, `readFileSync`, and `statSync` are Node imports already used by inventory.

```ts
const ruleReachFor = (path: string, runtime: InventoryAgent, home: string, cwd: string | undefined, at: number): LibraryRuleReach => {
  const spec = (RULE_LOCATIONS[runtime.brand] ?? RULE_LOCATIONS.default!).find((candidate) =>
    (candidate.scope === 'user' ? expand(candidate.path, home) : cwd ? join(cwd, candidate.path) : '') === path,
  )
  const evidence = spec?.evidence?.basis
  return {
    runtime: runtime.id,
    state: evidence === 'asked' ? 'read' : evidence === 'build' ? 'probably-read' : 'not-measured',
    basis: evidence === 'asked' ? 'reported' : evidence === 'build' ? 'scanned' : 'table',
    at,
    build: runtime.build,
  }
}
```

`InventoryAgent` gains required `build`; `home` and `at` are parameters from `readLibrary` and the scan timestamp. The host fills build from `RuntimeInfo.version` and the inventory test helper uses `'unknown'`. Invoke `collectRuleFiles(home, cwd, runtimes)` from `readLibrary` and include the result in its returned `Library`.

- [ ] **Step 4: Complete the host response, manifest comparison and MCP join.** Update existing `packages/server/src/methods/library.ts` without adding a wire method or changing params. Load the current `Library`, derive roster state from each runtime's asked result plus host health, installation and sign-in facts, retain inventory Rules, compare each current `LibraryCopy.digest` with `LibraryManifest.find(kind, path, name)` loaded from `join(ctx.state.directory, 'library')`, and join each agent's `runtime.extensions.mcpServers(cwd)` result (the handler behind `runtime/mcp/list`) by runtime id and server name. `McpServer` contains `name`, `tools`, `resources` and `auth`; map `auth === 'needsLogin'` to `needs-sign-in`, `auth === 'none'` to `available`, `auth === 'oauth' | 'token'` to `configured`, and a rejected listing promise to `failed`. No absent row is treated as an empty status. Preserve the existing return-type constraint on the method table.

```ts
'library/read': async (ctx, params) => {
  assertAbsoluteCwd(params)
  const inventory = ctx.runtimes.inventory()
  const runtimeInfo = new Map(ctx.runtimes.all().map((runtime) => {
    const info = ctx.runtimes.infoOf(runtime)
    return [info.id, info] as const
  }))
  const library = await readLibrary(inventory, { cwd: params.cwd, home: ctx.home })
  const manifest = await LibraryManifest.load(join(ctx.state.directory, 'library'))
  const agents = await Promise.all(inventory.map(async (agent) => ({
    runtime: agent.id,
    state: await agentAnswerState(ctx, runtimeInfo.get(agent.id), agent),
    folderEvidence: agent.folderEvidence,
  })))
  const mcp = await Promise.all(inventory.map(async (agent) => {
    const runtime = ctx.runtimes.get(agent.id)
    try { return { runtime: agent.id, servers: await runtime?.extensions?.mcpServers(params.cwd), failed: false } }
    catch { return { runtime: agent.id, servers: [], failed: true } }
  }))
  return joinLibraryStatus(compareManifestDigests(library, manifest), agents, mcp)
},
```

Implement `agentAnswerState(ctx, info: RuntimeInfo | undefined, inventoryAgent: InventoryAgent)`, `compareManifestDigests`, and `joinLibraryStatus` as private typed helpers in this methods module: `agentAnswerState` distinguishes all five `LibraryAgentState` values from `RuntimeInfo` and scan outcome; digest comparison sets `issues: ['edited']` only for a known previous manifest digest that changed; when current `RuntimeInfo.version` differs from `LibraryReach.build`, attach `issue: 'old-build'`; status join maps fulfilled server rows and `failed: true` to MCP reach statuses. Convert host exceptions to `could-not-ask` and keep the rule reach state sourced from the inventory location-table evidence. Extend `HostContext` with `home: string` in `methods/context.ts` and supply `homedir()` in `Host.#buildContext()`; do not use `ctx.state.directory` as home.

- [ ] **Step 5: Test agent answer states, evidence timestamps/builds, status joins, manifest edits and read-only rule paths.** Use fake runtimes only. Add assertions for no configured MCP row, status returned by `runtime/mcp/list`, sign-out, unavailable installation, asked catalogue, and a failed/unknown query. In the server test, put an old digest for the exact scanned copy into a temporary `LibraryManifest`; assert `library/read` adds `issues: ['edited']` when the current digest differs and does not add it when the digests match or there is no manifest record. This is the derivation test; the protocol predicate test only consumes the typed result. Ensure no test uses a vendor endpoint or real home.

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryManifest } from '@harnessdesk/agent-inventory'
import { NO_CAPABILITIES, runtimeId, type Library } from '@harnessdesk/protocol'
import { dispatch, type HostContext } from '../src/methods/index.js'

test('library/read marks only a scanned copy whose prior manifest digest changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-library-manifest-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  const stateDirectory = join(root, 'state')
  const skillPath = join(home, '.codex', 'skills', 'sample')
  mkdirSync(skillPath, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(skillPath, 'SKILL.md'), '---\nname: sample\ndescription: Sample skill\n---\n')
  const id = runtimeId('codex')
  const inventoryAgent = { id, brand: 'codex', build: '1.0.0', folderEvidence: 'asked' as const, listSkills: async () => [{ name: 'sample', enabled: true }] }
  const runtime = {
    id,
    info: { id, version: '1.0.0', capabilities: { ...NO_CAPABILITIES } },
    health: { state: 'ready' },
    extensions: { mcpServers: async () => [] },
  }
  const ctx = {
    home,
    state: { directory: stateDirectory },
    runtimes: { inventory: () => [inventoryAgent], all: () => [runtime], infoOf: (value) => value.info, get: () => runtime },
  } as unknown as HostContext
  try {
    const baseline = await dispatch(ctx, 'library/read', { cwd }) as Library
    const copy = baseline.entries[0]!.copies[0]!
    const manifest = await LibraryManifest.load(join(stateDirectory, 'library'))
    manifest.record({ kind: 'skill', name: 'sample', path: copy.path, digest: copy.digest!, at: baseline.generatedAt })
    await manifest.save()
    const unchanged = await dispatch(ctx, 'library/read', { cwd }) as Library
    assert.equal(unchanged.entries[0]?.issues?.includes('edited') ?? false, false)
    manifest.record({ kind: 'skill', name: 'sample', path: copy.path, digest: 'older-digest', at: baseline.generatedAt })
    await manifest.save()
    const changed = await dispatch(ctx, 'library/read', { cwd }) as Library
    assert.equal(changed.entries[0]?.issues?.includes('edited'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 6: Run inventory/server tests, UI typecheck, and strict design audit.**

Run: `pnpm build:node && node --test packages/agent-inventory/dist/test/inventory.test.js packages/server/dist/test/library.test.js`
Expected: PASS.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 7: Commit inventory and host read behavior.**

```bash
git add packages/agent-inventory/src/locations.ts packages/agent-inventory/src/index.ts packages/agent-inventory/test/inventory.test.ts packages/server/src/methods/library.ts packages/server/src/methods/context.ts packages/server/src/host.ts packages/server/test/library.test.ts
git commit -m "feat(library): read rules and runtime status"
```

### Task 3: Shared Library state words and issue/glyph mapping

**Files:**
- Create: `packages/ui/src/components/library/LibraryStates.tsx`
- Create: `packages/ui/src/components/library/LibraryStates.test.tsx`
- Modify: `packages/ui/src/components/Icons.tsx` to add a circle-stop export for refusal and a key/lock export for sign-in if absent

**Interfaces:**
- Consumes: Task 1 issue and evidence types.
- Produces: `reachSentence(reach: LibraryReach): string`, `agentStateSentence(state: LibraryAgentState): string`, `LibraryAgentStateWord({ state }): ReactNode`, `reachGlyph(reach: LibraryReach): ReactNode`, `LibraryReachMark({ reach })`, and `presenceVariant(reach: LibraryReach): 'full' | 'faint' | 'not-measured'`; shared by list and detail so state copy and glyphs cannot drift.

- [ ] **Step 1: Add failing UI tests for asked-only “Loads it” and all distinct glyph pairs.**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { runtimeId, type LibraryReach } from '@harnessdesk/protocol'
import { LibraryReachMark, reachSentence } from './LibraryStates'

const reachFixture = (state: LibraryReach['state'], basis: LibraryReach['basis']): LibraryReach => ({
  runtime: runtimeId('codex'), state, basis, at: 1_790_000_000_000, build: '0.1.0',
})

describe('Library state words', () => {
  it('says Loads it only for asked evidence', () => {
    expect(reachSentence(reachFixture('reaches', 'reported'))).toContain('Loads it')
    expect(reachSentence(reachFixture('reaches', 'scanned')).toLowerCase()).not.toContain('loads it')
  })
  it('shows the old-build re-check sentence even when the reach itself was reported', () => {
    const oldBuild = { ...reachFixture('reaches', 'reported'), issue: 'old-build' as const }
    expect(reachSentence(oldBuild)).toBe('Checked under 0.1.0 · re-check')
  })
  it('renders distinct glyph identities for refused and needs sign-in', () => {
    const rejected = reachFixture('rejected', 'reported')
    const needsSignIn = { ...reachFixture('reaches', 'scanned'), mcpStatus: 'needs-sign-in' as const }
    const { container } = render(<><LibraryReachMark reach={rejected} /><LibraryReachMark reach={needsSignIn} /></>)
    expect(container.querySelector('[data-library-state="rejected"] svg')).toHaveClass('lucide-circle-stop')
    expect(container.querySelector('[data-library-state="needs-sign-in"] svg')).toHaveClass('lucide-key-round')
    expect(container.querySelector('[data-library-state="rejected"] svg')?.innerHTML).not.toEqual(container.querySelector('[data-library-state="needs-sign-in"] svg')?.innerHTML)
  })
  it('renders on-disk full and not-measured faint dashed marks distinctly', () => {
    const { container } = render(<><LibraryReachMark reach={reachFixture('reaches', 'scanned')} /><LibraryReachMark reach={reachFixture('unscanned', 'table')} /></>)
    expect(container.querySelector('[data-library-state="on-disk"]')).toHaveAttribute('data-presence', 'full')
    expect(container.querySelector('[data-library-state="not-measured"]')).toHaveAttribute('data-presence', 'faint')
    expect(container.querySelector('[data-library-state="not-measured"]')).toHaveAttribute('data-ring', 'dashed')
  })
})
```

- [ ] **Step 2: Run the new UI test and confirm the missing state module fails.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryStates.test.tsx`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure copy and glyph mapper.** Import `LibraryReach` and `LibraryAgentState` from `@harnessdesk/protocol`. Export `LibraryReachMark({ reach })`; map `reported + reaches` to “Loads it · asked …”; scanned/build reach to “On disk · this agent can't confirm until it restarts”; unknown folders to “Not measured · this agent's folders are unknown”; `differs`, `rejected`, sign-in, stale/old build and absent to the spec's sentence and corresponding glyph. Use `CheckIcon`, `DiffIcon`, a new `CircleStopIcon` (lucide `CircleStop`), `HistoryIcon`, and `KeyIcon` from `Icons.tsx`; render issue glyph as a corner badge on the corresponding `RuntimeMark`. The key and circle-stop SVGs must have different icon classes and path shapes, asserted by the test above.

```tsx
const age = (at: number, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

export const reachSentence = (reach: LibraryReach): string => {
  if (reach.issue === 'old-build') return `Checked under ${reach.build} · re-check`
  if (reach.issue === 'needs-sign-in' || reach.mcpStatus === 'needs-sign-in') return 'Needs sign-in'
  if (reach.issue === 'failed' || reach.mcpStatus === 'failed') return `Failed${reach.note ? ` — ${reach.note}` : ''}`
  if (reach.issue === 'edited') return 'Edited since HarnessDesk wrote it'
  if (reach.issue === 'update-available') return 'An update is available'
  if (reach.issue === 'written-needs-recheck') return 'Written · needs a re-check'
  if (reach.mcpStatus === 'configured') return 'Configured'
  if (reach.mcpStatus === 'available') return 'Available'
  if (reach.state === 'reaches' && reach.basis === 'reported') return `Loads it · asked ${age(reach.at)}`
  if (reach.state === 'reaches') return "On disk · this agent can't confirm until it restarts"
  if (reach.state === 'unscanned') return "Not measured · this agent's folders are unknown"
  if (reach.state === 'differs') return 'Its copy differs'
  if (reach.state === 'rejected') return `Refused: “${reach.note ?? 'the agent declined this copy'}”`
  if (reach.state === 'stale') return 'On disk · this agent has not listed it since it started'
  if (reach.state === 'absent') return 'Not installed'
  return reach.note ?? 'Could not confirm this item'
}
```

- [ ] **Step 4: Finish tests for `answered`, `could-not-ask`, `signed-out`, `not-installed`, and `unknown-support`; assert on-disk full mark versus not-measured faint dashed ring; and assert refusal stop glyph differs from sign-in key glyph.** Export `agentStateSentence(state)` and render it with `LibraryAgentStateWord({ state })`; exhaustively assert the five exact sentences: `Agent answered`, `Could not ask this agent`, `Sign in to this agent`, `Not installed on this Mac`, and `This agent lists commands only — the desk can see its files, not what it loads.` The detail pane shows that complete sentence at the start of every Installed in column whose agent is `unknown-support`; the One agent strip says the same sentence once above its `Commands only` chip.

```tsx
it.each([
  ['answered', 'Agent answered'], ['could-not-ask', 'Could not ask this agent'],
  ['signed-out', 'Sign in to this agent'], ['not-installed', 'Not installed on this Mac'],
  ['unknown-support', 'This agent lists commands only — the desk can see its files, not what it loads.'],
] as const)('renders the sentence for agent state %s', (state, sentence) => {
    render(<LibraryAgentStateWord state={state} />)
    expect(screen.getByText(sentence)).toBeInTheDocument()
})
```

- [ ] **Step 5: Run UI tests, typecheck, and strict design audit.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryStates.test.tsx`
Expected: PASS.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 6: Commit the shared state vocabulary.**

```bash
git add packages/ui/src/components/library/LibraryStates.tsx packages/ui/src/components/library/LibraryStates.test.tsx packages/ui/src/components/Icons.tsx
git commit -m "feat(ui): define library evidence state words"
```

### Task 4: List and detail panes with read-only controls

**Files:**
- Create: `packages/ui/src/components/library/LibraryListPane.tsx`
- Create: `packages/ui/src/components/library/LibraryDetailPane.tsx`
- Create: `packages/ui/src/components/library/LibraryPane.test.tsx`
- Modify: `packages/ui/src/components/Extensions.tsx` only to export a reusable agent-scoped extension/store subview if no suitable existing part is exportable
- Modify: `packages/ui/src/components/Settings.tsx` only to export a reusable agent-scoped Skills part if required; keep Settings navigation intact in this task

**Interfaces:**
- Consumes: Task 1 read model and Task 3 `LibraryStates` exports.
- Produces: UI-local `LibraryRow = { type: 'entry'; entry: LibraryEntry } | { type: 'rule'; rule: LibraryRuleFile } | { type: 'hook'; runtime: RuntimeId; hook: HookInfo }`; `rowsForTab(tab: LibraryTabKind, library: Library, hooks: readonly { runtime: RuntimeId; hook: HookInfo }[]): readonly LibraryRow[]`; `LibraryListPane({ rows, agents, selected, onSelect, scope, query, issuesOnly, agentFilter, workspaceOpen })`; `LibraryRows({ rows, agents, selected, onSelect })`; `matchesRow(row: LibraryRow, query: string): boolean`; `inScope(entry: LibraryEntry, scope: 'all' | 'user' | 'project'): boolean`; `LibraryDetailPane({ row, agents, selectedAgent, onSelectedAgentChange, runtime, cwd })`; `LibraryOneAgentCapabilities({ capabilities, folderEvidence })`; `LibraryOneAgentTools({ runtime, onUse })`; and `isPresent(reach: LibraryReach): boolean`. Skills and MCP rows are `LibraryEntry` projections; Rules rows are `LibraryRuleFile` projections and never masquerade as `LibraryEntry`; Hooks rows pair a runtime id with its `HookInfo`. The Hooks tab filters by query and selected agent, hides scope/issues filters that do not apply to hook records, and derives its count from the same visible hook-row array it renders; its tab badge and empty state use that same array. The presence summary contract is `presenceSummary(reach: readonly LibraryReach[], agents: readonly LibraryAgent[]): string`, e.g. `in 3 of 4 · 1 differs`. Each issue glyph is a corner badge attached to the relevant runtime mark. No Installed in checkbox has a change handler or sends a write method.

- [ ] **Step 1: Add failing pane tests for filtering/counts and disabled Installed in checkboxes.**

```tsx
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type Library, type LibraryAgent, type LibraryEntry, type LibraryReach, type RuntimeInfo } from '@harnessdesk/protocol'
import { LibraryListPane } from './LibraryListPane'
import { LibraryDetailPane, LibraryOneAgentCapabilities } from './LibraryDetailPane'

const agent: LibraryAgent = { runtime: runtimeId('codex'), state: 'answered', folderEvidence: 'asked' }
const reach: LibraryReach = { runtime: agent.runtime, state: 'reaches', basis: 'reported', at: 1_790_000_000_000, build: '1.0.0' }
const sample: LibraryEntry = {
  kind: 'skill', name: 'brainstorming', description: 'Shape an idea into a plan.',
  copies: [{ path: '/demo/.codex/skills/brainstorming', scope: 'user', readBy: [agent.runtime], hollow: false, digest: 'abc', readOnly: false }],
  reach: [reach],
}
const issueEntry: LibraryEntry = { ...sample, name: 'rejected-skill', reach: [{ ...reach, state: 'rejected', note: 'invalid definition' }] }
const notMeasuredEntry: LibraryEntry = { ...sample, name: 'not-measured-only', reach: [{ ...reach, state: 'unscanned', basis: 'table' }] }
const rule = { path: '/demo/AGENTS.md', place: 'repository-root' as const, name: 'AGENTS.md', text: 'Use the repository conventions.', reach: [{ runtime: agent.runtime, state: 'read' as const, basis: 'reported' as const, at: reach.at, build: reach.build }] }
const library: Library = { generatedAt: reach.at, home: '/demo', runtimes: [agent.runtime], locations: [], entries: [sample], gaps: [], agents: [agent], rules: [rule] }
const runtime: RuntimeInfo = { id: agent.runtime, name: 'Codex', capabilities: NO_CAPABILITIES, presentation: { name: 'Codex' } } as RuntimeInfo
const fixtureProps = { rows: [{ type: 'entry' as const, entry: issueEntry }, { type: 'entry' as const, entry: notMeasuredEntry }], agents: [agent], selected: null, onSelect: vi.fn(), scope: 'all' as const, query: '', issuesOnly: false, agentFilter: null, workspaceOpen: true }
const detailProps = { row: { type: 'entry' as const, entry: sample }, agents: [agent], selectedAgent: agent.runtime, onSelectedAgentChange: vi.fn(), runtime, cwd: '/demo' }

it('filters issue rows and scope rows from the same displayed list used by its count', () => {
  const onSelect = vi.fn()
  render(<LibraryListPane {...fixtureProps} onSelect={onSelect} issuesOnly scope="user" />)
  const rows = screen.getAllByRole('button', { name: /rejected-skill/i })
  expect(rows).toHaveLength(1)
  expect(screen.getByText('1 item')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /not-measured-only/i })).not.toBeInTheDocument()
})

it('shows a disabled checkbox with the exact next-phase title', () => {
  render(<LibraryDetailPane {...detailProps} />)
  expect(screen.getByRole('checkbox', { name: /installed in/i })).toBeDisabled()
  expect(screen.getByRole('checkbox', { name: /installed in/i })).toHaveAttribute('title', 'Changing this comes next')
})
```

- [ ] **Step 2: Run the pane test and confirm missing modules fail.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryPane.test.tsx`
Expected: FAIL because the pane modules do not exist.

- [ ] **Step 3: Implement the list pane using the Option E composition.** Build `LibraryRow[]` with `rowsForTab`: skills/MCP map from `Library.entries`, Rules maps each `Library.rules` value to `{ type: 'rule', rule }`, and Hooks maps each live `runtime/hooks` result to `{ type: 'hook', runtime, hook }`. Render `Search` over names, descriptions, hook events and sources; `Segmented` Scope (All/User/This repo only when cwd exists); Issues toggle using `isIssue` for entry rows; and the All agents selector. On the Hooks tab hide Scope and Issues controls; filter hook rows by query and selected agent. For each skill/MCP `ListRow`, use `IconTile`, earned description subtitle, a fixed-order `RuntimeMark` per agent, a state-specific corner badge, and `presenceSummary`. That function counts only known reach facts, reports differences and not-measured separately, and returns the exact example `in 3 of 4 · 1 differs` for three reaches, one differs, and four total agents. Rules use their separate row model and place suffix. Derive each tab and filter count from the exact same visible-row array rendered for that view; the Hooks count is the filtered HookInfo row count, and commands are excluded from Skills counts.

```tsx
export const rowsForTab = (tab: LibraryTabKind, library: Library, hooks: readonly { runtime: RuntimeId; hook: HookInfo }[]): readonly LibraryRow[] => {
  if (tab === 'rules') return library.rules.map((rule) => ({ type: 'rule', rule }))
  if (tab === 'hooks') return hooks.map(({ runtime, hook }) => ({ type: 'hook', runtime, hook }))
  return library.entries
    .filter((entry) => entry.kind === (tab === 'skills' ? 'skill' : 'mcp'))
    .map((entry) => ({ type: 'entry', entry }))
}

const visibleRows = rowsForTab(tab, library, hooks).filter((row) => {
  if (row.type === 'hook') return matchesRow(row, query) && (!agentFilter || row.runtime === agentFilter)
  if (row.type === 'rule') return matchesRow(row, query) &&
    (scope === 'all' || (scope === 'user' && row.rule.place === 'home') || (scope === 'project' && row.rule.place !== 'home')) &&
    (!agentFilter || row.rule.reach.some((reach) => reach.runtime === agentFilter))
  return inScope(row.entry, scope) && matchesRow(row, query) &&
    (!issuesOnly || isIssue(row.entry)) &&
    (!agentFilter || row.entry.reach.some((reach) => reach.runtime === agentFilter))
})
return <LibraryRows rows={visibleRows} agents={library.agents} selected={selected} onSelect={onSelect} />
```

- [ ] **Step 4: Implement the detail pane using the Option E composition.** Show the selected item’s `IconTile`, name, description, source/location/version metadata, then Installed in with one non-empty line per agent for skill/MCP entries. For each `unknown-support` agent, start that line with `This agent lists commands only — the desk can see its files, not what it loads.`; otherwise use `reachSentence`. Render each entry `Checkbox checked={isPresent(reach)}` with `disabled` and `title="Changing this comes next"`; it must have no change handler. Rules instead show their `LibraryRuleReach` state with the exact table copy `Read by this agent`, `Probably read (build)`, or `Not measured`; do not pass a `LibraryRuleReach` to `isPresent` or render an Installed in checkbox for Rules. Hooks show the selected hook's event, source and trust as read-only details without an Installed in checkbox. Render SKILL.md and Rules body with `Markdown document`. Use line tabs for SKILL.md/Files/Usage/History on skills, and the appropriate read-only detail for MCP, Rules and Hooks. In the One agent strip, show the same complete commands-only sentence once when `reportsCatalogue` is false, then render capability chips for all four `RuntimeCapabilities` facts: `Reports its catalogue`/`Commands only`, `Reports rejections`/`No rejection report`, `Has a switch`/`No switch`, `Re-reads live`/`Re-reads on restart` (or omit refresh when `'none'`), plus `Folders: asked`/`build`/`unknown` from `LibraryAgent.folderEvidence`. Beneath the chips, compose the reusable `SkillsSection` and `ExtensionsSection` controls for the selected runtime. Add an optional `runtime` prop to those existing sections and pass it through to their existing child controls that call `useRuntime`; keep their operation handlers and store methods intact, and do not set the app's global active runtime.

```tsx
<Checkbox
  checked={isPresent(reach)}
  disabled
  title="Changing this comes next"
  aria-label={`Installed in ${runtime.presentation.name}`}
/>
<Text role="muted">{reachSentence(reach)}</Text>
<LibraryOneAgentCapabilities
  capabilities={runtime.capabilities}
  folderEvidence={agent.folderEvidence}
/>
```

- [ ] **Step 5: Complete pane tests.** Cover searched descriptions, `All/User/This repo`, selected-agent narrowing, issue rows only, disabled checkbox and tooltip, asked-only Loads it, non-empty unanswerable columns, rule Markdown, MCP status words, and glyph pairs. Verify Rules rows are projected from `Library.rules`, not `Library.entries`; one row appears per rule file/place. Assert corner badge ownership and exact summary copy/counts, including `in 3 of 4 · 1 differs` and a summary where `not measured` is excluded from both in/out counts.

```tsx
it('does not count commands as Skills and shows each rule file at its place', () => {
  render(<LibraryListPane {...fixtureProps} tab="skills" />)
  expect(screen.queryByRole('button', { name: /verify command/i })).not.toBeInTheDocument()
  render(<LibraryListPane {...fixtureProps} rows={library.rules.map((value) => ({ type: 'rule' as const, rule: value }))} tab="rules" />)
  expect(screen.getByRole('button', { name: /AGENTS.md.*repository root/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /AGENTS.md.*nested/i })).toBeInTheDocument()
})

it('shows the One agent capability chips from evidence and runtime capabilities', () => {
  const capabilities = { ...NO_CAPABILITIES, reportsCatalogue: false, reportsRejections: true, skillToggle: false, catalogueRefresh: 'restart' as const }
  render(<LibraryOneAgentCapabilities capabilities={capabilities} folderEvidence="build" />)
  expect(screen.getByText('Commands only')).toBeInTheDocument()
  expect(screen.getByText('Reports rejections')).toBeInTheDocument()
  expect(screen.getByText('No switch')).toBeInTheDocument()
  expect(screen.getByText('Re-reads on restart')).toBeInTheDocument()
  expect(screen.getByText('Folders: build')).toBeInTheDocument()
})

it('renders the positive catalogue and switch facts and explicit unknown folders', () => {
  const capabilities = { ...NO_CAPABILITIES, reportsCatalogue: true, reportsRejections: false, skillToggle: true, catalogueRefresh: 'live' as const }
  render(<LibraryOneAgentCapabilities capabilities={capabilities} folderEvidence="unknown" />)
  expect(screen.getByText('Reports its catalogue')).toBeInTheDocument()
  expect(screen.getByText('No rejection report')).toBeInTheDocument()
  expect(screen.getByText('Has a switch')).toBeInTheDocument()
  expect(screen.getByText('Re-reads live')).toBeInTheDocument()
  expect(screen.getByText('Folders: unknown')).toBeInTheDocument()
})
```

- [ ] **Step 6: Run UI tests, typecheck, and strict design audit.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryPane.test.tsx`
Expected: PASS.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 7: Commit the pane components.**

```bash
git add packages/ui/src/components/library/LibraryListPane.tsx packages/ui/src/components/library/LibraryDetailPane.tsx packages/ui/src/components/library/LibraryPane.test.tsx packages/ui/src/components/Extensions.tsx packages/ui/src/components/Settings.tsx
git commit -m "feat(ui): add read only library panes"
```

### Task 5: LibraryWindow shell and all entry routes

**Files:**
- Create: `packages/ui/src/components/LibraryWindow.tsx`
- Create: `packages/ui/src/components/LibraryWindow.test.tsx`
- Modify: `packages/ui/src/app/App.tsx`
- Modify: `packages/ui/src/components/Sidebar.tsx`
- Modify: `packages/ui/src/components/CommandPalette.tsx`
- Modify: `packages/ui/src/components/CommandPalette.pages.test.tsx` to assert both Library palette actions
- Modify: `packages/ui/src/components/Settings.tsx`
- Modify: `packages/ui/src/components/Icons.tsx` only if Library row icon is not already exported
- Modify: `packages/ui/src/components/Settings.route.test.tsx`
- Modify: `packages/ui/src/components/ComposerControls.tsx` and `packages/ui/src/components/ComposerControls.agent.test.tsx` for the conversation context-ring entry
- Modify: `packages/ui/src/panels/views.tsx` to expose a typed shell action for opening Library on a session context
- Modify: `packages/ui/src/components/ImportOffer.test.tsx` for the startup import offer destination
- Modify: `packages/ui/src/app/App.settings.test.tsx` to exercise original routes through App navigation

**Interfaces:**
- Consumes: Task 2 `library/read`; Task 4 pane components.
- Produces: `LibraryRoute { tab?: LibraryTabKind; issuesOnly?: boolean; runtime?: RuntimeId; cwd?: string; nonce?: number }`; `LibraryWindow({ route: LibraryRoute; onClose })`; `libraryRouteFor(section, runtime, cwd)` preserves the original section before `resolveSection`; and `openLibrary(route?)` in App. `ShellActions.openLibraryForContext(runtime: RuntimeId, cwd: string)` carries the context-ring route through the shell to App. `resolveSection` remains a Settings-only mapper; `library`, `skills` and `extensions` are intercepted by App and open Library.

- [ ] **Step 1: Add failing route and window tests.**

```tsx
it('maps the original Settings request to a Library route before resolving Settings sections', () => {
  const runtime = runtimeId('codex')
  expect(libraryRouteFor('library', runtime, '/demo')).toEqual({ tab: 'skills', runtime, cwd: '/demo' })
  expect(libraryRouteFor('skills', runtime, '/demo')).toEqual({ tab: 'skills', runtime, cwd: '/demo' })
  expect(libraryRouteFor('extensions', runtime, '/demo')).toEqual({ tab: 'mcp', runtime, cwd: '/demo' })
  expect(libraryRouteFor('runtimes', runtime, '/demo')).toBeNull()
})

it('opens a no-rail AppWindow and requests the current read model', async () => {
  render(<LibraryWindow route={{}} onClose={vi.fn()} />)
  expect(await screen.findByRole('dialog', { name: 'Library' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /Rules/ })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /Hooks/ })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests and confirm the route/component failures.**

Run: `pnpm --filter @harnessdesk/ui test -- Settings.route.test.tsx LibraryWindow.test.tsx`
Expected: FAIL because LibraryWindow and route mapping are absent.

- [ ] **Step 3: Build the LibraryWindow shell.** Follow `AgentsWindow` and `Usage` opening/closing patterns in `App.tsx`; use `AppWindow label="Library"`, no `WindowNav`, a toolbar with `Tabs variant="line"` for Skills/Rules/MCP servers and Hooks when any runtime has `hooks`, and the two pane columns. Fetch `library/read` on mount and when workspace `cwd` changes; when Hooks is available, also request `runtime/hooks` for each `library.agents` runtime with the current `cwd`, map each result to `{ runtime, hook }`, and use the typed Hooks row model. Do not import the existing write-capable `LibrarySection` as the window body.

```tsx
interface LibraryWindowProps {
  readonly route: LibraryRoute
  readonly onClose: () => void
}

export const LibraryWindow = ({ route, onClose }: LibraryWindowProps) => {
  const snapshot = useSnapshot()
  const store = useStore()
  const [library, setLibrary] = useState<Library | null>(null)
  const [selected, setSelected] = useState<LibraryRow | null>(null)
  const cwd = route.cwd ?? snapshot.workspace?.path
  useEffect(() => {
    let current = true
    void store.transport.request('library/read', cwd ? { cwd } : {})
      .then((value) => { if (current) setLibrary(value as Library) })
    return () => { current = false }
  }, [store, cwd])
  const activeRuntime = useRuntime()
  const selectedRuntime = snapshot.runtimes.find((runtime) => runtime.id === route.runtime) ?? activeRuntime
  const [hookRows, setHookRows] = useState<readonly { runtime: RuntimeId; hook: HookInfo }[]>([])
  useEffect(() => {
    if (!library) return
    let current = true
    const hookAgents = library.agents.filter((agent) => snapshot.runtimes.find((runtime) => runtime.id === agent.runtime)?.capabilities.hooks)
    void Promise.all(hookAgents.map(async (agent) => {
      try {
        const hooks = await store.transport.request('runtime/hooks', { runtime: agent.runtime, ...(cwd ? { cwd } : {}) })
        return hooks.map((hook) => ({ runtime: agent.runtime, hook }))
      } catch { return [] }
    })).then((groups) => { if (current) setHookRows(groups.flat()) })
    return () => { current = false }
  }, [library, store, cwd, snapshot.runtimes])
  const rows = library ? rowsForTab(route.tab ?? 'skills', library, hookRows) : []
  return (
    <AppWindow label="Library">
      <header><Text role="page" as="h1">Library</Text><Button variant="ghost" aria-label="Close Library" onClick={onClose}>Close</Button></header>
      <LibraryToolbar library={library} route={route} />
      <LibraryListPane rows={rows} agents={library?.agents ?? []} selected={selected} onSelect={setSelected} workspaceOpen={Boolean(cwd)} />
      {selected ? <LibraryDetailPane row={selected} agents={library?.agents ?? []} selectedAgent={route.runtime} runtime={selectedRuntime} cwd={cwd} /> : null}
    </AppWindow>
  )
}
```

- [ ] **Step 4: Wire every phase 1 entry point and preserve the original route.** Add a Library sidebar row beside Agents and Dashboard. Add ⌘K actions `Library` and `Library: issues`, routed to `openLibrary`. Import `useRef` in App and allocate one increasing nonce. In App's `snapshot.settingsFor` effect, call `libraryRouteFor(snapshot.settingsFor, snapshot.activeRuntime, snapshot.workspace?.path ?? null)` first; if it returns a route call `openLibrary(route)`, otherwise call `openSettingsAt(resolveSection(snapshot.settingsFor), snapshot.settingsFocus)`. `libraryRouteFor` maps `library` and `skills` to Skills, `extensions` to MCP, and attaches active runtime/cwd when known. The Settings › Capabilities › Library row calls `openLibrary`. Replace `reviewImports`'s Settings `libraryImport` route with `openLibrary({ tab: 'skills' })`; this is the startup import offer entry point and remains read-only in phase 1. Add a “What applies here” Library action to the conversation context-ring controls in `ComposerControls.tsx`; pass the active session's runtime/cwd into `openLibrary({ tab: 'rules', runtime, cwd })`. Give every `openLibrary` call a fresh `nonce` so reopening the same route remounts/refetches.

```ts
const [libraryRoute, setLibraryRoute] = useState<LibraryRoute | null>(null)
const libraryRouteNonce = useRef(0)

interface LibraryRoute {
  readonly tab?: LibraryTabKind
  readonly issuesOnly?: boolean
  readonly runtime?: RuntimeId
  readonly cwd?: string
  readonly nonce?: number
}

const openLibrary = useCallback((route: Omit<LibraryRoute, 'nonce'> = {}) => {
  setSettingsOpen(false)
  setSettingsFocus(null)
  libraryRouteNonce.current += 1
  setLibraryRoute({ ...route, nonce: libraryRouteNonce.current })
}, [])

export const libraryRouteFor = (section: string, runtime: RuntimeId | null, cwd: string | null): LibraryRoute | null => {
  const common = { ...(runtime ? { runtime } : {}), ...(cwd ? { cwd } : {}) }
  if (section === 'library' || section === 'skills') return { tab: 'skills', ...common }
  if (section === 'extensions') return { tab: 'mcp', ...common }
  return null
}

{libraryRoute ? <LibraryWindow key={libraryRoute.nonce} route={libraryRoute} onClose={() => setLibraryRoute(null)} /> : null}
```

In `panels/views.tsx`, add `openLibraryForContext` to both `ShellActions` and its `NONE` value. In App, supply `openLibraryForContext: (runtime, cwd) => openLibrary({ tab: 'rules', runtime, cwd })`; replace the `reviewImports` body with `openLibrary({ tab: 'skills' })`. In `AgentControl`, call `useShell()` and add the session-only menu item below the conversation identity row:

```tsx
<MenuItem
  icon={<LibraryIcon size={14} />}
  label="What applies here"
  onSelect={() => { close(); shell.openLibraryForContext(session.runtime, session.cwd) }}
/>
```

In App's `Settings` `onSection` callback, apply `libraryRouteFor(section, snapshot.activeRuntime, snapshot.workspace?.path ?? null)` first; open the returned route or fall through to `openSettingsAt(section, null)`. Remove the `libraryImport` one-shot prop from the Library Settings body, since the startup offer now opens the read-only Skills tab.

- [ ] **Step 5: Test every entry path, route filter and lifecycle.** In `App.settings.test.tsx`, mock LibraryWindow to print its received route, parameterize `routedStore` by its initial `settingsFor`, and drive `library`, `skills`, and `extensions` through the actual App effect; assert Skills/Skills/MCP routes respectively and verify the mocked `resolveSection` is not called for these three. Also assert an ordinary Settings section still resolves. Assert sidebar, both palette commands, Settings › Library row, conversation context-ring action, and startup import offer each call the shared opener with their expected tab/runtime/cwd. Assert reopening the identical route receives a new nonce and requests `library/read` again; Escape follows existing AppWindow propagation. Update `Settings.route.test.tsx`, `ComposerControls.agent.test.tsx`, `ImportOffer.test.tsx`, and `App.settings.test.tsx` with synthetic navigation state.

```tsx
import { runtimeId } from '@harnessdesk/protocol'

it('Library and Library: issues palette actions share the Library opener', async () => {
  const { openLibrary } = await mount()
  type('library')
  await choose('Library')
  expect(openLibrary).toHaveBeenCalledWith({})
  type('library: issues')
  await choose('Library: issues')
  expect(openLibrary).toHaveBeenCalledWith({ issuesOnly: true })
})

it.each([['library', 'skills'], ['skills', 'skills'], ['extensions', 'mcp']])(
  'opens original Settings route %s on Library tab %s', (section, tab) => {
    const runtime = runtimeId('codex')
    const route = libraryRouteFor(section, runtime, '/demo')
    expect(route).toMatchObject({ tab, runtime, cwd: '/demo' })
  },
)

it.each([['library', 'skills'], ['skills', 'skills'], ['extensions', 'mcp']])(
  'routes App settingsFor=%s to the Library %s tab', async (section, tab) => {
    const store = routedStore('/demo', section)
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    expect(screen.getByTestId('library-route')).toHaveTextContent(`"tab":"${tab}"`)
    expect(resolveSection).not.toHaveBeenCalled()
  },
)
```

In that test file, make the Settings mock's `resolveSection` a `vi.fn(() => 'workspaces')`, add a `LibraryWindow` mock that renders `<output data-testid="library-route">{JSON.stringify(route)}</output>`, and give `routedStore` a second `section = 'workspaces'` argument used for the initial `settingsFor`. Keep its existing one-shot clearing behavior.

- [ ] **Step 6: Run UI tests, typecheck, and strict design audit.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryWindow.test.tsx Settings.route.test.tsx CommandPalette.pages.test.tsx App.settings.test.tsx ComposerControls.agent.test.tsx ImportOffer.test.tsx`
Expected: PASS.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 7: Commit window and routes.**

```bash
git add packages/ui/src/components/LibraryWindow.tsx packages/ui/src/components/LibraryWindow.test.tsx packages/ui/src/app/App.tsx packages/ui/src/app/App.settings.test.tsx packages/ui/src/components/Sidebar.tsx packages/ui/src/components/CommandPalette.tsx packages/ui/src/components/CommandPalette.pages.test.tsx packages/ui/src/components/Settings.tsx packages/ui/src/components/Settings.route.test.tsx packages/ui/src/components/ComposerControls.tsx packages/ui/src/components/ComposerControls.agent.test.tsx packages/ui/src/components/ImportOffer.test.tsx packages/ui/src/panels/views.tsx packages/ui/src/components/Icons.tsx
git commit -m "feat(ui): open the library window from app routes"
```

### Task 6: Preview frames and required behavioral coverage

**Files:**
- Delete: `packages/ui/src/preview/frames-library-dev.tsx`, `packages/ui/src/preview/frames-library-options.tsx`, `packages/ui/src/preview/library-options-fixture.ts` (replaced by frames of the shipped components; remove their imports from `preview/main.tsx`)
- Modify: `packages/ui/src/preview/main.tsx`
- Modify: `packages/ui/src/preview/sidebar-fixture.ts` only if needed for stable synthetic runtime facts
- Modify: `packages/ui/src/design/surfaces/surfaces.tsx`
- Modify: `packages/ui/src/design/explorer/boards-compositions.tsx` only if catalogue registration requires a board renderer there
- Create: `packages/ui/src/components/LibraryWindow.states.test.tsx`

**Interfaces:**
- Consumes: Task 3 shared state mappings and Task 5 LibraryWindow.
- Produces: preview frame IDs for each phase 1 state on `preview.html` and entries in the design catalogue; tests for asked-only Loads it, never-empty unanswerable columns, exact count-to-row equality, and distinct glyph pairs.

- [ ] **Step 1: Add failing frame and behavior tests using synthetic fixtures.**

```tsx
it.each([
  [reachFixture('reaches', 'reported'), /Loads it/],
  [reachFixture('reaches', 'scanned'), /On disk/],
  [reachFixture('unscanned', 'table'), /Not measured/],
  [reachFixture('differs', 'reported'), /differs/],
  [reachFixture('rejected', 'reported'), /Refused/],
])('renders the state sentence for %s', (value, words) => {
  render(<LibraryReachMark reach={value} />)
  expect(screen.getByText(words)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the new tests and confirm missing state frames/tests fail.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryWindow.states.test.tsx`
Expected: FAIL until each state frame and assertion exists.

- [ ] **Step 3: Add one Option E-based preview frame for each phase 1 state.** Include asked Loads it, on-disk/unconfirmed, not measured, copies differ, rejected/refused, needs sign-in, written-needs-recheck, old evidence, not installed, each of the five agent answer states, configured/available/needs-sign-in/failed MCP status, and home/root/nested Rules. Use public demo names and paths only. Keep all phase-1 Installed in checkboxes disabled with title `Changing this comes next`; show no pending bar. Expose each frame on the normal `preview.html` catalogue route and add the real LibraryWindow as a design-catalogue surface.

```tsx
const PHASE_ONE_FRAMES = [
  ['answered', 'Asked evidence'], ['on-disk', 'On disk, not confirmed'], ['not-measured', 'Not measured'],
  ['differs', 'Copies differ'], ['edited', 'Edited since written'], ['refused', 'Refused'], ['needs-sign-in', 'Needs sign-in'],
  ['written-needs-recheck', 'Written, needs a re-check'], ['old-build', 'Old evidence'], ['not-installed', 'Not installed'],
  ['update-available', 'Update available'],
  ['agent-answered', 'Agent answered'], ['agent-could-not-ask', 'Agent could not be asked'],
  ['agent-signed-out', 'Agent signed out'], ['agent-not-installed', 'Agent not installed'],
  ['agent-unknown-support', 'Agent support unknown'], ['mcp-configured', 'MCP configured'],
  ['mcp-available', 'MCP available'], ['mcp-needs-sign-in', 'MCP needs sign-in'], ['mcp-failed', 'MCP failed'],
  ['rules-home', 'Rules at home'], ['rules-root', 'Rules at repository root'], ['rules-nested', 'Rules nested'],
] as const

export const LibraryPhaseOneFrames = () => <>
  {PHASE_ONE_FRAMES.map(([id, title]) => (
    <Frame key={id} id={`library-${id}`} title={`Library — ${title}`}>
      <DevLibrary phaseOneState={id} />
    </Frame>
  ))}
</>
```

Update the existing `DevLibrary`, `DetailPane` and `InstalledIn` in `frames-library-dev.tsx` to accept `phaseOneState?: string`: select the synthetic line corresponding to that state, use the existing ListRow/IconTile/Tabs/Segmented/Search/Checkbox/RuntimeMark/Markdown composition, set every checkbox `disabled` with `title="Changing this comes next"`, and omit `PendingBar` and `ReceiptBar` whenever `phaseOneState` is present. Preserve the two current approved Option E frames unchanged. Register `LibraryPhaseOneFrames` in `main.tsx` and add a Library surface entry to `design/surfaces/surfaces.tsx`.

- [ ] **Step 4: Complete required assertions.** Assert `Loads it` appears only on `basis === 'reported'`; an agent state other than `answered` always renders its named sentence; each tab/filter count equals the exact rows it opens; refused stop and sign-in key differ; full on-disk mark differs from faint dashed not-measured mark. Add `data-library-state` hooks for these tests without changing visual vocabulary.

```tsx
expect(screen.queryByText(/Loads it/i)).not.toBeInTheDocument() // with scanned/table-only fixture
expect(screen.getByText(/On disk/i)).toBeInTheDocument()
expect(screen.getByTestId('presence-not-measured')).toHaveAttribute('data-ring', 'dashed')
expect(screen.getByTestId('presence-on-disk')).toHaveAttribute('data-presence', 'full')
```

- [ ] **Step 5: Run UI tests, typecheck, and strict design audit.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryWindow.states.test.tsx`
Expected: PASS.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 6: Commit preview and catalogue coverage.**

```bash
git add packages/ui/src/preview/frames-library-dev.tsx packages/ui/src/preview/main.tsx packages/ui/src/preview/sidebar-fixture.ts packages/ui/src/design/surfaces/surfaces.tsx packages/ui/src/design/explorer/boards-compositions.tsx packages/ui/src/components/LibraryWindow.states.test.tsx
git commit -m "test(ui): catalogue phase one library states"
```

### Task 7: Prove parity, then remove legacy Skills and Extensions rows

**Files:**
- Modify: `packages/ui/src/components/Settings.tsx`
- Modify: `packages/ui/src/components/Settings.skills.test.tsx`
- Create: `packages/ui/src/components/LibraryWindow.parity.test.tsx`
- Modify: `packages/ui/src/components/Settings.route.test.tsx`

**Interfaces:**
- Consumes: Task 5 legacy-route mapping and Task 6 state/count tests.
- Produces: no Settings › Agents › Skills or Extensions nav rows; legacy `resolveSection('skills' | 'extensions')` links still open Library on the matching kind/runtime; parity tests prove setSkillEnabled, plugin install/uninstall, app search, MCP login/reload and Hooks remain reachable through Library’s reused parts. This removal happens only after that test passes.

- [ ] **Step 1: Write the parity test before removing either Settings row.** In the Library detail pane, compose the existing `SkillsSection` and `ExtensionsSection`, passing the selected runtime through their runtime props while keeping their original operation handlers. In `LibraryWindow.parity.test.tsx`, create a `StoreProvider` fixture using `emptySnapshot()` and a cast `AppStore`: one `RuntimeInfo` with `extensionStore`, `mcp`, and `hooks` enabled; one toggleable `SkillInfo`; a catalog containing one uninstalled non-external `RuntimePlugin` and one installed non-external `RuntimePlugin`; one MCP server with `auth: 'needsLogin'`; and one hook. Stub `loadCatalog`, `loadMcpServers`, `loadHooks`, `searchApps`, `setSkillEnabled`, `setRuntimePluginInstalled`, `mcpLogin`, and `reloadMcp` as `vi.fn` methods; make `transport.request('library/read')` return the synthetic `Library`. Keep the legacy Skills and Extensions rows mounted in the Settings fixture until all operation assertions pass.

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type Library, type LibraryEntry, type LibraryReach, type McpServer, type RuntimeCatalog, type RuntimeInfo, type SkillInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { LibraryWindow } from './LibraryWindow'

const mountParityFixture = async () => {
  const user = userEvent.setup()
  const id = runtimeId('demo')
  const runtime = { id, name: 'Demo Agent', capabilities: { ...NO_CAPABILITIES, skills: true, extensionStore: true, mcp: true, hooks: true }, presentation: { name: 'Demo Agent' } } as RuntimeInfo
  const catalog: RuntimeCatalog = { plugins: [
    { id: 'demo-install', name: 'Demo install', installed: false, enabled: false },
    { id: 'demo-remove', name: 'Demo remove', installed: true, enabled: true },
  ], marketplaces: [], loadErrors: [], featured: [] } satisfies RuntimeCatalog
  const server: McpServer = { name: 'demo-server', tools: [], resources: 0, auth: 'needsLogin' }
  const hook = { id: 'before-turn', event: 'Before turn', source: 'project', trust: 'trusted', enabled: true, managed: false } as const
  const calls: string[] = []
  const reach: LibraryReach = { runtime: id, state: 'reaches', basis: 'reported', at: 1_790_000_000_000, build: '1.0.0' }
  const sample: LibraryEntry = { kind: 'skill', name: 'sample', description: 'Sample skill', copies: [{ path: '/demo/skills/sample', scope: 'user', readBy: [id], hollow: false, digest: 'demo-digest', readOnly: false }], reach: [reach] }
  const library: Library = { generatedAt: reach.at, home: '/demo', runtimes: [id], locations: [], entries: [sample], gaps: [], agents: [{ runtime: id, state: 'answered', folderEvidence: 'asked' }], rules: [] }
  const snapshot = { ...emptySnapshot(), status: 'open', activeRuntime: id, runtimes: [runtime], skills: [{ name: 'sample', description: 'Sample skill', enabled: true, path: '/demo/skills/sample', toggleable: true } satisfies SkillInfo] } as AppSnapshot
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    loadCatalog: vi.fn(async () => catalog),
    loadMcpServers: vi.fn(async () => [server]),
    loadHooks: vi.fn(async () => { calls.push('loadHooks'); return [hook] }),
    searchApps: vi.fn(async () => ({ apps: [], nextCursor: null })),
    setSkillEnabled: vi.fn(async () => undefined),
    setRuntimePluginInstalled: vi.fn(async () => undefined),
    mcpLogin: vi.fn(async () => undefined),
    reloadMcp: vi.fn(async () => undefined),
    transport: { request: vi.fn(async () => library) },
  } as unknown as AppStore
  const mounted = render(<StoreProvider store={store}><LibraryWindow route={{ runtime: id }} onClose={() => undefined} /></StoreProvider>)
  await user.click(await screen.findByRole('button', { name: /sample/i }))
  await waitFor(() => expect(store.loadHooks).toHaveBeenCalled())
  return { store, calls, mounted, user }
}

it('keeps every Skills and Extensions operation reachable from Library', async () => {
  const { store, calls, mounted, user } = await mountParityFixture()
  await user.click(screen.getByRole('switch', { name: 'sample' }))
  expect(store.setSkillEnabled).toHaveBeenCalled()
  await user.click(screen.getByRole('tab', { name: 'Plugins' }))
  await user.click(screen.getByRole('button', { name: 'Install' }))
  await user.click(screen.getByRole('button', { name: 'Installed' }))
  expect(store.setRuntimePluginInstalled).toHaveBeenCalledTimes(2)
  await user.click(screen.getByRole('tab', { name: 'Apps' }))
  await user.type(screen.getByPlaceholderText('Search apps to connect'), 'calendar')
  await waitFor(() => expect(store.searchApps).toHaveBeenCalledWith('calendar'))
  await user.click(screen.getByRole('tab', { name: 'MCP' }))
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await user.click(screen.getByRole('button', { name: 'Reload' }))
  expect(store.mcpLogin).toHaveBeenCalledWith('demo-server')
  expect(store.reloadMcp).toHaveBeenCalled()
  expect(calls).toEqual(expect.arrayContaining(['loadHooks']))
  expect(screen.getByText('Before turn')).toBeInTheDocument()
  mounted.unmount()
})
```

- [ ] **Step 2: Run parity test and require all operations to pass before editing navigation.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryWindow.parity.test.tsx`
Expected: PASS with all seven operation names recorded.

- [ ] **Step 3: Remove only the Settings › Agents Skills and Extensions entries and their now-unreachable Settings body branches.** Keep `resolveSection` compatibility mapping and Library route kind/runtime selection. Do not remove Settings › Capabilities › Library.

```ts
// Keep these aliases for saved links; App translates the original section before resolveSection.
export const libraryRouteFor = (section: string, runtime: RuntimeId | null, cwd: string | null): LibraryRoute | null => {
  const common = { ...(runtime ? { runtime } : {}), ...(cwd ? { cwd } : {}) }
  if (section === 'library' || section === 'skills') return { tab: 'skills', ...common }
  if (section === 'extensions') return { tab: 'mcp', ...common }
  return null
}
```

- [ ] **Step 4: Update route and settings tests.** Assert no nav item named Skills or Extensions remains under Agents; the Capabilities › Library row remains; both old routes open the Library with correct filter; and all Task 7 operation assertions still pass.

```tsx
it('removes the old agent rows only after Library parity is covered', () => {
  render(<Settings section="runtimes" {...settingsProps} />)
  expect(screen.queryByRole('button', { name: /^Skills$/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Extensions$/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument()
})
```

- [ ] **Step 5: Run UI tests, typecheck, and strict design audit.**

Run: `pnpm --filter @harnessdesk/ui test -- LibraryWindow.parity.test.tsx Settings.skills.test.tsx Settings.route.test.tsx`
Expected: PASS.

Run: `pnpm --filter @harnessdesk/ui run typecheck`
Expected: PASS.

Run: `node script/design-audit.mjs --strict`
Expected: no new findings; existing findings remain unchanged.

- [ ] **Step 6: Commit the navigation removal after parity evidence is green.**

```bash
git add packages/ui/src/components/Settings.tsx packages/ui/src/components/Settings.skills.test.tsx packages/ui/src/components/LibraryWindow.parity.test.tsx packages/ui/src/components/Settings.route.test.tsx
git commit -m "feat(ui): route agent skills and extensions through library"
```

## Self-Review

- [x] Required plan header, Global Constraints, executor notes, task Files/Interfaces, ordered checkboxes, exact commands, expected results, and commit steps are present.
- [x] Rules remain a read-only `Library.rules` collection and tab projection, Hooks have a `HookInfo` row projection and tab; `LibraryKind` stays `skill | mcp` across reads and writes.
- [x] Every required Library producer and fixture is assigned before UI typecheck; async inventory tests await `readLibrary` and cover separate hidden home/workspace roots.
- [x] App routes preserve the incoming section until Library routing, cover context-ring and startup-import entry points, and defer legacy row removal until parity passes.
- [x] Strict design audit acceptance is “no new findings”; Node package test commands use the root build plus `node --test`, and UI commands use Vitest.
