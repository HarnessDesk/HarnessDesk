import assert from 'node:assert/strict'
import test from 'node:test'
import { DESK_TOOL_CEILINGS } from '../src/desk-tool-ceilings.js'

test('every new simulator tool has an explicit ceiling', () => {
  assert.equal(DESK_TOOL_CEILINGS['simulator']?.['ios_diagnose'], 'read')
  assert.equal(DESK_TOOL_CEILINGS['simulator']?.['ios_get_appearance'], 'read')
  assert.equal(DESK_TOOL_CEILINGS['simulator']?.['ios_set_appearance'], 'edit')
})
