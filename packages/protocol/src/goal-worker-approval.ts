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
}
export interface LeadSavedApproval { readonly id: string; readonly target: string; readonly count: number }

/** Card and host audit use the same complete-diff bound. */
export const LEAD_APPROVAL_DETAIL_CHARS = 8000
/** Closed source/document extensions; eligibility also excludes hidden and authority filenames. */
export const LEAD_APPROVAL_FILE_EXTENSIONS = ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'fs', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm', 'py', 'rb', 'php', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'md', 'mdx'] as const
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const safeTools = new Set(['list_intents', 'get_context', 'get_team_status', 'review_candidates', 'list_findings'])
const absolute = (value: string) => value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.') && !hidden.test(value)
const inProject = (path: string, project: string) => absolute(path) && absolute(project) && (path === project || path.startsWith(project.replace(/\/$/, '') + '/'))
const safeFile = (path: string): boolean => {
  const parts = path.split('/'), name = parts.at(-1) ?? ''
  return !parts.some(part => part.startsWith('.')) &&
    !/rc|\.config\.|^(?:agents?(?:\.[^.]+)?|claude|gemini|instructions|rules|skill|copilot-instructions)\.md$|^(?:package\.json|makefile|dockerfile)$/i.test(name) &&
    LEAD_APPROVAL_FILE_EXTENSIONS.some(extension => name.toLowerCase().endsWith('.' + extension))
}
export const leadWorkerApprovalTarget = (key: LeadWorkerApprovalKey): string => key.kind === 'fileChange' ? key.path : key.tool
export const leadWorkerApprovalKey = (approval: Approval, project: string): LeadWorkerApprovalKey | null => {
  if (String(approval.id).startsWith('held-') || approval.reason || approval.extraGrants !== undefined) return null
  let key: LeadWorkerApprovalKey
  switch (approval.type) {
    case 'command': return null
    case 'fileChange': {
      const change = approval.changes[0]
      if (approval.grantRoot || approval.changes.length !== 1 || !change || change.kind.type === 'delete' ||
        change.kind.type === 'update' && change.kind.movePath || !inProject(change.path, project) || !safeFile(change.path)) return null
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
  if (Object.keys(rule).sort().join() !== ['id', 'contractDigest', 'goalStartedSeq', 'key', 'target', 'count'].sort().join() ||
    typeof rule.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(rule.id) || !/^[a-f0-9]{64}$/.test(rule.contractDigest) ||
    !Number.isSafeInteger(rule.goalStartedSeq) || rule.goalStartedSeq < 0 || !Number.isSafeInteger(rule.count) || rule.count < 0 || !rule.key) return fail()
  const key = rule.key
  const fields = key.kind === 'fileChange' ? ['kind', 'path'] : key.kind === 'tool' ? ['kind', 'tool'] : []
  if (!fields.length || Object.keys(key).sort().join() !== fields.sort().join() || Object.values(key).some(value => typeof value !== 'string') ||
    rule.target !== leadWorkerApprovalTarget(key) || rule.target.length > 240) return fail()
  if (key.kind === 'fileChange' ? !absolute(key.path) || !safeFile(key.path) : !safeTools.has(key.tool)) return fail()
  return structuredClone(rule)
}
export const leadWorkerRuleInProject = (key: LeadWorkerApprovalKey, project: string): boolean => key.kind === 'tool' || inProject(key.path, project)
