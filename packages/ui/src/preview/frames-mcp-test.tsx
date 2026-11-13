import { useEffect, useMemo, useRef } from 'react'
import type { Library, LibraryEntry, McpTestResult } from '@harnessdesk/protocol'

import { App } from '../app/App'
import { McpConnectionTest } from '../components/McpConnectionTest'
import { SkillList, SkillRow } from '../components/SkillRow'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { LIBRARY, previewStore } from './harness'
import { Frame } from './main'

const answer: McpTestResult = { ok: false, reason: 'needsSignIn', detail: 'It asks for sign-in.', ms: 120 }

/** Real Library and wire-shaped fakes only; never a real account or server. */
export function mcpTestStore() {
  const store = frameDestinationStore(previewStore())
  const runtime = store.getSnapshot().runtimes.find(runtime => runtime.capabilities.mcp)!
  const entry: LibraryEntry = {
    kind: 'mcp', name: 'workspace-tools', title: 'Workspace tools', description: 'Tools for the demo workspace.',
    copies: [{ path: '/home/jane/.claude.json', scope: 'user', readBy: [runtime.id], digest: 'demo', hollow: false, readOnly: false }],
    reach: [{ runtime: runtime.id, state: 'reaches', basis: 'scanned' }],
  }
  const library: Library = { ...LIBRARY, home: '/home/jane', entries: [entry] }
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'library/read') return library
    if (method === 'library/definition') return { kind: 'mcp', name: entry.name, path: entry.copies[0]!.path,
      text: '{"command":"node","args":["demo-tools.js"]}', truncated: false, files: [], moreFiles: 0 }
    if (method === 'library/mcp/test') return { ok: true, tools: 12, serverName: entry.name, ms: 40 }
    if (method === 'runtime/mcp/login') return undefined
    return request(method, params)
  }) as typeof store.transport.request
  store.mcpLogin = async () => {}
  store.openDestination({ kind: 'library', section: 'mcp' })
  return { store, entry, runtime }
}

/** Browser specs open an entry from this real list, then stub only its wire. */
export const McpTestPreview = () => {
  const { store } = useMemo(mcpTestStore, [])
  return <StoreProvider store={store}><App /></StoreProvider>
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
  const test = <McpConnectionTest compact={list} name={fixture.entry.name} path={fixture.entry.copies[0]!.path}
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
