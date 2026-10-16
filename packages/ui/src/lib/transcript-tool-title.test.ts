import { expect, it } from 'vitest'
import type { ToolCallItem } from '@harnessdesk/protocol'
import { transcriptToolTitle } from './transcript-tool-title'

it('uses the same presentation for the host’s dynamic and MCP board tools', () => {
  for (const item of [
    { tool: 'mcp__harnessdesk__claim_work', source: { kind: 'mcp', server: 'harnessdesk' } },
    { tool: 'claim_work', source: { kind: 'dynamic', namespace: 'hd_team' } },
  ]) expect(transcriptToolTitle(item as ToolCallItem)).toBe('Pick up a task')
})

it('preserves other servers’ tools even when their names match', () => {
  expect(transcriptToolTitle({ tool: 'claim_work', source: { kind: 'mcp', server: 'another' } } as ToolCallItem)).toBeNull()
})
