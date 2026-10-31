import type { Approval } from './approval.js'

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
  /** Newest first, file rules only; independent of the conversation window. */
  readonly entries?: readonly LeadApprovalEntry[]
}
export interface LeadApprovalEntry { readonly id: string; readonly number: number; readonly diff: string }
export interface LeadSavedApproval { readonly id: string; readonly target: string; readonly count: number; readonly entries?: readonly LeadApprovalEntry[] }
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
export const parseLeadApprovalEntries = (value: unknown): readonly LeadApprovalEntry[] => {
  if (!Array.isArray(value) || value.length > LEAD_APPROVAL_ENTRIES || bytes(value) > LEAD_APPROVAL_RULE_BYTES) throw new Error('lead-worker-approval-entries')
  let previous = Infinity
  const ids = new Set<string>()
  for (const entry of value) {
    if (!entry || Object.keys(entry).sort().join() !== 'diff,id,number' || !/^audit-[1-9][0-9]*$/.test(entry.id) || !Number.isSafeInteger(Number(entry.id.slice(6))) || ids.has(entry.id) ||
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
const safeFile = (relative: string): boolean => {
  const parts = relative.split('/'), name = parts.at(-1) ?? ''
  return !parts.some(part => part.startsWith('.')) && !parts.slice(0, -1).some(part => /^(scripts?|bin|hooks)$/i.test(part)) &&
    !/(?:rc$|rc\.|\.local\.|\.config\.|\.setup\.|\.gradle|\.(?:gemspec|podspec)$|file\.(?:js|ts|mjs)$)|^(?:agents?(?:\.[^.]+)*|claude|gemini|instructions|rules|skill|copilot-instructions|conventions)\.md$|^(?:package\.json|makefile|dockerfile|pom\.xml|package\.swift|build\..*|setup\.(?:py|cfg)|conftest\.py|noxfile\.py|tasks\.py|fabfile\.py|manage\.py|rakefile|gemfile|podfile|cmakelists\.txt|meson\.build)$/i.test(name) &&
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
export const parseLeadWorkerApprovalRule = (value: unknown): LeadWorkerApprovalRule => {
  const fail = (): never => { throw new Error('lead-worker-approval-rule') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const rule = value as LeadWorkerApprovalRule
  if (Object.keys(rule).sort().join() !== ['id', 'contractDigest', 'goalStartedSeq', 'key', 'target', 'count', ...(Object.hasOwn(rule, 'entries') ? ['entries'] : [])].sort().join() ||
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
  if (key.kind === 'fileChange' && !safeFile(key.path.split('/').at(-1)!)) throw new Error('lead-worker-approval-obsolete')
  if (rule.entries !== undefined) {
    const entries = parseLeadApprovalEntries(rule.entries)
    if (key.kind !== 'fileChange' || entries.some(entry => entry.number > rule.count)) return fail()
  }
  return structuredClone(rule)
}
export const leadWorkerRuleInProject = (key: LeadWorkerApprovalKey, project: string): boolean => key.kind === 'tool' || fileInProject(key.path, project)
