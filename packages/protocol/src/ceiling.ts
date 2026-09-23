import type { CeilingLevel } from './evidence.js'
import type { FlowPermission } from './flow.js'

/**
 * The ladder a ceiling is written in, and the one place its order lives.
 *
 * `read < edit < publish < merge`. The legacy `permission:` key keeps its
 * original meaning: its `read` allowed edits and commits, which `edit` names
 * on the new ladder.
 */
const RANK: Readonly<Record<CeilingLevel, number>> = { read: 0, edit: 1, publish: 2, merge: 3 }

export const CEILING_LEVELS: readonly CeilingLevel[] = ['read', 'edit', 'publish', 'merge']

export const isCeilingLevel = (word: string): word is CeilingLevel => Object.hasOwn(RANK, word)

export const reaches = (level: CeilingLevel, needed: CeilingLevel): boolean => RANK[level] >= RANK[needed]

export const narrower = (a: CeilingLevel, b: CeilingLevel): CeilingLevel => (RANK[a] <= RANK[b] ? a : b)

export const ceilingOfPermission = (permission: FlowPermission): CeilingLevel =>
  permission === 'read' ? 'edit' : permission

export const permissionOfCeiling = (level: CeilingLevel): FlowPermission | null =>
  level === 'read' ? null : level === 'edit' ? 'read' : level
