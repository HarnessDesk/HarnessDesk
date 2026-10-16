import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError, type HostParams } from '../src/index.js'

test('library/apply preserves optional bundle guards and rejects malformed digests', () => {
  const op = { id: 'op-1', kind: 'skill', name: 'demo', action: 'create', targetPath: '/work/.agents/skills/demo', content: 'demo', guardDigest: null, backup: false }
  const request = (fields: object) => parseClientMessage({ id: 1, method: 'library/apply', params: { ops: [{ ...op, ...fields }] } })
  const fields = { guardBundle: null, sourceBundle: 'd'.repeat(64) }
  const parsed = request(fields)
  assert.equal(parsed.method, 'library/apply')
  const result = (parsed.params as HostParams<'library/apply'>).ops[0]!
  assert.equal(result.guardBundle, null)
  assert.equal(result.sourceBundle, fields.sourceBundle)
  assert.doesNotThrow(() => request({ guardBundle: 'a'.repeat(64) }))
  assert.doesNotThrow(() => request({})) // Apply tells old plans to plan again.
  assert.throws(() => request({ guardBundle: 1 }), ValidationError)
  assert.throws(() => request({ sourceBundle: null }), ValidationError)
})

test('library/source/fetch validates its strings and origin survives plan and apply', () => {
  const origin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: 'a'.repeat(40), path: 'demo', bundle: 'b'.repeat(64) }
  const fetch = (params: unknown) => parseClientMessage({ id: 2, method: 'library/source/fetch', params })
  assert.doesNotThrow(() => fetch({ url: origin.url }))
  assert.doesNotThrow(() => fetch({ url: origin.url, ref: 'main', path: 'demo' }))
  for (const params of [{}, { url: 1 }, { url: origin.url, ref: 1 }, { url: origin.url, path: null }]) assert.throws(() => fetch(params), ValidationError)
  const intent = { kind: 'installSkill', name: 'demo', sourcePath: '/library/sources/demo', targetRuntime: 'codex', origin }
  const planned = parseClientMessage({ id: 3, method: 'library/plan', params: { intents: [intent] } })
  assert.deepEqual((planned.params as HostParams<'library/plan'>).intents[0], intent)
  const op = { id: 'op-1', kind: 'skill', name: 'demo', action: 'create', targetPath: '/work/.agents/skills/demo', guardDigest: null, backup: false, origin }
  const applied = parseClientMessage({ id: 4, method: 'library/apply', params: { ops: [op] } })
  assert.deepEqual((applied.params as HostParams<'library/apply'>).ops[0]?.origin, origin)
  for (const field of Object.keys(origin)) {
    const bad = { ...origin, [field]: 1 }
    assert.throws(() => parseClientMessage({ id: 3, method: 'library/plan', params: { intents: [{ ...intent, origin: bad }] } }), ValidationError)
    assert.throws(() => parseClientMessage({ id: 4, method: 'library/apply', params: { ops: [{ ...op, origin: bad }] } }), ValidationError)
  }
})

test('library/apply bounds file details and validates acknowledgement', () => {
  const op = { id: 'op-1', kind: 'skill', name: 'demo', action: 'create', targetPath: '/work/.agents/skills/demo', guardDigest: null, backup: false }
  const file = { path: 'scripts/run.sh', bytes: 12, runnable: true, binary: false, reason: 'script (.sh)' }
  const request = (fields: object) => parseClientMessage({ id: 1, method: 'library/apply', params: { ops: [{ ...op, ...fields }] } })
  const fields = { files: [file, { ...file, reason: null }], acknowledged: true }
  const parsed = request(fields)
  const result = (parsed.params as HostParams<'library/apply'>).ops[0]!
  assert.deepEqual(result.files, fields.files)
  assert.equal(result.acknowledged, true)
  assert.doesNotThrow(() => request({ files: Array(200).fill(file), acknowledged: false }))
  for (const fields of [{ acknowledged: 'yes' }, { acknowledged: null }, { files: Array(201).fill(file) }, { files: null }]) {
    assert.throws(() => request(fields), ValidationError)
  }
  for (const bad of [{ path: 'x'.repeat(4097) }, { bytes: -1 }, { bytes: 1.5 }, { runnable: 1 }, { binary: 'no' }, { reason: 'x'.repeat(257) }]) {
    assert.throws(() => request({ files: [{ ...file, ...bad }] }), ValidationError)
  }
})

test('library/source/file validates bounded source and relative path strings', () => {
  const read = (params: unknown) => parseClientMessage({ id: 5, method: 'library/source/file', params })
  const params = { sourcePath: '/library/sources/demo', path: 'references/note.md' }
  assert.deepEqual(read(params).params, params)
  for (const bad of [{}, { ...params, path: 1 }, { ...params, sourcePath: null }, { ...params, path: 'x'.repeat(4097) }, { ...params, sourcePath: 'x'.repeat(4097) }]) {
    assert.throws(() => read(bad), ValidationError)
  }
})

test('library/sources/check bounds names and update intents and per-file changes survive the wire', () => {
  const check = (params: unknown) => parseClientMessage({ id: 1, method: 'library/sources/check', params })
  assert.equal((check({}).params as HostParams<'library/sources/check'>).names, undefined)
  assert.deepEqual(check({ names: ['demo'] }).params, { names: ['demo'] })
  assert.doesNotThrow(() => check({ names: Array(200).fill('demo') }))
  for (const params of [{ names: null }, { names: 'demo' }, { names: [1] }, { names: ['x'.repeat(201)] }, { names: Array(201).fill('demo') }]) assert.throws(() => check(params), ValidationError)
  const origin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: 'a'.repeat(40), path: 'demo', bundle: 'b'.repeat(64) }
  const intent = { kind: 'updateSkill', name: 'demo', targetRuntime: 'codex', origin }
  assert.deepEqual((parseClientMessage({ id: 2, method: 'library/plan', params: { intents: [intent] } }).params as HostParams<'library/plan'>).intents, [intent])
  assert.throws(() => parseClientMessage({ id: 2, method: 'library/plan', params: { intents: [{ ...intent, origin: undefined }] } }), ValidationError)
  const op = { id: 'op-1', kind: 'skill', name: 'demo', action: 'update', targetPath: '/work/.codex/skills/demo', guardDigest: null, backup: false, replaceBundle: true, files: [{ path: 'old.md', bytes: 3, runnable: false, binary: false, reason: null, change: 'removed' }] }
  assert.deepEqual(JSON.parse(JSON.stringify((parseClientMessage({ id: 3, method: 'library/apply', params: { ops: [op] } }).params as HostParams<'library/apply'>).ops[0])), op)
  assert.doesNotThrow(() => parseClientMessage({ id: 3, method: 'library/apply', params: { ops: [{ ...op, files: Array(400).fill(op.files[0]) }] } }))
  assert.throws(() => parseClientMessage({ id: 3, method: 'library/apply', params: { ops: [{ ...op, files: Array(401).fill(op.files[0]) }] } }), ValidationError)
  assert.throws(() => parseClientMessage({ id: 3, method: 'library/apply', params: { ops: [{ ...op, files: [{ ...op.files[0], change: 'other' }] }] } }), ValidationError)
  assert.throws(() => parseClientMessage({ id: 3, method: 'library/apply', params: { ops: [{ ...op, files: Array(201).fill({ ...op.files[0], change: null }) }] } }), ValidationError)
})
