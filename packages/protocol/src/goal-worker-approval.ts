import type { Approval } from './approval.js'
import type { LeadThreadState } from './lead.js'

/** Exact keys only. Unknown shell programs and unstructured permission prose have no safe reusable scope. */
export type LeadWorkerApprovalKey =
  | { readonly kind: 'fileChange'; readonly path: string }
  | { readonly kind: 'tool'; readonly tool: string }
export interface LeadWorkerApprovalRule {
  readonly id: string
  readonly contractDigest: string
  readonly goalStartedSeq: number
  readonly key: LeadWorkerApprovalKey
  readonly target: string
  /** Later requests answered automatically; the creating click is not counted. */
  readonly count: number
  readonly revoked?: true
  readonly dispatch?: { readonly revision: number; readonly diff: string | null; readonly phase: LeadThreadState; readonly reason: string | null }
  /** Newest first, file rules only; independent of the conversation window. */
  readonly entries?: readonly LeadApprovalEntry[]
}
export interface LeadApprovalEntry { readonly id: string; readonly number: number; readonly diff: string; readonly uncertain?: true }
export interface LeadSavedApproval { readonly id: string; readonly target: string; readonly count: number; readonly entries?: readonly LeadApprovalEntry[]; readonly uncertain?: true }
export const LEAD_APPROVAL_ENTRIES = 8
export const LEAD_APPROVAL_RULE_BYTES = 32768
export const LEAD_APPROVAL_HISTORY_BYTES = 262144
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
export const boundLeadApprovalEntries = (entries: readonly LeadApprovalEntry[]): readonly LeadApprovalEntry[] => {
  const kept = entries.slice(0, LEAD_APPROVAL_ENTRIES)
  while (bytes(kept) > LEAD_APPROVAL_RULE_BYTES) kept.pop()
  return kept
}
/** Oldest audit first across rules too; exact lifetime counts are never windowed. */
export const boundLeadApprovalHistory = (rules: readonly LeadWorkerApprovalRule[]): readonly LeadWorkerApprovalRule[] => {
  const kept = rules.map(rule => ({ ...rule, ...(rule.entries ? { entries: [...rule.entries] } : {}) }))
  while (bytes(kept.map(rule => rule.entries ?? [])) > LEAD_APPROVAL_HISTORY_BYTES) {
    const oldest = kept.filter(rule => rule.entries?.length).sort((a, b) => Number(a.entries!.at(-1)!.id.slice(6)) - Number(b.entries!.at(-1)!.id.slice(6)))[0]
    if (!oldest) break
    oldest.entries = oldest.entries!.slice(0, -1)
  }
  return kept
}
/** A dispatch is an attempted request, never an acknowledged answer. */
export const leadWorkerApprovalEntries = (rule: LeadWorkerApprovalRule): readonly LeadApprovalEntry[] => boundLeadApprovalEntries([
  ...(typeof rule.dispatch?.diff === 'string' ? [{ id: `audit-${rule.dispatch.revision}`, number: rule.count + 1, diff: rule.dispatch.diff, uncertain: true as const }] : []),
  ...rule.entries ?? [],
])
export const parseLeadApprovalEntries = (value: unknown): readonly LeadApprovalEntry[] => {
  if (!Array.isArray(value) || value.length > LEAD_APPROVAL_ENTRIES || bytes(value) > LEAD_APPROVAL_RULE_BYTES) throw new Error('lead-worker-approval-entries')
  let previous = Infinity
  const ids = new Set<string>()
  for (const entry of value) {
    if (!entry || Object.keys(entry).sort().join() !== ['diff', 'id', 'number', ...(Object.hasOwn(entry, 'uncertain') ? ['uncertain'] : [])].sort().join() || Object.hasOwn(entry, 'uncertain') && entry.uncertain !== true || !/^audit-[1-9][0-9]*$/.test(entry.id) || !Number.isSafeInteger(Number(entry.id.slice(6))) || ids.has(entry.id) ||
      !Number.isSafeInteger(entry.number) || entry.number < 1 || entry.number >= previous || typeof entry.diff !== 'string' || entry.diff.length > LEAD_APPROVAL_DETAIL_CHARS || /[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\t\r\n]/u.test(entry.diff)) throw new Error('lead-worker-approval-entries')
    previous = entry.number; ids.add(entry.id)
  }
  return structuredClone(value)
}

/** Card and host audit use the same complete-diff bound. */
export const LEAD_APPROVAL_DETAIL_CHARS = 8000
/** Closed source/document extensions; eligibility also excludes hidden and authority filenames. */
export const LEAD_APPROVAL_FILE_EXTENSIONS = ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'fs', 'go', 'rs', 'java', 'kt', 'swift', 'm', 'mm', 'py', 'rb', 'php', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'md', 'mdx'] as const
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const safeTools = new Set(['list_intents', 'get_context', 'get_team_status', 'review_candidates', 'list_findings'])
const absolute = (value: string) => value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.') && !hidden.test(value)
const inProject = (path: string, project: string) => absolute(path) && absolute(project) && (path === project || path.startsWith(project.replace(/\/$/, '') + '/'))
export const leadWorkerApprovalAsciiPath = (relative: string): boolean => relative.split('/').every(part => /^[\x20-\x7e]+$/.test(part))
const safeFile = (relative: string): boolean => {
  const parts = relative.split('/'), name = parts.at(-1) ?? '', lower = name.toLowerCase()
  // The short source stems src and arc are ordinary code, despite matching the general rc spelling.
  const rcFile = /^\.?[a-z0-9_-]*rc(\.[a-z]+)?$/.test(lower) && !/^[a-z]rc\.[a-z]+$/.test(lower)
  // Runner names are explicit: ordinary profile.* and file.utils.* are source.
  const automationFile = /^(?:gulpfile|gruntfile|jakefile|pnpmfile|brocfile|noxfile|rakefile|taskfile|dangerfile|cakefile|guardfile|makefile|webpackfile)(?:\.[a-z]+)*\.(?:js|ts|mjs|cjs)$/i.test(name)
  return leadWorkerApprovalAsciiPath(relative) && !automationFile && !rcFile && !parts.some(part => part.startsWith('.')) && !parts.slice(0, -1).some(part => /^(scripts?|bin|hooks)$/i.test(part)) &&
    !/(?:\.local\.|\.conf\.|\.config\.|\.setup\.|\.workspace\.|-config\.|^gatsby-|\.gradle|\.(?:gemspec|podspec)$)|^(?:agents?(?:\.[^.]+)*|claude|gemini|warp|qwen|crush|instructions|rules|skill|copilot-instructions|conventions)\.md$|^(?:package\.json|ember-cli-build\.js|makefile|dockerfile|pom\.xml|package\.swift|build\..*|setup\.(?:py|cfg)|conf\.py|sitecustomize\.py|usercustomize\.py|conftest\.py|noxfile\.py|tasks\.py|fabfile\.py|manage\.py|rakefile|gemfile|podfile|cmakelists\.txt|meson\.build)$/i.test(name) &&
    LEAD_APPROVAL_FILE_EXTENSIONS.some(extension => name.toLowerCase().endsWith('.' + extension))
}
const fileInProject = (path: string, project: string) => inProject(path, project) && safeFile(path.slice(project.replace(/\/$/, '').length + 1))
export const leadWorkerApprovalTarget = (key: LeadWorkerApprovalKey): string => key.kind === 'fileChange' ? key.path : key.tool
export const leadWorkerApprovalKey = (approval: Approval, project: string): LeadWorkerApprovalKey | null => {
  if (String(approval.id).startsWith('held-') || approval.reason || approval.extraGrants !== undefined) return null
  let key: LeadWorkerApprovalKey
  switch (approval.type) {
    case 'command': return null
    case 'fileChange': {
      const change = approval.changes[0]
      if (approval.grantRoot || approval.changes.length !== 1 || !change || change.kind.type === 'delete' ||
        change.kind.type === 'update' && change.kind.movePath || !fileInProject(change.path, project)) return null
      key = { kind: 'fileChange', path: change.path }; break
    }
    case 'permission': {
      if (approval.gateway || approval.filesystem?.length || approval.network?.length || approval.facts?.length) return null
      const tool = approval.flowBoardTool?.server === 'harnessdesk' ? approval.flowBoardTool.tool : null
      if (!tool || !safeTools.has(tool)) return null
      if (hidden.test(tool) || hidden.test(approval.summary)) return null
      key = { kind: 'tool', tool }; break
    }
    default: return null
  }
  return leadWorkerApprovalTarget(key).length <= 240 ? key : null
}
/** Closed persistence shape. Recheck semantic eligibility against the contract at replay and checkpoint load. */
export const parseLeadWorkerApprovalRule = (value: unknown, history = false): LeadWorkerApprovalRule => {
  const fail = (): never => { throw new Error('lead-worker-approval-rule') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const rule = value as LeadWorkerApprovalRule
  if (Object.keys(rule).sort().join() !== ['id', 'contractDigest', 'goalStartedSeq', 'key', 'target', 'count', ...(['entries', 'revoked', 'dispatch'] as const).filter(key => Object.hasOwn(rule, key))].sort().join() ||
    typeof rule.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(rule.id) || !/^[a-f0-9]{64}$/.test(rule.contractDigest) ||
    !Number.isSafeInteger(rule.goalStartedSeq) || rule.goalStartedSeq < 0 || !Number.isSafeInteger(rule.count) || rule.count < 0 || !rule.key) return fail()
  const key = rule.key
  // Recognize the exact former command shape only to remove it during load.
  if ((key as { kind: string }).kind === 'command') {
    const legacy = key as unknown as { kind: string; command: string; cwd: string }
    if (Object.keys(legacy).sort().join() !== 'command,cwd,kind' || typeof legacy.command !== 'string' || typeof legacy.cwd !== 'string' || rule.target !== `${legacy.command} in ${legacy.cwd}` || rule.entries !== undefined) return fail()
    throw new Error('lead-worker-approval-obsolete')
  }
  const fields = key.kind === 'fileChange' ? ['kind', 'path'] : key.kind === 'tool' ? ['kind', 'tool'] : []
  if (!fields.length || Object.keys(key).sort().join() !== fields.sort().join() || Object.values(key).some(value => typeof value !== 'string') ||
    rule.target !== leadWorkerApprovalTarget(key) || rule.target.length > 240) return fail()
  if (key.kind === 'fileChange' ? !absolute(key.path) : !safeTools.has(key.tool)) return fail()
  if (rule.entries !== undefined) {
    const entries = parseLeadApprovalEntries(rule.entries)
    if (key.kind !== 'fileChange' || entries.some((entry, index) => entry.uncertain ? !rule.revoked || index !== 0 || entry.number !== rule.count + 1 : entry.number > rule.count)) return fail()
  }
  if (Object.hasOwn(rule, 'revoked') && rule.revoked !== true) return fail()
  if (rule.dispatch !== undefined) {
    const dispatch = rule.dispatch
    if (rule.revoked || Object.keys(dispatch).sort().join() !== 'diff,phase,reason,revision' || !Number.isSafeInteger(dispatch.revision) || dispatch.revision < 1 ||
      !['draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user'].includes(dispatch.phase) || dispatch.reason !== null && (typeof dispatch.reason !== 'string' || dispatch.reason.length > 256) ||
      (key.kind === 'tool' ? dispatch.diff !== null : typeof dispatch.diff !== 'string')) return fail()
    if (typeof dispatch.diff === 'string') parseLeadApprovalEntries([{ id: `audit-${dispatch.revision}`, number: 1, diff: dispatch.diff }])
  }
  // Inert file history and migration readers keep structurally valid audit
  // data even when the target no longer qualifies for an active rule.
  if (!history && !rule.revoked && key.kind === 'fileChange' && !safeFile(key.path.split('/').at(-1)!)) throw new Error('lead-worker-approval-obsolete')
  return structuredClone(rule)
}
export const leadWorkerRuleInProject = (key: LeadWorkerApprovalKey, project: string): boolean => key.kind === 'tool' || fileInProject(key.path, project)
