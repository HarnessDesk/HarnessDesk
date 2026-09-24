import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_TRIGGER_BUDGET,
  TRIGGER_DEFAULTS,
  TRIGGER_SOURCES,
  type TriggerDefinition,
  type TriggerField,
  type TriggerOn,
  type TriggerSource,
} from '../src/index.js'

/*
 * The trigger vocabulary is closed: three sources, a finite field list, and
 * one bounded budget. Adding a source or a field is a deliberate protocol
 * change, never something a declaration can reach on its own.
 */

test('the source union, its events and its default keys are exactly the three the phase ships', () => {
  const sources: readonly TriggerSource[] = TRIGGER_SOURCES
  assert.deepEqual([...sources], ['pull-request', 'issue', 'schedule'])
  const exhaustive = (on: TriggerOn): number => {
    switch (on.kind) {
      case 'pull-request': return on.events.length
      case 'issue': return on.events.length
      case 'schedule': return on.everyMinutes
    }
  }
  assert.equal(exhaustive({ kind: 'schedule', events: ['tick'], everyMinutes: 15 }), 15)
  const fields: Record<TriggerSource, readonly TriggerField[]> = {
    'pull-request': TRIGGER_DEFAULTS['pull-request'].fields,
    issue: TRIGGER_DEFAULTS.issue.fields,
    schedule: TRIGGER_DEFAULTS.schedule.fields,
  }
  assert.deepEqual(fields, { 'pull-request': ['pr', 'head', 'event'], issue: ['issue', 'event'], schedule: ['slot'] })
  assert.deepEqual(TRIGGER_DEFAULTS['pull-request'].events, ['opened', 'pushed'])
  assert.deepEqual(TRIGGER_DEFAULTS.issue.events, ['labelled', 'closed', 'commented'])
  assert.deepEqual(TRIGGER_DEFAULTS.schedule.events, ['tick'])
  assert.deepEqual(TRIGGER_DEFAULTS['pull-request'].goal, ['pr'])
  assert.deepEqual(TRIGGER_DEFAULTS['pull-request'].dedupe, ['pr', 'head', 'event'])
  assert.deepEqual(TRIGGER_DEFAULTS.issue.goal, ['issue'])
  assert.deepEqual(TRIGGER_DEFAULTS.issue.dedupe, ['issue', 'event'])
  assert.deepEqual(TRIGGER_DEFAULTS.schedule.goal, ['slot'])
  assert.deepEqual(TRIGGER_DEFAULTS.schedule.dedupe, ['slot'])
  assert.deepEqual(DEFAULT_TRIGGER_BUDGET, { usd: 5, rounds: 3, hours: 4, withoutProgress: 2 })
})

test('a definition carries no command, environment, ceiling or free-form template field', () => {
  const keys = ['id', 'on', 'opens', 'goal', 'again', 'dedupe', 'concurrency', 'forks', 'budget'] as const
  type Missing = Exclude<keyof TriggerDefinition, (typeof keys)[number]>
  const nothingElse: [Missing] extends [never] ? true : false = true
  const noCommand: 'command' extends keyof TriggerDefinition ? true : false = false
  const noCeiling: 'ceiling' extends keyof TriggerDefinition ? true : false = false
  const noEnv: 'env' extends keyof TriggerDefinition ? true : false = false
  assert.deepEqual([nothingElse, noCommand, noCeiling, noEnv], [true, false, false, false])
})
