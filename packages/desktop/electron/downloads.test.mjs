import assert from 'node:assert/strict'
import { test } from 'node:test'

import { downloadOutcome, remember, uniqueName } from './downloads.mjs'

test('a second download of the same name is numbered, never a replacement', () => {
  const have = new Set(['/d/report.csv', '/d/report (2).csv'])
  assert.equal(uniqueName('/d', 'report.csv', (p) => have.has(p)), 'report (3).csv')
  assert.equal(uniqueName('/d', 'fresh.csv', (p) => have.has(p)), 'fresh.csv')
  assert.equal(uniqueName('/d', 'README', (p) => p === '/d/README'), 'README (2)')
})

test('a destination handed out but not yet written counts as taken', () => {
  // Two `report.csv` arriving together: the first is reserved before the
  // second is named, so the second is numbered even though no file exists yet.
  const inFlight = new Set(['/d/report.csv'])
  assert.equal(uniqueName('/d', 'report.csv', (p) => inFlight.has(p)), 'report (2).csv')
})

test('past a thousand copies the name still differs, even twice in one millisecond', () => {
  const a = uniqueName('/d', 'report.csv', (p) => !/\(\w+-\w+\)/.test(p))
  const b = uniqueName('/d', 'report.csv', (p) => !/\(\w+-\w+\)/.test(p))
  assert.match(a, /^report \(\w+-\w+\)\.csv$/)
  assert.notEqual(a, b)
})

test('a name a server sends cannot leave the folder', () => {
  assert.equal(uniqueName('/d', '../../etc/passwd', () => false), '..-..-etc-passwd')
  assert.equal(uniqueName('/d', '', () => false), 'download')
  // The two that carry no separator and are still a way out: `join(dir, '..')`
  // is the folder above Downloads.
  assert.equal(uniqueName('/d', '..', () => false), 'download')
  assert.equal(uniqueName('/d', '.', () => false), 'download')
  assert.equal(uniqueName('/d', '...', () => false), 'download')
  assert.equal(uniqueName('/d', '   ', () => false), 'download')
})

test('a name that would make a path call throw is disarmed, not passed on', () => {
  // A NUL is refused by every `fs` call and by `setSavePath`, and that call
  // sits inside a `will-download` callback where a throw is an uncaught
  // exception in the main process. A colon is a separator to the Finder.
  assert.equal(uniqueName('/d', 're\u0000port.csv', () => false), 're-port.csv')
  assert.equal(uniqueName('/d', 'C:report.csv', () => false), 'C-report.csv')
  assert.doesNotMatch(uniqueName('/d', 'a\u0000b', () => false), /\u0000/)
})

test('what the shell remembers saving is bounded, oldest first', () => {
  const paths = new Set()
  for (let n = 0; n < 5; n += 1) remember(paths, `/d/${n}.csv`, 3)
  assert.deepEqual([...paths], ['/d/2.csv', '/d/3.csv', '/d/4.csv'])
})

test('downloading a remembered file again makes it the newest, not the next evicted', () => {
  // `Set.add` on a value already present leaves it where it was, so the file
  // just written would have been first out — and its own "Show in Finder"
  // would then refuse.
  const paths = new Set()
  for (const name of ['a', 'b', 'c']) remember(paths, `/d/${name}.csv`, 3)
  remember(paths, '/d/a.csv', 3)
  assert.deepEqual([...paths], ['/d/b.csv', '/d/c.csv', '/d/a.csv'], 'the one downloaded again is newest')
  assert.equal(paths.size, 3, 'and still one entry, not two')
  remember(paths, '/d/d.csv', 3)
  assert.ok(paths.has('/d/a.csv'), 'so the next download evicts b, not the file just written')
  assert.deepEqual([...paths], ['/d/c.csv', '/d/a.csv', '/d/d.csv'])
})

test('the outcome is said in the words a notice uses', () => {
  assert.match(downloadOutcome({ name: 'a.csv', path: '/d/a.csv', state: 'completed', bytes: 12 }).message, /Downloaded a\.csv to Downloads/)
  assert.equal(downloadOutcome({ name: 'a.csv', path: '/d/a.csv', state: 'completed', bytes: 12 }).ok, true)
  assert.match(downloadOutcome({ name: 'a.csv', path: '/d/a.csv', state: 'interrupted', bytes: NaN }).message, /did not finish/)
  assert.equal(downloadOutcome({ name: 'a.csv', path: '/d/a.csv', state: 'cancelled' }).ok, false)
})
