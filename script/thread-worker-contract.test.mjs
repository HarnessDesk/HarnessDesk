import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('thread worker docs separate login and reload from unmeasured credential propagation', () => {
  const doc = readFileSync(new URL('../docs/decisions.md', import.meta.url), 'utf8')
  const section = doc.split('## Finished conversations recycle their own processes')[1]?.split('\n## ')[0]
  assert.ok(section, 'the conversation-process decision is documented')
  assert.match(section, /MCP login opens one interactive authorization flow on the control process only\./)
  assert.match(section, /Reload in Extensions sends the existing\s+reload verb to conversation processes\./)
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
