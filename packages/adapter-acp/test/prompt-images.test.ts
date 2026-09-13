import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { promptBlocksOf } from '../src/runtime.js'

let tempDir: string
let samplePngPath: string

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'acp-prompt-images-test-'))
  samplePngPath = join(tempDir, 'sample.png')
  writeFileSync(samplePngPath, Buffer.from(TINY_PNG_BASE64, 'base64'))
})

after(() => {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

test('promptBlocksOf preserves text, mention, and skill content blocks', () => {
  const blocks = promptBlocksOf([
    { type: 'text', text: 'hello' },
    { type: 'mention', name: 'README.md', path: '/workspace/README.md' },
    { type: 'skill', name: 'deploy', path: '/skills/deploy' },
  ])

  assert.deepEqual(blocks, [
    { type: 'text', text: 'hello' },
    { type: 'resource_link', uri: 'file:///workspace/README.md', name: 'README.md' },
    { type: 'resource_link', uri: 'file:///skills/deploy', name: 'deploy' },
  ])
})

test('promptBlocksOf converts data: image URLs to ACP image blocks', () => {
  const blocks = promptBlocksOf([
    { type: 'image', url: `data:image/png;base64,${TINY_PNG_BASE64}`, name: 'sample.png' },
  ])

  assert.deepEqual(blocks, [
    { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' },
  ])
})

test('promptBlocksOf reads localImage files from disk as ACP image blocks (#415)', () => {
  const blocks = promptBlocksOf([
    { type: 'localImage', path: samplePngPath },
  ])

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'image')
  if (blocks[0]?.type === 'image') {
    assert.equal(blocks[0].data, TINY_PNG_BASE64)
    assert.equal(blocks[0].mimeType, 'image/png')
  }
})

test('promptBlocksOf falls back to resource_link when localImage file is missing (#415)', () => {
  const missingPath = join(tempDir, 'missing.png')
  const blocks = promptBlocksOf([
    { type: 'localImage', path: missingPath },
  ])

  assert.deepEqual(blocks, [
    { type: 'resource_link', uri: `file://${missingPath}`, name: 'missing.png' },
  ])
})

test('promptBlocksOf translates remote http/https image URLs to resource_link blocks (#415)', () => {
  const blocks = promptBlocksOf([
    { type: 'image', url: 'https://example.com/test.png', name: 'test.png' },
    { type: 'image', url: 'http://example.com/photo.jpeg' },
  ])

  assert.deepEqual(blocks, [
    { type: 'resource_link', uri: 'https://example.com/test.png', name: 'test.png' },
    { type: 'resource_link', uri: 'http://example.com/photo.jpeg', name: 'photo.jpeg' },
  ])
})

test('promptBlocksOf reads local image paths or file URLs as ACP image blocks (#415)', () => {
  const blocks = promptBlocksOf([
    { type: 'image', url: samplePngPath, name: 'sample.png' },
    { type: 'image', url: `file://${samplePngPath}`, name: 'sample.png' },
  ])

  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' })
  assert.deepEqual(blocks[1], { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' })
})
