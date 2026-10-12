import { expect, test } from 'vitest'
import { previewStore } from '../preview/harness'
import { activeView, dockViews } from './workbench'

test('returning to a cached default tool makes its matching payload active', () => {
  const store = previewStore()
  store.openDetailsTab('activity')
  store.openDetailsTab('changes')
  store.chooseWorkTool('activity')
  expect(activeView(store.getSnapshot().workbench.right)?.view.kind).toBe('activity')
})

test('preview browser reuse keeps its tabs and navigates the driven tab', () => {
  const store = previewStore()
  store.openBrowser('https://example.com/first')
  store.openBrowser('https://example.com/second')
  const browsers = dockViews(store.getSnapshot().workbench.right).filter(one => one.view.kind === 'browser')
  expect(browsers).toHaveLength(1)
  const view = browsers[0]!.view
  if (view.kind !== 'browser') throw new Error('expected browser')
  expect(view.tabs.find(tab => tab.id === view.driven)?.url).toBe('https://example.com/second')
})


test('preview consumes only the matching Team request and never reuses a consumed serial', () => {
  const store = previewStore()
  store.openTeamBoard('fixture-team')
  const first = store.getSnapshot().teamFrameRequests['fixture-team']!
  store.requestTeamFrame('fixture-team', 'run')
  const newer = store.getSnapshot().teamFrameRequests['fixture-team']!
  expect(store.consumeTeamFrame('fixture-team', first.serial)).toBe(false)
  expect(store.getSnapshot().teamFrameRequests['fixture-team']).toEqual(newer)
  expect(store.consumeTeamFrame('fixture-team', newer.serial)).toBe(true)
  expect(store.getSnapshot().teamFrameRequests['fixture-team']).toBeUndefined()
  store.openTeamBoard('fixture-team')
  expect(store.getSnapshot().teamFrameRequests['fixture-team']!.serial).toBeGreaterThan(newer.serial)
  expect(store.consumeTeamFrame('fixture-team', newer.serial)).toBe(false)
})

import { normalizeFixedWorkbench, emptyWorkbench, dock } from './workbench'
import { runtimeId } from '@harnessdesk/protocol'
import { admitFixedTool } from './frame-tools'
test('preview refuses undeclared plugin cache reveal and cached mode selection', () => {
  const view = { kind: 'plugin' as const, contribution: 'hidden', label: 'Legacy', mounts: ['sidebar'] as const }
  const workbench = normalizeFixedWorkbench(dock(emptyWorkbench(), 'sidebar', view)).workbench
  const store = previewStore({ workbench, layout: workbench.main })
  const held = dockViews(workbench.right)[0]!
  store.revealView(held.id)
  store.chooseWorkTool('details', 'plugin')
  expect(store.getSnapshot().workbench).toBe(workbench)
  expect(store.getSnapshot().notices.at(-1)?.message).toContain('does not support the fixed right panel')
})

test('preview refuses a retained resource whose recorded subject is unavailable', () => {
  const first = admitFixedTool(emptyWorkbench(), { kind: 'file', runtime: runtimeId('fixture'), path: '/repo/a.ts' })!
  const workbench = { ...first, frameSubjects: {} }
  const store = previewStore({ workbench, layout: workbench.main })
  const held = dockViews(workbench.right)[0]!
  store.revealView(held.id)
  expect(store.getSnapshot().workbench).toBe(workbench)
  expect(store.getSnapshot().workbench.toolOwners[held.id]).toBe(first.toolOwners[held.id])
  expect(store.getSnapshot().notices.at(-1)?.message).toContain('no longer available')
})


test('preview explicitly admits a compatible revision of its retained unsupported plugin without changing ownership', () => {
  const legacy = { kind: 'plugin' as const, contribution: 'fixture-revised', label: 'Legacy panel', mounts: ['sidebar'] as const }
  const workbench = normalizeFixedWorkbench(dock(emptyWorkbench(), 'sidebar', legacy)).workbench
  const held = dockViews(workbench.right)[0]!
  const store = previewStore({ workbench, layout: workbench.main, contributions: [{
    kind: 'ui', id: legacy.contribution, owner: 'fixture', slot: 'session.header', label: 'Revised panel',
    component: 'hd.panel', mounts: ['right'],
  }] as never })
  const compatible = { ...legacy, label: 'Revised panel', mounts: ['right'] as const }
  store.showViewIn('right', compatible)
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual([{ id: held.id, view: compatible }])
  expect(store.getSnapshot().workbench.toolOwners[held.id]).toBe(workbench.toolOwners[held.id])
})


test('preview honors the available current manifest at every saved plugin cache opener', () => {
  const view = { kind: 'plugin' as const, contribution: 'fixture-manifest', label: 'Saved panel', mounts: ['right'] as const }
  const workbench = admitFixedTool(emptyWorkbench(), view)!
  const held = dockViews(workbench.right)[0]!
  const store = previewStore({ workbench, layout: workbench.main, contributions: [{
    kind: 'ui', id: view.contribution, owner: 'fixture', slot: 'session.header', label: view.label,
    component: 'hd.panel', mounts: ['sidebar'],
  }] as never })
  for (const reveal of [() => store.showViewIn('right', view), () => store.revealView(held.id),
    () => store.chooseWorkTool('details', 'plugin')]) {
    reveal()
    expect(store.getSnapshot().workbench).toBe(workbench)
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('does not support the fixed right panel')
  }
})


test('preview reuses the default browser across Teams and reveals its original owner without replacing another intent', () => {
  const store = previewStore()
  store.openTeamRoom('fixture-a')
  store.openBrowser()
  const first = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  store.openTeamRoom('fixture-b')
  store.openDetailsTab('activity')
  const otherIntent = store.getSnapshot().workbench.frameTools['team:fixture-b']
  store.openBrowser()
  const workbench = store.getSnapshot().workbench
  expect(dockViews(workbench.right).filter(one => one.view.kind === 'browser')).toEqual([first])
  expect(store.workSubject()).toBe('team:fixture-a')
  expect(workbench.toolOwners[first.id]).toBe('team:fixture-a')
  expect(workbench.frameTools['team:fixture-b']).toEqual(otherIntent)
})
