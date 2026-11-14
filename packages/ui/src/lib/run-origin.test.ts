import { describe, expect, it } from 'vitest'

import { runOrigin } from './run-origin'

describe('runOrigin', () => {
  const intake = { key: 'k', trigger: 'review-pr', closureDigest: 'd', dispatchHeld: false, again: null }
  it('names the trigger, then an MCP client, then the person, and nothing else', () => {
    expect(runOrigin({ intake }, 'trigger')).toBe('From trigger review-pr')
    expect(runOrigin({ startedBy: { via: 'mcp', client: 'example-client@1.0.0' } }, 'person')).toBe('From an MCP client · example-client')
    expect(runOrigin({ startedBy: { via: 'cli', client: 'harnessdesk@0.1.0' } }, 'person')).toBe('Started by you')
    expect(runOrigin({}, 'person')).toBe('Started by you')
    expect(runOrigin({ startedBy: null }, undefined)).toBeNull()
  })
  it('keeps a stated name to plain text, and a scoped name whole', () => {
    expect(runOrigin({ startedBy: { via: 'mcp', client: '\u001b[31mexample-client\u001b[0m@2.0' } }, 'person')).toBe('From an MCP client · example-client')
    expect(runOrigin({ startedBy: { via: 'mcp', client: '<b>example-client</b>@2.0' } }, 'person')).toBe('From an MCP client · <b>example-client</b>')
    expect(runOrigin({ startedBy: { via: 'mcp', client: '@acme/agent@1.2.3' } }, 'person')).toBe('From an MCP client · @acme/agent')
    expect(runOrigin({ startedBy: { via: 'mcp', client: '@acme/agent' } }, 'person')).toBe('From an MCP client · @acme/agent')
    expect(runOrigin({ startedBy: { via: 'mcp', client: '' } }, 'person')).toBe('From an MCP client')
  })
})
