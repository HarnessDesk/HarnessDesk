import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { prepareConfig } from '../src/bridge.js'

/**
 * The user's editor config is mirrored into the bridge's private one on every
 * turn, and their editor may have Max mode on. cursor-agent honours a
 * mirrored `maxMode: true` — with no `model` block of its own it builds the
 * `--model` selection in Max mode — and Cursor bills Max mode by the token.
 * Measured 2026-09-11: the same one-word turn was one flat request from a
 * plain `cursor-agent -p` and a fraction of a request, `isTokenBasedCall`,
 * through the bridge. So the flag must say what the session chose.
 */
const withHomes = (userConfig: Record<string, unknown>): { state: string; read: () => Record<string, unknown> } => {
  const user = mkdtempSync(join(tmpdir(), 'cursor-user-'))
  const state = mkdtempSync(join(tmpdir(), 'cursor-acp-state-'))
  mkdirSync(join(user, 'chats'), { recursive: true })
  writeFileSync(join(user, 'cli-config.json'), JSON.stringify(userConfig))
  process.env['CURSOR_CONFIG_DIR'] = user
  process.env['CURSOR_ACP_STATE_DIR'] = state
  return {
    state,
    read: () => JSON.parse(readFileSync(join(state, 'cli-config', 'cli-config.json'), 'utf8')) as Record<string, unknown>,
  }
}

test("the editor's Max mode is not inherited: an ordinary turn runs with maxMode off and no mirrored model block", () => {
  const { read } = withHomes({
    version: 1,
    maxMode: true,
    maxModeAutoEnabled: true,
    model: { modelId: 'default', displayModelId: 'auto', maxMode: true },
    selectedModel: { modelId: 'default', parameters: [] },
    modelParameters: { 'gemini-3.8-flash': [{ id: 'reasoning_effort', value: 'high' }] },
    approvalMode: 'unrestricted',
  })
  prepareConfig(null)
  const written = read()
  assert.equal(written['maxMode'], false)
  assert.equal(written['model'], undefined)
  assert.equal(written['selectedModel'], undefined)
  /* The rest of the editor's settings still travel: that is what the mirror is for. */
  assert.equal(written['approvalMode'], 'unrestricted')
  assert.deepEqual(written['modelParameters'], { 'gemini-3.8-flash': [{ id: 'reasoning_effort', value: 'high' }] })
})

test('a session that asked for the wide window runs with maxMode on and its selection in place', () => {
  const { read } = withHomes({ version: 1, maxMode: false, model: { modelId: 'default', maxMode: false } })
  const selection = { modelId: 'claude-opus-4-6', parameters: [{ id: 'context', value: '1m' }] }
  prepareConfig(selection)
  const written = read()
  assert.equal(written['maxMode'], true)
  assert.equal(written['model'], undefined)
  assert.deepEqual(written['selectedModel'], selection)
})
