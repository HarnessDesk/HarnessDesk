import type { RuntimeInfo } from '@harnessdesk/protocol'

import { runtimesSeed } from './signin-fixture'

/** Runtime names and marks are read from the existing preview roster. */
const runtimeFixtures = (runtimesSeed().runtimes ?? [])
  .filter((agent): agent is RuntimeInfo => Boolean(agent?.presentation?.name))
  .filter((agent, index, all) => all.findIndex((candidate) => candidate.id === agent.id) === index)
  .slice(0, 4)

/** Measured support is fixture data; rendering never branches on an agent id or name. */
export const LIBRARY_AGENTS = runtimeFixtures.map((runtime, index) => ({
  ...runtime,
  support: index === 0
    ? { reportsCatalogue: true, skillToggle: true, catalogueRefresh: 'live' as const, folderEvidence: 'asked' as const }
    : { reportsCatalogue: false, skillToggle: false, catalogueRefresh: 'restart' as const, folderEvidence: 'build' as const },
  health: (['in-step', 'in-step', 'something-to-fix', 'not-measured'] as const)[index] ?? 'not-measured',
}))

export type SkillFact = {
  readonly kind: 'asked-loads' | 'build-unconfirmed' | 'copies-differ' | 'absent' | 'not-measured' | 'rejected' | 'command'
  readonly basis: string
  readonly words: string
}

const tierAFact: SkillFact = { kind: 'asked-loads', basis: 'Asked · 2 min ago', words: 'Asked · Loads it' }
const tierBFact: SkillFact = { kind: 'build-unconfirmed', basis: 'Build · shipped binary · measured 2026-08-28', words: "Build · On disk — this agent can't confirm loads" }
const absentFact: SkillFact = { kind: 'absent', basis: 'Table · nothing on disk', words: 'Not installed' }
const unknownFact: SkillFact = { kind: 'not-measured', basis: 'Table · no observation for this folder', words: 'Folders not measured' }

export const LIBRARY_SKILLS = [
  { name: 'brainstorming', description: 'Shape an idea into a reviewable design before implementation.', source: 'community-kit@4.2.1', facts: [tierAFact, tierBFact, { kind: 'copies-differ', basis: 'Table · location order · checked 2026-10-01; precedence not measured', words: 'Copies differ — which copy loads is not measured' }, absentFact], note: 'Copies differ', sourceVersion: '4.2.1', scope: 'User' },
  { name: 'code-review', description: 'Review a change against the repository rules.', source: 'Written here', facts: [{ kind: 'not-measured', basis: 'Table · written now; no check yet', words: 'Written — needs a re-check' }, { kind: 'build-unconfirmed', basis: 'Build · shipped binary · measured 2026-08-28', words: "Written — this agent can't confirm loads" }, tierBFact, tierBFact], note: "Written — can't confirm", scope: 'Project' },
  { name: 'release-check', description: 'Check release notes, version and packaging before a tag.', source: 'This Mac', facts: [tierAFact, tierBFact, tierBFact, tierBFact], note: 'Asked for one agent; on disk only for others', scope: 'User' },
  { name: 'test-plan', description: 'A local copy exists, but reach has not been measured.', source: 'On disk · ~/.agents/skills/test-plan', facts: [unknownFact, tierBFact, tierBFact, tierBFact], note: 'On disk · not measured', scope: 'User' },
  { name: 'pr-summary', description: 'Turn the diff and test evidence into a concise summary.', source: 'community-kit@2.8.0', facts: [tierAFact, tierBFact, tierBFact, tierBFact], note: 'community-kit · pinned 2.8.0', sourceVersion: '2.8.0', scope: 'User' },
  { name: 'deploy-check', description: 'A checked-in definition was declined by an agent that reports refusals.', source: 'This repository', facts: [{ kind: 'rejected', basis: 'Asked · 2 min ago', words: 'Refused · “I do not load repository-local instructions from this folder.”' }, tierBFact, tierBFact, tierBFact], note: 'Rejected with the agent’s own words', scope: 'Project' },
  { name: 'migration-map', description: 'Map old entry points to the new package layout.', source: 'This repository', facts: [{ kind: 'copies-differ', basis: 'Table · location order · checked 2026-10-01; precedence not measured', words: 'Copies differ — which copy loads is not measured' }, tierBFact, tierBFact, { kind: 'copies-differ', basis: 'Table · location order · checked 2026-10-01; precedence not measured', words: 'Copies differ — which copy loads is not measured' }], note: 'Copies differ', scope: 'Project' },
  { name: 'migration-map', description: 'A second copy of the same name, in this Mac’s skill folder.', source: 'This Mac', facts: [{ kind: 'copies-differ', basis: 'Table · location order · checked 2026-10-01; precedence not measured', words: 'Copies differ — which copy loads is not measured' }, tierBFact, tierBFact, { kind: 'copies-differ', basis: 'Table · location order · checked 2026-10-01; precedence not measured', words: 'Copies differ — which copy loads is not measured' }], note: 'Copies differ', scope: 'User' },
] as const

export const LIBRARY_COMMAND = {
  name: 'verify',
  description: 'Run the project verification command.',
  source: 'Command · .agents/commands/verify.md',
  facts: LIBRARY_AGENTS.map(() => ({ kind: 'command' as const, basis: 'Table · advertised command', words: 'Command' })),
}

export const LIBRARY_RULE_FACT: readonly SkillFact[] = LIBRARY_AGENTS.map(() => ({
  kind: 'not-measured',
  basis: 'Table · checked 2026-10-01; rules files have not been measured for any agent',
  words: 'Rules · not measured',
}))

export const LIBRARY_SERVER_FACTS = [
  [
    { kind: 'server-ready', basis: 'Table · server status · checked 2 min ago', words: 'Ready · table' },
    { kind: 'not-measured', basis: 'Table · configured; status not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'not-measured', basis: 'Table · configured; status not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'not-measured', basis: 'Table · configured; status not measured · checked 2 min ago', words: 'Configured · not measured' },
  ],
  [
    { kind: 'not-measured', basis: 'Table · configured; status not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'server-signin', basis: 'Table · sign-in required · checked 2 min ago', words: 'Needs sign-in · table' },
    { kind: 'not-measured', basis: 'Table · configured; status not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'not-measured', basis: 'Table · configured; status not measured · checked 2 min ago', words: 'Configured · not measured' },
  ],
  [
    { kind: 'not-measured', basis: 'Table · configured only; reach not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'not-measured', basis: 'Table · configured only; reach not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'not-measured', basis: 'Table · configured only; reach not measured · checked 2 min ago', words: 'Configured · not measured' },
    { kind: 'not-measured', basis: 'Table · configured only; reach not measured · checked 2 min ago', words: 'Configured · not measured' },
  ],
] as const

export const LIBRARY_RULES = [
  { name: 'AGENTS.md', place: 'Repository root', note: 'Shared project guidance' },
  { name: 'CLAUDE.md', place: 'Repository root · imports ./AGENTS.md', note: 'Imports AGENTS.md' },
  { name: 'AGENTS.md', place: 'packages/ui · nested rules', note: 'Nested scope' },
] as const

export const LIBRARY_SERVERS = [
  { name: 'docs-index', status: 'Ready', note: 'Loads on this machine' },
  { name: 'issue-tracker', status: 'Needs sign-in', note: 'One agent needs sign-in' },
  { name: 'local-tools', status: 'Configured', note: 'Configured only · not measured' },
] as const

export const LIBRARY_NEEDS_YOU = [
  { id: 'copies', title: 'brainstorming', decision: 'Two copies differ. Keep the pinned source or the repository copy?', action: 'Compare copies…', kind: 'Skills' },
  { id: 'confirm', title: 'code-review', decision: 'The live catalogue has not confirmed the written copy yet.', action: 'Have it look again', kind: 'Skills' },
  { id: 'signin', title: 'issue-tracker', decision: 'This server is configured; one agent needs sign-in.', action: 'Sign in', kind: 'Servers' },
  { id: 'updates', title: '3 source updates', decision: 'Review the new versions before any copy changes.', action: 'Review updates…', kind: 'Skills' },
  { id: 'receipt', title: 'Last install · partial receipt', decision: '3 of 4 changed. One target refused because it is read-only.', action: 'Review receipt', kind: 'Receipt', receipt: true },
] as const

export const LIBRARY_RECEIPT_TARGETS = [
  { name: LIBRARY_AGENTS[0]?.presentation.name ?? 'Agent one', state: 'Written — needs a re-check', changed: true, backup: true, retry: false, recheck: true },
  { name: LIBRARY_AGENTS[1]?.presentation.name ?? 'Agent two', state: "Written — this agent can't confirm", changed: true, backup: true, retry: false, recheck: false },
  { name: LIBRARY_AGENTS[2]?.presentation.name ?? 'Agent three', state: "Written — this agent can't confirm", changed: true, backup: true, retry: false, recheck: false },
  { name: LIBRARY_AGENTS[3]?.presentation.name ?? 'Agent four', state: 'Refused · read-only', changed: false, backup: false, retry: true, recheck: false },
] as const
