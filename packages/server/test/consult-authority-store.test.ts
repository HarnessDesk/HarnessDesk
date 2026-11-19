import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ConsultAuthorityStore } from '../src/consult-authority-store.js'

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'consult-authority-'))
  const store = new ConsultAuthorityStore(dir)
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('closed associations are exact, inherited, and conditionally released', () => {
  const { store, cleanup } = setup()
  try {
    store.archive('one', 'root', ['root', 'child', ...Array.from({ length: 2001 }, (_, i) => `pending-${i}`)])
    assert.deepEqual(store.lookup('pending-2000'), { incarnation: 'one', root: 'root' })
    assert.equal(store.inherit('child', 'grandchild'), true)
    assert.equal(store.inherit('grandchild', 'great-grandchild'), true)
    assert.equal(store.inherit('unknown', 'stranger'), false)
    store.archive('two', 'new-root', ['new-root'])
    assert.equal(store.replace('child', 'one', 'two', 'new-root'), true)
    assert.equal(store.release('child', 'one'), false)
    assert.deepEqual(store.lookup('child'), { incarnation: 'two', root: 'new-root' })
    assert.equal(store.release('child', 'two'), true)
    assert.equal(store.lookup('child'), null)
    assert.deepEqual(store.lookup('grandchild'), { incarnation: 'one', root: 'root' })
  } finally { cleanup() }
})

test('host stores are isolated and closing one removes only its own file', () => {
  const a = setup()
  const b = new ConsultAuthorityStore(a.dir)
  try {
    a.store.archive('same', 'a', ['key'])
    b.archive('same', 'b', ['key'])
    a.store.close()
    assert.deepEqual(b.lookup('key'), { incarnation: 'same', root: 'b' })
    assert.throws(() => a.store.lookup('key'))
  } finally { b.close(); a.cleanup() }
})

test('missing or replaced database latches failure and is never treated as empty', () => {
  for (const replace of [false, true]) {
    const { store, cleanup } = setup()
    try {
      store.archive('one', 'root', ['root'])
      renameSync(store.file, `${store.file}.old`)
      if (replace) writeFileSync(store.file, 'not the database')
      assert.throws(() => store.lookup('root'))
      assert.throws(() => store.archive('two', 'root2', ['root2']))
    } finally { cleanup() }
  }
})

test('failed archive rolls back all members and latches', () => {
  const { store, cleanup } = setup()
  const external = new DatabaseSync(store.file)
  try {
    external.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON members WHEN NEW.key='bad' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    assert.throws(() => store.archive('one', 'root', ['first', 'bad']))
    assert.throws(() => store.lookup('first'))
    assert.equal(external.prepare("SELECT count(*) AS n FROM members WHERE key='first'").get()?.n, 0)
  } finally { external.close(); cleanup() }
})

test('conditional replacement cannot mutate a newer owner', () => {
  const { store, cleanup } = setup()
  try {
    store.archive('one', 'root', ['key'])
    assert.equal(store.replace('key', 'one', 'two', 'new-root'), true)
    assert.equal(store.replace('key', 'one', 'three', 'wrong'), false)
    assert.deepEqual(store.lookup('key'), { incarnation: 'two', root: 'new-root' })
  } finally { cleanup() }
})

test('damaged schema is held closed', () => {
  const { store, cleanup } = setup()
  const external = new DatabaseSync(store.file)
  try {
    external.exec('DROP TABLE members')
    assert.throws(() => store.lookup('missing'))
    assert.throws(() => store.lookup('missing'))
  } finally { external.close(); cleanup() }
})

test('archive refuses a key owned by another incarnation without partial writes', () => {
  const { store, cleanup } = setup()
  try {
    store.archive('new', 'new-root', ['owned'])
    assert.throws(() => store.archive('old', 'old-root', ['partial', 'owned']))
    const external = new DatabaseSync(store.file)
    try {
      assert.equal(external.prepare("SELECT count(*) AS n FROM members WHERE key='partial'").get()?.n, 0)
      assert.equal(external.prepare("SELECT incarnation FROM members WHERE key='owned'").get()?.incarnation, 'new')
    } finally { external.close() }
  } finally { cleanup() }
})

test('commit failure rolls back archive and latches', () => {
  const { store, cleanup } = setup()
  const external = new DatabaseSync(store.file)
  try {
    external.exec(`CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE deferred (id TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON members BEGIN INSERT INTO deferred VALUES ('absent'); END;`)
    assert.throws(() => store.archive('one', 'root', ['first']))
    assert.throws(() => store.lookup('first'))
    assert.equal(external.prepare("SELECT count(*) AS n FROM members WHERE key='first'").get()?.n, 0)
  } finally { external.close(); cleanup() }
})
