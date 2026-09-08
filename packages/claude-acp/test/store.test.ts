import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sessionFiles, trash } from '../src/store.js'

/**
 * The one thing this bridge writes to Claude Code's store: taking a
 * conversation out of it.
 *
 * Two properties, and they are the whole design. Nothing is *erased* — what
 * goes, goes to the Trash, so a confirmation misread at midnight costs a drag
 * back rather than the work. And a session id is only ever a name: an id
 * dressed up as a path must not reach a directory the store does not own.
 */

test('a session is found by id alone, transcript and sidecars together', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'claude-store-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const project = join(home, 'projects', '-Users-someone-repo')
  mkdirSync(join(project, 'abc'), { recursive: true })
  writeFileSync(join(project, 'abc.jsonl'), '{}\n')
  writeFileSync(join(project, 'abc', 'sidecar.json'), '{}')
  writeFileSync(join(project, 'other.jsonl'), '{}\n')

  assert.deepEqual(
    [...sessionFiles('abc', home)].sort(),
    [join(project, 'abc'), join(project, 'abc.jsonl')].sort(),
  )

  // An id nobody wrote anything for is empty, not an error: a session that
  // never took a turn was never written down.
  assert.deepEqual(sessionFiles('never-used', home), [])

  // A traversal dressed as an id reaches nothing.
  assert.deepEqual(sessionFiles('../../../etc', home), [])
  assert.deepEqual(sessionFiles('', home), [])
})

test('what is removed goes to the Trash, and never over something already there', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'claude-trash-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const one = join(home, 'abc.jsonl')

  writeFileSync(one, 'first')
  assert.deepEqual(trash([one], home), [one])
  assert.equal(existsSync(one), false)
  assert.deepEqual(readdirSync(join(home, '.Trash')), ['abc.jsonl'])

  // A second file of the same name does not overwrite the first: the point of
  // trashing rather than erasing is that nothing is destroyed, and that has
  // to hold inside the Trash too.
  writeFileSync(one, 'second')
  assert.deepEqual(trash([one], home), [one])
  assert.deepEqual(readdirSync(join(home, '.Trash')).sort(), ['abc 2.jsonl', 'abc.jsonl'])

  // A path that is not there is reported by its absence, not by throwing.
  assert.deepEqual(trash([join(home, 'gone.jsonl')], home), [])
  assert.deepEqual(trash([], home), [])
})
