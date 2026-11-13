import { useEffect, useMemo, useRef } from 'react'
import type { HostParams, Library, LibraryEntry, McpTestResult, RuntimeId } from '@harnessdesk/protocol'

import { App } from '../app/App'
import { McpConnectionTest } from '../components/McpConnectionTest'
import { SkillList, SkillRow } from '../components/SkillRow'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { LIBRARY, previewStore } from './harness'
import { Frame } from './main'

const answer: McpTestResult = { ok: false, reason: 'needsSignIn', detail: 'It asks for sign-in.', ms: 120 }

/** Real Library and wire-shaped fakes only; never a real account or server. */
type McpTestOutcome = 'pass' | 'fail' | 'needsSignIn'
type McpTestObservation = { calls: HostParams<'library/mcp/test'>[]; logins: { name: string; runtime: RuntimeId | null }[] }
declare global { interface Window { __mcpTest?: McpTestObservation } }

export function mcpTestStore(outcome: McpTestOutcome = 'pass') {
  const seed = previewStore().getSnapshot()
  const primary = seed.runtimes[0]!
  const runtime = { ...primary, capabilities: { ...primary.capabilities, mcp: true } }
  const store = frameDestinationStore(previewStore({ runtimes: [runtime, ...seed.runtimes.slice(1)] }))
  const entry: LibraryEntry = {
    kind: 'mcp', name: 'workspace-tools', title: 'Workspace tools', description: 'Tools for the demo workspace.',
    copies: [
      { path: '/home/jane/.cursor/mcp.json', scope: 'user', readBy: [], digest: null, hollow: true, readOnly: false },
      { path: '/home/jane/.claude.json', scope: 'user', readBy: [runtime.id], digest: 'demo', hollow: false, readOnly: false },
    ],
    reach: [{ runtime: runtime.id, state: 'reaches', basis: 'scanned' }],
  }
  const copy = entry.copies.find(copy => !copy.hollow)!
  const calls: McpTestObservation['calls'] = []
  const logins: McpTestObservation['logins'] = []
  const library: Library = { ...LIBRARY, home: '/home/jane', entries: [entry] }
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'library/read') return library
    if (method === 'library/definition') return { kind: 'mcp', name: entry.name, path: copy.path,
      text: '{"command":"node","args":["demo-tools.js"]}', truncated: false, files: [], moreFiles: 0 }
    if (method === 'library/mcp/test') {
      calls.push({ ...params as HostParams<'library/mcp/test'> })
      return outcome === 'pass' ? { ok: true, tools: 12, ms: 40 }
        : outcome === 'fail' ? { ok: false, reason: 'spawnFailed', detail: 'The demo server did not start.', ms: 8 }
        : { ok: false, reason: 'needsSignIn', detail: 'It asks for sign-in.', ms: 8 }
    }
    if (method === 'runtime/mcp/login') return undefined
    return request(method, params)
  }) as typeof store.transport.request
  store.mcpLogin = async (name, runtime = store.getSnapshot().activeRuntime) => { logins.push({ name, runtime }) }
  store.openDestination({ kind: 'library', section: 'mcp' })
  return { store, entry, copy, runtime, calls, logins }
}

/** The query selects a fake wire outcome; the hook observes identities without rewriting served code. */
export const McpTestPreview = () => {
  const fixture = useMemo(() => {
    const outcome = new URLSearchParams(location.search).get('mcp-test-outcome')
    return mcpTestStore(outcome === 'fail' || outcome === 'needsSignIn' ? outcome : 'pass')
  }, [])
  // Published from an effect: development's double render may build a second fixture and keep only one.
  useEffect(() => { window.__mcpTest = { calls: fixture.calls, logins: fixture.logins } }, [fixture])
  return <StoreProvider store={fixture.store}><App /></StoreProvider>
}

const ResultFrame = ({ list = false, canSignIn = true }: { list?: boolean; canSignIn?: boolean }) => {
  const fixture = useMemo(() => {
    const fixture = mcpTestStore()
    const request = fixture.store.transport.request.bind(fixture.store.transport)
    fixture.store.transport.request = (async (method, params) => method === 'library/mcp/test'
      ? list ? { ok: true, tools: 12, ms: 40 } : answer
      : request(method, params)) as typeof fixture.store.transport.request
    return fixture
  }, [list])
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Seed a rendered result by exercising the actual control against its fake wire.
    const element = host.current
    if (!element) return
    const seed = () => {
      const button = element.querySelector<HTMLButtonElement>('[data-mcp-test] button')
      if (!button) return false
      button.click()
      return true
    }
    // SkillList waits for its first width measurement before mounting its rows.
    if (seed()) return
    const observer = new MutationObserver(() => { if (seed()) observer.disconnect() })
    observer.observe(element, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const test = <McpConnectionTest compact={list} name={fixture.entry.name} path={fixture.copy.path}
    cwd={undefined} readBy={canSignIn ? [fixture.runtime.id] : []} home="/home/jane" />
  return <StoreProvider store={fixture.store}><div ref={host} className="p-4">
    {list ? <SkillList kind="mcp"><SkillRow entry={fixture.entry} columns={[{ id: fixture.runtime.id, label: fixture.runtime.presentation.name }]}
      onOpen={() => {}} actions={test} /></SkillList> : test}
  </div></StoreProvider>
}

export const McpTestFrames = () => <>
  <Frame id="mcp-test-list-result" title="MCP test — a result in the list"><ResultFrame list /></Frame>
  <Frame id="mcp-test-needs-sign-in" title="MCP test — sign in through its agent"><ResultFrame /></Frame>
  <Frame id="mcp-test-agent-sign-in" title="MCP test — its agent owns sign-in"><ResultFrame canSignIn={false} /></Frame>
</>
