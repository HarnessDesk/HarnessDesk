import type { Workbench } from '../state/workbench'
import type { FileDocumentState, FileLiveDocumentState, FileViewMode } from './FileView'

export type WindowMode = 'conversation' | 'editor'
export type ExplorerFilter = 'changed' | 'all'
export interface EditorTab {
  readonly path: string
  readonly view: FileViewMode
}
export interface EditorConversation {
  readonly tabs: readonly EditorTab[]
  readonly active: string | null
  readonly preview: string | null
  /** Null follows the current changed-file count until the person chooses. */
  readonly filter: ExplorerFilter | null
  readonly expanded: readonly string[]
}
/** Most recently used first. The live window retains older entries too. */
export type EditorState = readonly { readonly subject: string; readonly state: EditorConversation }[]
/** Full unsaved documents, never included in app/state. */
export type EditorDocuments = ReadonlyMap<string, ReadonlyMap<string, FileDocumentState>>
export type EditorLiveDocuments = ReadonlyMap<string, ReadonlyMap<string, FileLiveDocumentState | null>>
export interface EditorLineTarget { readonly line: number; readonly request: number }
export type EditorLineTargets = ReadonlyMap<string, ReadonlyMap<string, EditorLineTarget>>
export interface OpenEditorTabOptions {
  readonly keep?: boolean
  readonly view?: FileViewMode
}

export const emptyEditorConversation = (): EditorConversation => ({
  tabs: [], active: null, preview: null, filter: null, expanded: [],
})
export const effectiveExplorerFilter = (filter: ExplorerFilter | null, hasChanges: boolean): ExplorerFilter =>
  filter ?? (hasChanges ? 'changed' : 'all')
export const editorConversation = (states: EditorState, subject: string): EditorConversation =>
  states.find(one => one.subject === subject)?.state ?? emptyEditorConversation()

/** Visiting or changing a conversation moves it to the front without dropping live tabs. */
export const updateEditorConversation = (states: EditorState, subject: string, state: EditorConversation): EditorState =>
  [{ subject, state }, ...states.filter(one => one.subject !== subject)]

export const effectiveWindowMode = (mode: WindowMode, workbench: Workbench): WindowMode => {
  const destination = workbench.navigation.current
  return mode === 'editor' && destination.kind === 'work'
    && destination.view.kind === 'conversation' && destination.view.session !== null ? 'editor' : 'conversation'
}

export const defaultFileView = (path: string): FileViewMode =>
  /\.(md|markdown|html?|pdf)$/i.test(path) ? 'preview' : 'source'

export const openEditorTab = (state: EditorConversation, path: string, options: OpenEditorTabOptions = {}): EditorConversation => {
  if (state.tabs.some(tab => tab.path === path)) {
    const selected = { ...state, active: path, tabs: options.view ? state.tabs.map(tab => tab.path === path ? { ...tab, view: options.view! } : tab) : state.tabs }
    return options.keep ? keepEditorTab(selected, path) : selected
  }
  const tab = { path, view: options.view ?? defaultFileView(path) }
  const previewIndex = state.tabs.findIndex(one => one.path === state.preview)
  // A deliberate kept open does not displace the existing preview.
  const tabs = !options.keep && previewIndex >= 0
    ? state.tabs.map((one, index) => index === previewIndex ? tab : one) : [...state.tabs, tab]
  return { ...state, tabs, active: path, preview: options.keep ? state.preview : path }
}

export const keepEditorTab = (state: EditorConversation, path: string): EditorConversation =>
  state.preview === path ? { ...state, preview: null } : state

export const closeEditorTab = (state: EditorConversation, path: string): EditorConversation => {
  const index = state.tabs.findIndex(tab => tab.path === path)
  if (index < 0) return state
  const tabs = state.tabs.filter(tab => tab.path !== path)
  return { ...state, tabs,
    active: state.active === path ? (tabs[index]?.path ?? tabs[index - 1]?.path ?? null) : state.active,
    preview: state.preview === path ? null : state.preview,
  }
}

export const setEditorTabView = (state: EditorConversation, path: string, view: FileViewMode): EditorConversation =>
  state.tabs.some(tab => tab.path === path && tab.view !== view)
    ? { ...state, tabs: state.tabs.map(tab => tab.path === path ? { ...tab, view } : tab) } : state

const record = (raw: unknown): Record<string, unknown> | null =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const text = (raw: unknown): raw is string => typeof raw === 'string' && raw.length > 0
const readConversation = (raw: unknown): EditorConversation => {
  const data = record(raw)
  if (!data) return emptyEditorConversation()
  const seen = new Set<string>()
  const tabs: EditorTab[] = []
  for (const rawTab of Array.isArray(data.tabs) ? data.tabs : []) {
    const tab = record(rawTab)
    if (!tab || !text(tab.path) || seen.has(tab.path)) continue
    seen.add(tab.path)
    tabs.push({ path: tab.path, view: tab.view === 'source' || tab.view === 'preview' || tab.view === 'changes'
      ? tab.view : defaultFileView(tab.path) })
  }
  return {
    tabs,
    active: text(data.active) && seen.has(data.active) ? data.active : tabs[0]?.path ?? null,
    preview: text(data.preview) && seen.has(data.preview) ? data.preview : null,
    filter: data.filter === 'all' || data.filter === 'changed' ? data.filter : null,
    expanded: [...new Set((Array.isArray(data.expanded) ? data.expanded : []).filter(text))],
  }
}

/** Validate and project only tab/Explorer metadata; document bytes and hashes never enter this shape. */
export const readEditorState = (raw: unknown): EditorState => {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const states: { subject: string; state: EditorConversation }[] = []
  for (const entry of raw) {
    const one = record(entry)
    if (!one || !text(one.subject) || seen.has(one.subject)) continue
    seen.add(one.subject)
    states.push({ subject: one.subject, state: readConversation(one.state) })
    if (states.length === 50) break
  }
  return states
}
export const persistEditorState = (states: EditorState): EditorState => readEditorState(states)
