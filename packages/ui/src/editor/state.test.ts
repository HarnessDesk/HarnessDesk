import { describe, expect, it } from 'vitest'
import * as editor from './index'
import { emptyWorkbench, navigationFor } from '../state/workbench'
import { show, focusedPane } from '../state/layout'
import { runtimeId, sessionId, sessionKey } from '@harnessdesk/protocol'

describe('editor tab state', () => {
  it('exposes the state model through the editor boundary', () => {
    expect(editor.emptyEditorConversation).toBeTypeOf('function')
  })
  it('leaves the Explorer filter unset until chosen, defaulting to Changed only when changes exist', () => {
    expect(editor.emptyEditorConversation().filter).toBeNull()
    expect(editor.effectiveExplorerFilter(null, true)).toBe('changed')
    expect(editor.effectiveExplorerFilter(null, false)).toBe('all')
    expect(editor.effectiveExplorerFilter('all', true)).toBe('all')
  })
  it('replaces a single preview in place and keeps the already-open file', () => {
    let state = editor.emptyEditorConversation()
    state = editor.openEditorTab(state, 'keep.ts', { keep: true })
    state = editor.openEditorTab(state, 'a.md')
    state = editor.openEditorTab(state, 'b.ts')
    expect(state.tabs).toEqual([{ path: 'keep.ts', view: 'source' }, { path: 'b.ts', view: 'source' }])
    expect(state.preview).toBe('b.ts')
    state = editor.openEditorTab(state, 'keep.ts')
    expect(state.active).toBe('keep.ts')
    expect(state.preview).toBe('b.ts')
    expect(state.tabs).toHaveLength(2)
  })
  it('keeps the preview on editing or double-click, retaining its chosen view', () => {
    let state = editor.openEditorTab(editor.emptyEditorConversation(), 'a.md')
    state = editor.setEditorTabView(state, 'a.md', 'changes')
    state = editor.keepEditorTab(state, 'a.md')
    expect(state.preview).toBeNull()
    state = editor.openEditorTab(state, 'b.ts')
    state = editor.openEditorTab(state, 'b.ts', { keep: true })
    state = editor.openEditorTab(state, 'c.ts')
    expect(state.tabs.map(tab => tab.path)).toEqual(['a.md', 'b.ts', 'c.ts'])
    expect(state.tabs[0]?.view).toBe('changes')
  })
  it('closing selects the right neighbour, then left, and leaves an inactive selection alone', () => {
    let state = editor.emptyEditorConversation()
    for (const path of ['a', 'b', 'c']) state = editor.openEditorTab(state, path, { keep: true })
    state = editor.openEditorTab(state, 'b')
    state = editor.closeEditorTab(state, 'b')
    expect(state.active).toBe('c')
    state = editor.closeEditorTab(state, 'a')
    expect(state.active).toBe('c')
    state = editor.closeEditorTab(state, 'c')
    expect(state.active).toBeNull()
    expect(state.preview).toBeNull()
  })
  it('restores independent subjects and persists only the newest 50 without document data', () => {
    let states: editor.EditorState = []
    for (let n = 0; n < 51; n++) states = editor.updateEditorConversation(states, `session:${n}`, {
      ...editor.openEditorTab(editor.emptyEditorConversation(), `${n}.md`, { keep: true }),
      filter: 'all', expanded: [`folder-${n}`],
    })
    const persisted = editor.persistEditorState(states)
    expect(persisted).toHaveLength(50)
    expect(persisted[0]?.subject).toBe('session:50')
    expect(editor.editorConversation(states, 'session:0').active).toBe('0.md')
    const restored = editor.readEditorState(JSON.parse(JSON.stringify(persisted)))
    expect(editor.editorConversation(restored, 'session:20')).toEqual(editor.editorConversation(states, 'session:20'))
    expect(editor.editorConversation(restored, 'session:0').tabs).toEqual([])
  })
  it('validates restored selections, duplicates and unknown fields without admitting drafts', () => {
    const restored = editor.readEditorState([{ subject: 'session:a', state: {
      tabs: [{ path: 'a.md', view: 'changes', content: 'private' }, { path: 'a.md', view: 'source' }, { path: 2 }],
      active: 'gone', preview: 'gone', filter: 'invalid', expanded: ['folder', 2, 'folder'], document: 'private',
    } }, { subject: 'session:a', state: {} }, { subject: 1, state: {} }])
    expect(restored).toEqual([{ subject: 'session:a', state: {
      tabs: [{ path: 'a.md', view: 'changes' }], active: 'a.md', preview: null, filter: null, expanded: ['folder'],
    } }])
    expect(editor.readEditorState(null)).toEqual([])
  })
})

it('uses the stored mode only for an existing conversation destination', () => {
  const bench = emptyWorkbench()
  expect(editor.effectiveWindowMode('editor', bench)).toBe('conversation')
  const key = sessionKey(runtimeId('test'), sessionId('one'))
  const main = show(bench.main, focusedPane(bench.main).id, { kind: 'conversation', session: key })
  const work = { ...bench, main, navigation: navigationFor(main) }
  expect(editor.effectiveWindowMode('editor', work)).toBe('editor')
  expect(editor.effectiveWindowMode('conversation', work)).toBe('conversation')
  expect(editor.effectiveWindowMode('editor', { ...work, navigation: { ...work.navigation, current: { kind: 'agents', id: null } } })).toBe('conversation')
  expect(editor.effectiveWindowMode('editor', { ...work, navigation: { ...work.navigation, current: { kind: 'work', view: { kind: 'room', room: 'demo' } } } })).toBe('conversation')
})
