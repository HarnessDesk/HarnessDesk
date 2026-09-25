import type {
  CeilingLevel, FlowAgentRole, FlowCheck, FlowPolicy, FlowPolicyRole, FlowPolicyRule, FlowThen,
} from '@harnessdesk/protocol'

/**
 * Small, pure helpers the ordered editor and its graph share: building a
 * default step or rule, keeping a rename's references together, and finding
 * what a role is used by. None of this decides what is valid — the render
 * call (`authoring/shape/render`, `writeShape` on the host) is the one judge
 * of that, the same parser the dry run and the engine read. This is only the
 * shape a fresh row starts from and the bookkeeping a rename or a removal
 * needs before it asks the host anything.
 */

/** Every step kind, named in the plain word the editor shows for it. */
export const ROLE_KIND_WORDS: Readonly<Record<FlowPolicyRole['kind'], string>> = {
  agent: 'Agent', check: 'Check', person: 'Person',
}
export const ROLE_KINDS: readonly FlowPolicyRole['kind'][] = ['agent', 'check', 'person']

/** A role or rule id from a label a person typed, made unique against what already exists. */
export const uniqueId = (base: string, taken: ReadonlySet<string>, fallback = 'step'): string => {
  const slug = base.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n += 1) {
    const next = `${slug}-${n}`.slice(0, 48)
    if (!taken.has(next)) return next
  }
}

const DEFAULT_CHECK: FlowCheck = { run: '', timeout: 900, exits: { '0': 'pass' }, otherwise: 'fail' }

export const defaultAgentRole = (id: string): FlowAgentRole => ({
  id, kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [],
})
export const defaultCheckRole = (id: string): FlowPolicyRole => ({ id, kind: 'check', check: DEFAULT_CHECK })
export const defaultPersonRole = (id: string): FlowPolicyRole => ({ id, kind: 'person', outcomes: ['done'] })

/** A fresh row of the chosen kind — never guessing an Agent, a command or an outcome the file would have to invent. */
export const defaultRole = (kind: FlowPolicyRole['kind'], id: string): FlowPolicyRole => (
  kind === 'agent' ? defaultAgentRole(id) : kind === 'check' ? defaultCheckRole(id) : defaultPersonRole(id)
)

export const defaultThen = (role: string, title = 'Continue'): FlowThen => ({ role, title })
export const defaultRule = (id: string, on: string, targetRole: string): FlowPolicyRule => ({ id, on, then: defaultThen(targetRole) })

/**
 * An empty valid draft: one person step and nothing else. No Agent is
 * guessed and no startup happens while authoring — the decision "Your own
 * shape starts from a chosen file or an empty valid draft with a person
 * step."
 */
export const emptyShapePolicy = (name = 'Your own shape'): FlowPolicy => ({
  version: 2,
  name,
  inputs: [{ id: 'task', label: 'Task' }],
  roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }],
  rules: [],
  seed: { role: 'review', title: '{{task}}' },
  messaging: 'board-only',
  wait: 240,
})

/**
 * Renaming a role updates every place that names it, together: the decision
 * "Renaming a role shows the affected seed/rules and updates references
 * together in the draft." Reordering never calls this — only an actual id
 * change does, and roles/rules stay addressed by that id, never by array
 * position.
 */
export const renameRoleReferences = (policy: FlowPolicy, from: string, to: string): FlowPolicy => {
  if (from === to) return policy
  return {
    ...policy,
    roles: policy.roles.map((role) => (
      role.kind === 'agent' && role.independentOf.includes(from)
        ? { ...role, independentOf: role.independentOf.map((id) => (id === from ? to : id)) }
        : role
    )),
    rules: policy.rules.map((rule) => ({
      ...rule,
      on: rule.on === from ? to : rule.on,
      then: { ...rule.then, role: rule.then.role === from ? to : rule.then.role },
    })),
    seed: { ...policy.seed, role: policy.seed.role === from ? to : policy.seed.role },
  }
}

/** Every rule that names this role, on either side — what removal checks before it refuses. */
export const rulesReferencing = (policy: FlowPolicy, roleId: string): readonly FlowPolicyRule[] =>
  policy.rules.filter((rule) => rule.on === roleId || rule.then.role === roleId)

/** Whether removing this role is safe: nothing left still points at it, and it is not the seed. */
export const roleRemovable = (policy: FlowPolicy, roleId: string): boolean =>
  policy.seed.role !== roleId && rulesReferencing(policy, roleId).length === 0

export const CEILINGS: readonly CeilingLevel[] = ['read', 'edit', 'publish', 'merge']

/** A short list of words, one per line — the same idiom `AgentFields` uses for `answers`/`produces`. */
export const wordLines = (words: readonly string[]): string => words.join('\n')
export const parseWordLines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean)

/** `exits:` as one line per code — "0: pass" — the plain-text form the check editor shows and edits. */
export const exitLines = (exits: Readonly<Record<string, string>>): string =>
  Object.entries(exits).map(([code, outcome]) => `${code}: ${outcome}`).join('\n')
export const parseExitLines = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s*:\s*(.+)$/.exec(trimmed)
    if (match) out[match[1]!] = match[2]!.trim()
  }
  return out
}
