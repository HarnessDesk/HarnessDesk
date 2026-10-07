import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('thread worker docs separate login and reload from unmeasured credential propagation', () => {
  const doc = readFileSync(new URL('../docs/decisions.md', import.meta.url), 'utf8')
  const section = doc.split('## Finished conversations recycle their own processes')[1]?.split('\n## ')[0]
  assert.ok(section, 'the conversation-process decision is documented')
  assert.match(section, /MCP login opens one interactive authorization flow on the control process only\./)
  assert.match(section, /Reload in Extensions sends the existing\s+reload verb to unfiltered conversation processes\./)
  assert.match(section, /Whether a running real agent process\s+re-reads a newly stored credential on reload remains unmeasured\./)
  assert.doesNotMatch(section, /Reload in Extensions applies them to\s+the open conversation processes through the existing reload fan-out\./)
})

test('tool updates guard stopping and native selection after openings settle without a redundant root guard', () => {
  const source = readFileSync(new URL('../packages/adapter-codex/src/thread-servers.ts', import.meta.url), 'utf8')
  // This is a structural cleanup: a rootless opening sets stopping before
  // releasing its waiters, so removing the root predicate cannot change behavior.
  assert.ok(/await worker\.openingDone\s+if \(!worker\.stopping && !\(method === 'config\/mcpServer\/reload' && worker\.nativeServerSelection\)\)/.test(source),
    'the post-opening update skips stopping workers and frozen native selections')
})

test('native selection docs explain the explicit empty rule in the field table', () => {
  const doc = readFileSync(new URL('../docs/agents.md', import.meta.url), 'utf8')
  const table = doc.split('| Key | What it says |')[1]?.split('\n\n')[0]
  assert.match(table ?? '', /\| `runtime-servers` \|.*Omitted.*defaults.*`\[\]`.*none.*blank.*refused/i)
  assert.ok(doc.indexOf('### Native server selection') < doc.indexOf('## Three places, one roster'), 'selection belongs beside the other server contracts')
})

test('runtime process documentation and method comments remain attached to their subjects', () => {
  const doc = readFileSync(new URL('../docs/interface.md', import.meta.url), 'utf8')
  assert.ok(!/section appears on a runtime's detail page[^]*?\n\nIt is every registered runtime/.test(doc), 'the runtime roster has an explicit subject')
})

test('refreshCatalog keeps its own doc comment', () => {
  const source = readFileSync(new URL('../packages/ui/src/state/store.ts', import.meta.url), 'utf8')
  assert.ok(/Re-asks the active runtime[^]*?\*\/\s+async refreshCatalog\(/.test(source), 'the refresh documentation describes the next method')
})

test('native selection probe has a runnable README entry', () => {
  const readme = readFileSync(new URL('../script/probe/README.md', import.meta.url), 'utf8')
  assert.match(readme, /## `mcp-selection\.mjs`/)
})

test('native selection documents recovery when a frozen server leaves the configuration', () => {
  const doc = readFileSync(new URL('../docs/agents.md', import.meta.url), 'utf8')
  const section = doc.split('### Native server selection')[1]?.split('\n## ')[0] ?? ''
  assert.match(section, /removed or renamed[\s\S]*reopen[\s\S]*restore the server or start a new Seat/i)
})
