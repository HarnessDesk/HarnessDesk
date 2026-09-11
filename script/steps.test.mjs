import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSteps } from './lib/steps.mjs'

/**
 * `verify` prints a line per step and keeps going, so that one run shows every
 * independent failure. The two exceptions are what this holds: a step that
 * ends the run, and a step that reads what a failed step built (#208).
 */

/** A stream that keeps what was written to it. */
const sink = () => ({ text: '', write(chunk) { this.text += chunk; return true } })

test('a step that needs a failed step is not run, and the report says why', () => {
  const out = sink()
  const err = sink()
  const { step, report, failures, skipped } = createSteps({ out, err })
  step('build', () => {
    throw Object.assign(new Error('the build failed'), { stdout: 'error TS1005' })
  })
  let ran = false
  const answer = step('node tests', () => {
    ran = true
  }, { needs: 'build' })
  assert.equal(ran, false, 'the tests are not run over what a failed build left')
  assert.equal(answer, false)
  assert.match(out.text, /• node tests \.\.\. not run: build failed\n/)
  assert.equal(failures.length, 1)
  assert.deepEqual(skipped, [{ name: 'node tests', needs: 'build' }])
  report()
  assert.match(err.text, /--- build ---\nerror TS1005/)
  assert.match(err.text, /--- node tests ---\nnot run: build failed, and this reads what it builds\./)
})

test('a step that needs a step that passed is run like any other', () => {
  const out = sink()
  const { step, failures, skipped } = createSteps({ out })
  step('build', () => {})
  let ran = false
  assert.equal(step('node tests', () => {
    ran = true
  }, { needs: 'build' }), true)
  assert.equal(ran, true)
  assert.deepEqual([failures.length, skipped.length], [0, 0])
  assert.match(out.text, /• build \.\.\. ok\n• node tests \.\.\. ok\n/)
})

test('a step that stops the run reports what failed and ends it there', () => {
  const out = sink()
  const err = sink()
  const codes = []
  const { step } = createSteps({ out, err, exit: (code) => codes.push(code) })
  step('lockfile installs', () => {
    throw new Error('the lockfile is out of date')
  }, { stop: true })
  assert.deepEqual(codes, [1])
  assert.match(err.text, /--- lockfile installs ---\nthe lockfile is out of date/)
})
