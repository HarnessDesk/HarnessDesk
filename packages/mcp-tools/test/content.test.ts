import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolIndex, toMcpContent, type GatewayTool } from '../src/content.js'

test('an image part is its bytes, typed by what the bytes say they are (review of #187, round 2)', () => {
  const { content } = toMcpContent({ ok: true, content: [{ type: 'image', url: 'data:image/png;base64,AAAA', mimeType: 'application/pdf' }] })
  assert.deepEqual(content, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])
})

test('a linked image is named as a link, because image content carries bytes (review of #187, round 2)', () => {
  // As image content, the URL itself went out as base64, which no model decodes (#51).
  const { content } = toMcpContent({ ok: true, content: [{ type: 'image', url: 'https://example.test/chart.png', mimeType: 'image/png' }] })
  assert.deepEqual(content, [{ type: 'text', text: 'An image at https://example.test/chart.png' }])
})

test('a failure is an error, and a result with nothing in it is one empty text', () => {
  assert.deepEqual(toMcpContent({ ok: false, error: 'No.' }), { content: [{ type: 'text', text: 'No.' }], isError: true })
  assert.deepEqual(toMcpContent({ ok: true, content: [] }), { content: [{ type: 'text', text: '' }] })
})

test('toolIndex keeps single tool names as-is and disambiguates two colliding tools with namespace prefix', () => {
  const tools: GatewayTool[] = [
    { namespace: 'pkg-a#1', name: 'search', description: 'desc1', inputSchema: {} },
    { namespace: 'pkg-b#2', name: 'search', description: 'desc2', inputSchema: {} },
    { namespace: 'pkg-c#1', name: 'lookup', description: 'desc3', inputSchema: {} },
  ]
  const index = buildToolIndex(tools)
  assert.deepEqual([...index.keys()], ['search', 'pkg-b_search', 'lookup'])
})

test('toolIndex disambiguates three or more tools sharing a name without dropping any', () => {
  const tools: GatewayTool[] = [
    { namespace: 'pkg#1', name: 'query', description: 'first', inputSchema: {} },
    { namespace: 'pkg#2', name: 'query', description: 'second', inputSchema: {} },
    { namespace: 'pkg#3', name: 'query', description: 'third', inputSchema: {} },
    { namespace: 'pkg#4', name: 'query', description: 'fourth', inputSchema: {} },
  ]
  const index = buildToolIndex(tools)
  assert.equal(index.size, 4, 'all 4 tools must be present in the index')
  assert.deepEqual([...index.keys()], ['query', 'pkg_query', 'pkg_query_2', 'pkg_query_3'])
  assert.equal(index.get('query')?.description, 'first')
  assert.equal(index.get('pkg_query')?.description, 'second')
  assert.equal(index.get('pkg_query_2')?.description, 'third')
  assert.equal(index.get('pkg_query_3')?.description, 'fourth')
})

