import type { CapabilityContribution } from '@harnessdesk/protocol'
import { fixedSubject, dock, dockViews, replaceView, activate, focusView, type Workbench } from './workbench'
import { findPane, sameView, type PaneView } from './layout'

export type WorkTool = 'details' | 'changes' | 'activity' | 'browser'
export interface ToolIntent {
  readonly tool: WorkTool
  readonly mode: string
  readonly open: boolean
}
export const toolOf = (kind: string): WorkTool | null => {
  if (['run-details', 'agents', 'plugin', 'details'].includes(kind)) return 'details'
  if (['changes', 'file', 'preview'].includes(kind)) return 'changes'
  if (['activity', 'trajectory', 'tasks', 'git'].includes(kind)) return 'activity'
  return kind === 'browser' ? 'browser' : null
}
/** Retained compatibility payloads do not grant an undeclared fixed-panel mount. */
export const supportsFixedTool = (view: PaneView, contributions: readonly CapabilityContribution[] = []): boolean => {
  if (!toolOf(view.kind)) return false
  if (view.kind !== 'plugin') return true
  if (!view.mounts.includes('right')) return false
  const current = contributions.find(one => one.kind === 'ui' && String(one.id) === view.contribution)
  // No loaded contribution keeps the existing unavailable-plugin placeholder.
  // An available declaration is authoritative, including an inline-only one.
  return current?.kind !== 'ui' || current.mounts?.includes('right') === true
}

/** Shared refusal for explicit cache consumers, before any legacy reveal fallback. */
export const fixedToolRefusal = (before: Workbench, id: string, contributions: readonly CapabilityContribution[] = []): string | null => {
  const held = dockViews(before.right).find(one => one.id === id)
  if (!held || !toolOf(held.view.kind)) return null
  if (!supportsFixedTool(held.view, contributions)) return 'This plugin panel does not support the fixed right panel.'
  const owner = before.toolOwners[id]
  return owner && !before.frameSubjects[owner] ? 'This tool’s work is no longer available.' : null
}

/** Removal revokes navigation, while resource payloads and their original owners stay retained. */
export const forgetFrameSubject = (before: Workbench, subject: string): Workbench => {
  if (!before.frameSubjects[subject] && !before.frameTools[subject]) return before
  const { [subject]: _scope, ...frameSubjects } = before.frameSubjects
  const { [subject]: _intent, ...frameTools } = before.frameTools
  return { ...before, frameSubjects, frameTools }
}

export const chooseTool = (before: ToolIntent | undefined, tool: WorkTool, mode = tool as string, toggle = false): ToolIntent => ({
  tool, mode, open: !(toggle && before?.open && before.tool === tool && before.mode === mode),
})
export const setToolOpen = (before: ToolIntent, open: boolean): ToolIntent => ({ ...before, open })
export const readToolIntents = (raw: unknown): Readonly<Record<string, ToolIntent>> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    if (typeof value !== 'object' || value === null) return []
    const record = value as Record<string, unknown>
    const tool = typeof record.tool === 'string' ? toolOf(record.tool) : null
    const validMode = typeof record.mode === 'string' && toolOf(record.mode) === tool
    return tool && validMode && typeof record.mode === 'string' && typeof record.open === 'boolean'
      ? [[key, { tool, mode: record.mode, open: record.open }]] : []
  }))
}

export const admitFixedTool = (before: Workbench, view: PaneView, toggle = false): Workbench | null => {
  if (view.kind === 'tasks') view = { kind: 'activity' }
  const subject = fixedSubject(before.main), tool = toolOf(view.kind)
  if (!subject || !tool || !supportsFixedTool(view)) return null
  let routed = dock(before, 'right', view, subject)
  // Plugin identity is its contribution; a new accepted manifest must update
  // that payload rather than reuse an obsolete hidden declaration verbatim.
  if (view.kind === 'plugin') {
    const held = dockViews(routed.right).find(one => routed.toolOwners[one.id] === subject && sameView(one.view, view))
    if (held) routed = replaceView(routed, held.id, view)
  }
  const previousIds = new Set(dockViews(before.right).map(one => one.id))
  const owners = { ...routed.toolOwners }
  for (const one of dockViews(routed.right)) {
    if (!previousIds.has(one.id) || (owners[one.id] === subject && sameView(one.view, view))) owners[one.id] = subject
  }
  const intent = chooseTool(before.frameTools[subject], tool, view.kind, toggle)
  const pane = findPane(before.main, before.main.focused)!
  return { ...routed, right: { ...routed.right, collapsed: !intent.open }, toolOwners: owners,
    frameTools: { ...routed.frameTools, [subject]: intent },
    frameSubjects: { ...routed.frameSubjects, [subject]: { paneId: pane.id, view: pane.view } } }
}

/** An explicit resource reveal returns to its recorded work before selecting its tool. */
export const revealFixedTool = (before: Workbench, id: string): Workbench | null => {
  const held = dockViews(before.right).find(one => one.id === id)
  const owner = before.toolOwners[id]
  const tool = held && toolOf(held.view.kind)
  const scope = owner ? before.frameSubjects[owner] : undefined
  if (!held || !owner || !tool || !scope || !supportsFixedTool(held.view)) return null
  const main = fixedSubject(before.main) === owner ? before.main : {
    root: { kind: 'pane' as const, id: scope.paneId, view: scope.view }, focused: scope.paneId, expanded: null,
  }
  const next = focusView(activate({ ...before, main }, 'right', id), id)
  return { ...next, right: { ...next.right, collapsed: false },
    frameTools: { ...next.frameTools, [owner]: chooseTool(next.frameTools[owner], tool, held.view.kind) } }
}
