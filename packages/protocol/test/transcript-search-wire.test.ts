import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, ValidationError } from '../src/index.js'

test('tool-output search is an optional boolean, never a truthy wire value', () => {
  const request = (params: unknown) => parseClientMessage({ id: 1, method: 'transcripts/search', params })
  assert.deepEqual(request({ query: 'words' }).params, { query: 'words', includeTools: undefined })
  assert.deepEqual(request({ query: 'words', includeTools: true }).params, { query: 'words', includeTools: true })
  assert.deepEqual(request({ query: 'words', includeTools: false }).params, { query: 'words', includeTools: false })
  assert.equal((request({ query: 'words', includeTools: null }).params as { includeTools?: boolean }).includeTools, undefined)
  for (const includeTools of ['true', 1]) assert.throws(() => request({ query: 'words', includeTools }), ValidationError)
})
