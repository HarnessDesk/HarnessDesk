import type { CapabilityContribution } from '@harnessdesk/protocol'
import { fixedSubject, dock, dockViews, replaceView, activate, activeView, focusView, type Workbench } from './workbench'
import { findPane, sameView, type PaneView } from './layout'

export type WorkTool = 'conversation' | 'details' | 'changes' | 'activity' | 'browser' | 'terminal' | 'files'
export interface ToolIntent {
  readonly tool: WorkTool
  readonly mode: string
  readonly open: boolean
  readonly railOpen?: boolean
  readonly expanded?: boolean
  /** The selected shell belongs to this subject, independently of the shared cache. */
  readonly selectedTerminal?: string
  /** Conversation mode's panel, restored when this Editor visit ends. */
  readonly beforeEditor?: Omit<ToolIntent, 'beforeEditor'> & { readonly mount?: string }
}
export interface FixedToolContext { readonly editor: boolean; readonly view: PaneView }
export const conversationToolContext = (before: Workbench, editor: boolean): FixedToolContext => ({ editor, view: findPane(before.main, before.main.focused)!.view })
export const toolOf = (kind: string): WorkTool | null => {
  if (kind === 'terminal' || kind === 'files') return kind
  if (kind === 'conversation') return 'conversation'
  if (['run-details', 'agents', 'plugin', 'details'].includes(kind)) return 'details'
  if (kind === 'changes' || kind === 'git') return 'changes'
  if (kind === 'file' || kind === 'preview') return 'files'
  if (['activity', 'trajectory', 'tasks'].includes(kind)) return 'activity'
  return kind === 'browser' ? 'browser' : null
}
/** Retained compatibility payloads do not grant an undeclared fixed-panel mount. */
export const supportsFixedTool = (view: PaneView, contributions: readonly CapabilityContribution[] = [], context?: FixedToolContext): boolean => {
  if (view.kind === 'conversation') return context?.editor === true && view.session !== null && context.view.kind === 'conversation' && view.session === context.view.session
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
  const held = [...dockViews(before.right), ...dockViews(before.bottom)].find(one => one.id === id)
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
  ...(before?.selectedTerminal ? { selectedTerminal: before.selectedTerminal } : {}),
  ...(before?.beforeEditor ? { beforeEditor: before.beforeEditor } : {}),
  ...(before?.railOpen === undefined ? {} : { railOpen: before.railOpen }),
  ...(before?.expanded === undefined ? {} : { expanded: toggle && before.open && before.tool === tool && before.mode === mode ? false : before.expanded }),
  tool, mode, open: !(toggle && before?.open && before.tool === tool && before.mode === mode),
})
export const setToolOpen = (before: ToolIntent, open: boolean): ToolIntent => ({ ...before, open })
export const readToolIntents = (raw: unknown): Readonly<Record<string, ToolIntent>> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    if (typeof value !== 'object' || value === null) return []
    const record = value as Record<string, unknown>
    const tool = record.tool === 'activity' && record.mode === 'git' ? 'changes'
      : record.tool === 'changes' && (record.mode === 'file' || record.mode === 'preview') ? 'files'
      : typeof record.tool === 'string' ? toolOf(record.tool) : null
    const validMode = typeof record.mode === 'string' && toolOf(record.mode) === tool
    // The old Details pane is now the independent card rail. Explicit
    // plugin, Run inspection and Agents modes still select real pane bodies.
    const pureDetails = tool === 'details' && record.mode === 'details'
    const open = !pureDetails && record.open === true
    const rawPrior = record.beforeEditor as Record<string, unknown> | undefined
    const prior = rawPrior && typeof rawPrior === 'object' ? readToolIntents({ prior: {
      tool: rawPrior.tool, mode: rawPrior.mode, open: rawPrior.open,
      railOpen: rawPrior.railOpen, expanded: rawPrior.expanded,
      selectedTerminal: rawPrior.selectedTerminal,
    } }).prior : undefined
    const beforeEditor = prior && prior.tool !== 'conversation' ? { ...prior, ...(typeof rawPrior?.mount === 'string' ? { mount: rawPrior.mount } : {}) } : undefined
    return tool && validMode && typeof record.mode === 'string' && typeof record.open === 'boolean'
      ? [[key, { tool, mode: record.mode, open,
        ...(typeof record.railOpen === 'boolean' ? { railOpen: record.railOpen } : pureDetails ? { railOpen: record.open } : {}),
        ...(typeof record.expanded === 'boolean' ? { expanded: record.expanded && open } : {}),
        ...(typeof record.selectedTerminal === 'string' ? { selectedTerminal: record.selectedTerminal } : {}),
        ...(beforeEditor ? { beforeEditor } : {}) }]] : []
  }))
}

export const admitFixedTool = (before: Workbench, view: PaneView, toggle = false, context?: FixedToolContext): Workbench | null => {
  if (view.kind === 'tasks') view = { kind: 'activity' }
  const subject = fixedSubject(before.main), tool = toolOf(view.kind)
  if (!subject || !tool || !supportsFixedTool(view, [], context)) return null
  if (view.kind === 'terminal') {
    const routed = dock(before, 'bottom', view, subject)
    const mounted = dockViews(routed.bottom).find(one => sameView(one.view, view))!
    const pane = findPane(before.main, before.main.focused)!
    return { ...routed, toolOwners: { ...routed.toolOwners, [mounted.id]: subject },
      frameTools: { ...routed.frameTools, [subject]: { ...chooseTool(before.frameTools[subject], 'terminal', 'terminal', toggle), selectedTerminal: mounted.id } },
      frameSubjects: { ...routed.frameSubjects, [subject]: { paneId: pane.id, view: pane.view } } }
  }
  if (view.kind === 'conversation') {
    const intent = chooseTool(before.frameTools[subject], tool, view.kind, toggle)
    const pane = findPane(before.main, before.main.focused)!
    return { ...before, ...(intent.open ? { focus: null } : {}), right: { ...before.right, collapsed: !intent.open },
      frameTools: { ...before.frameTools, [subject]: intent },
      frameSubjects: { ...before.frameSubjects, [subject]: { paneId: pane.id, view: pane.view } } }
  }
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
  const held = [...dockViews(before.right), ...dockViews(before.bottom)].find(one => one.id === id)
  const owner = before.toolOwners[id]
  const tool = held && toolOf(held.view.kind)
  const scope = owner ? before.frameSubjects[owner] : undefined
  if (!held || !owner || !tool || !scope || !supportsFixedTool(held.view)) return null
  const main = fixedSubject(before.main) === owner ? before.main : {
    root: { kind: 'pane' as const, id: scope.paneId, view: scope.view }, focused: scope.paneId, expanded: null,
  }
  const next = focusView(activate({ ...before, main }, held.view.kind === 'terminal' ? 'bottom' : 'right', id), id)
  return { ...next, right: { ...next.right, collapsed: false },
    frameTools: { ...next.frameTools, [owner]: chooseTool(next.frameTools[owner], tool, held.view.kind) } }
}

/** The Conversation body moves; the subject and ordinary tool cache never do. */
export const settleConversationTool = (before: Workbench, editor: boolean, entering = false): Workbench => {
  const subject = editor ? fixedSubject(before.main) : null
  let next = before
  for (const [owner, intent] of Object.entries(before.frameTools)) {
    if (owner === subject) continue
    if (intent.beforeEditor || intent.tool === 'conversation') {
      const { mount, ...prior } = intent.beforeEditor ?? { tool: 'details', mode: 'details', open: false }
      const restored = { ...prior, ...(intent.railOpen === undefined ? {} : { railOpen: intent.railOpen }),
        ...(intent.selectedTerminal === undefined ? {} : { selectedTerminal: intent.selectedTerminal }) }
      const held = mount ? dockViews(next.right).find(one => one.id === mount && next.toolOwners[one.id] === owner && one.view.kind === restored.mode) : undefined
      if (held) next = activate(next, 'right', held.id)
      next = { ...next, frameTools: { ...next.frameTools, [owner]: restored } }
      const focused = next.focus ? dockViews(next.right).find(one => one.id === next.focus) : undefined
      if (focused && (owner === fixedSubject(next.main) || next.toolOwners[focused.id] === owner)) {
        const visible = owner === fixedSubject(next.main) && restored.open && next.toolOwners[focused.id] === owner && activeView(next.right)?.id === focused.id
          && focused.view.kind === restored.mode && (restored.tool !== 'details' || restored.mode === 'plugin')
        if (!visible) next = { ...next, focus: null }
      }
    }
  }
  if (subject && (entering || !next.frameTools[subject]?.beforeEditor)) {
    const prior = next.frameTools[subject]
    const current = activeView(next.right)
    const beforeEditor = prior?.beforeEditor ?? (prior && prior.tool !== 'conversation' ? { ...prior,
      ...(current && next.toolOwners[current.id] === subject && current.view.kind === prior.mode ? { mount: current.id } : {}) }
      : { tool: 'details' as const, mode: 'details', open: false })
    next = { ...next, focus: null, frameTools: { ...next.frameTools, [subject]: {
      tool: 'conversation', mode: 'conversation', open: true, beforeEditor,
      ...(prior?.railOpen === undefined ? {} : { railOpen: prior.railOpen }),
      ...(prior?.selectedTerminal === undefined ? {} : { selectedTerminal: prior.selectedTerminal }),
    } } }
  }
  const active = fixedSubject(next.main), selected = active ? next.frameTools[active] : undefined
  if (next !== before && selected) next = { ...next, right: { ...next.right, collapsed: !selected.open } }
  return next
}
