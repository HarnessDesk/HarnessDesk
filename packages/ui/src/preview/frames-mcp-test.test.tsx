import { expect, it, vi } from 'vitest'
import { mcpTestStore } from './frames-mcp-test'

vi.mock('./main', () => ({ Frame: ({ children }: { children: React.ReactNode }) => children }))

it.each(['pass', 'fail', 'needsSignIn'] as const)('the MCP browser fixture scripts %s through its wire and records the sent identity', async outcome => {
  const fixture = mcpTestStore(outcome)
  const params = { name: 'workspace-tools', path: '/home/jane/.claude.json' }
  const result = await fixture.store.transport.request('library/mcp/test', params)
  expect(result.ok).toBe(outcome === 'pass')
  if (outcome !== 'pass') expect(result).toMatchObject({ reason: outcome === 'fail' ? 'spawnFailed' : 'needsSignIn' })
  expect(fixture.calls).toEqual([params])
  await fixture.store.mcpLogin(params.name, fixture.runtime.id)
  expect(fixture.logins).toEqual([{ name: params.name, runtime: fixture.runtime.id }])
})
