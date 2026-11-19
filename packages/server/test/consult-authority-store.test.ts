import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
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
    external.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON members WHEN NEW.key='"bad"' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`)
    assert.throws(() => store.archive('one', 'root', ['first', 'bad']))
    assert.throws(() => store.lookup('first'))
    assert.equal(external.prepare("SELECT count(*) AS n FROM members WHERE key=?").get(JSON.stringify('first'))?.n, 0)
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
      assert.equal(external.prepare("SELECT count(*) AS n FROM members WHERE key=?").get(JSON.stringify('partial'))?.n, 0)
      assert.equal(external.prepare("SELECT incarnation FROM members WHERE key=?").get(JSON.stringify('owned'))?.incarnation, JSON.stringify('new'))
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
    assert.equal(external.prepare("SELECT count(*) AS n FROM members WHERE key=?").get(JSON.stringify('first'))?.n, 0)
  } finally { external.close(); cleanup() }
})

test('archive includes the root even when omitted from members', () => {
  const { store, cleanup } = setup()
  try { store.archive('one', 'root', ['child']); assert.deepEqual(store.lookup('root'), { incarnation: 'one', root: 'root' }) } finally { cleanup() }
})

test('a symlink to the original database is refused and left untouched', () => {
  const { store, cleanup } = setup()
  try {
    store.archive('one', 'root', ['root'])
    renameSync(store.file, `${store.file}.old`)
    symlinkSync(`${store.file}.old`, store.file)
    assert.throws(() => store.lookup('root'))
    assert.throws(() => store.lookup('root'))
  } finally { cleanup() }
})

test('a post-commit error latches even when the transaction committed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consult-commit-'))
  const store = new ConsultAuthorityStore(dir, { afterCommit: () => { throw new Error('injected post-commit error') } })
  try {
    assert.throws(() => store.archive('one', 'root', ['child']))
    const external = new DatabaseSync(store.file, { readOnly: true })
    try { assert.equal(external.prepare("SELECT incarnation FROM members WHERE key=?").get(JSON.stringify('child'))?.incarnation, JSON.stringify('one')) } finally { external.close() }
    assert.throws(() => store.lookup('child'))
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('truncated database query fails closed', () => {
  const { store, cleanup } = setup()
  try {
    store.archive('one', 'root', Array.from({ length: 5000 }, (_, i) => `key-${i}`))
    truncateSync(store.file, 0)
    assert.throws(() => store.lookup('key-4999'))
    assert.throws(() => store.lookup('root'))
  } finally { cleanup() }
})

 test('archive can preserve a reassociated root while retaining remaining old members', () => {
  const { store, cleanup } = setup()
  try {
    store.archive('new', 'root', ['root'])
    store.archive('old', 'root', ['old-child'], false)
    assert.equal(store.lookup('root')?.incarnation, 'new')
    assert.equal(store.lookup('old-child')?.incarnation, 'old')
  } finally { cleanup() }
})

test('NUL-delimited and unusual identifiers stay exact through inheritance and conditional ownership', () => {
  const { store, cleanup } = setup()
  const root = 'runtime\0root-雪\ud800'
  const sibling = 'runtime\0root-雪\ud801'
  const child = 'runtime\0child-🦊'
  const grandchild = 'runtime\0grandchild'
  const owner = 'runtime\0owner-\udfff'
  const newer = 'runtime\0new-owner'
  try {
    store.archive(owner, root, [child])
    store.archive(newer, sibling, [sibling])
    assert.deepEqual(store.lookup(child), { incarnation: owner, root })
    assert.deepEqual(store.lookup(sibling), { incarnation: newer, root: sibling })
    assert.equal(store.lookup('runtime\0root-雪'), null)
    assert.equal(store.inherit(child, grandchild), true)
    assert.deepEqual(store.lookup(grandchild), { incarnation: owner, root })
    assert.equal(store.release(grandchild, newer), false)
    assert.equal(store.replace(grandchild, newer, newer, sibling), false)
    assert.equal(store.replace(grandchild, owner, newer, sibling), true)
    assert.equal(store.release(grandchild, owner), false)
    assert.deepEqual(store.lookup(grandchild), { incarnation: newer, root: sibling })
    assert.equal(store.release(grandchild, newer), true)
    assert.equal(store.lookup(grandchild), null)
  } finally { cleanup() }
})

test('malformed persisted identifiers latch reads and conditional mutations closed', () => {
  for (const operation of ['lookup', 'replace', 'release'] as const) {
    const { store, cleanup } = setup()
    const external = new DatabaseSync(store.file)
    try {
      store.archive('owner', 'root', ['key'])
      external.exec("UPDATE members SET root='null'")
      assert.throws(() => {
        if (operation === 'lookup') store.lookup('key')
        else if (operation === 'replace') store.replace('key', 'owner', 'new', 'new-root')
        else store.release('key', 'owner')
      })
      assert.throws(() => store.lookup('missing'))
      assert.equal(external.prepare('SELECT count(*) AS n FROM members').get()?.n, 2)
    } finally { external.close(); cleanup() }
  }
})

test('pending delegation edges survive churn, terminate cycles, and forget old seating edges', () => {
  const { store, cleanup } = setup()
  try {
    store.recordEdges('parent', ['child'])
    store.recordEdges('child', ['grandchild'])
    store.recordEdges('grandchild', ['parent'])
    store.recordEdges('unrelated', Array.from({ length: 2001 }, (_, n) => `noise-${n}`))
    const seen: string[] = []
    store.descendants('parent', child => { seen.push(child) })
    assert.deepEqual(new Set(seen), new Set(['child', 'grandchild']))
    store.forgetEdges('child')
    const after: string[] = []
    store.descendants('parent', child => { after.push(child) })
    assert.deepEqual(after, [])
  } finally { cleanup() }
})

test('pending delegation write failure latches the authority store', () => {
  const { store, cleanup } = setup()
  const external = new DatabaseSync(store.file)
  try {
    external.exec("CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'edge write failure'); END")
    assert.throws(() => store.recordEdges('parent', ['child']))
    assert.throws(() => store.lookup('independent'))
  } finally { external.close(); cleanup() }
})
