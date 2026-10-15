import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { GitReader } from '../src/provenance/git.js'
import { digest, ProvenanceJournal } from '../src/provenance/journal.js'
import { reconcileProject, type CommitObservation } from '../src/provenance/reconcile.js'
import { tempDir } from './scratch.js'

const sha = (n: number) => n.toString(16).padStart(40, '0')

test('reconcile yields within every 100 work items even when the clock does not advance', async () => {
  let yields = 0
  const commits: CommitObservation[] = Array.from({ length: 2000 }, (_, i) => ({
    id: `commit-${i}`, sha: sha(i + 1), tree: sha(i + 1), parents: [], firstSeenAt: i,
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [], window: { from: null, to: i },
    patch: null, files: [], why: 'missing-object',
  }))
  const input = { commits, sources: [], moves: [], priorLinks: [], now: 3000,
    slices: { now: () => 0, yield: async () => { yields += 1 }, items: 100 } }
  const decisions = await reconcileProject(input, {} as GitReader, new AbortController().signal)
  assert.equal(decisions.length, commits.length)
  assert.ok(yields >= commits.length / 100, `${yields} yields for ${commits.length} commits`)
})

test('journal replay yields while decoding, and subsequent reads return only the appended tail', async () => {
  const file = join(tempDir('journal-slices-'), 'provenance.ndjson')
  const lines = Array.from({ length: 2000 }, (_, i) => {
    const body = { version: 1, seq: i + 1, kind: 'gap', value: { id: `gap-${i}`, reason: 'history-gap', from: null, to: i } }
    return JSON.stringify({ ...body, checksum: digest(body) })
  })
  await writeFile(file, `${lines.join('\n')}\n`)
  let yields = 0
  const options = { copy: 'shallow' as const, slices: { now: () => 0, yield: async () => { yields += 1 }, items: 100 } }
  const journal = new ProvenanceJournal(file)
  const first = await journal.read(options)
  assert.equal(first.entries.length, 2000)
  assert.ok(yields >= 20, `${yields} yields for 2000 decoded entries`)
  const tailOptions = { copy: 'shallow' as const, after: first.entries.length }
  assert.deepEqual((await journal.read(tailOptions)).entries, [])
  await journal.append('gap', { id: 'later', reason: 'history-gap', from: null, to: 3000 })
  assert.deepEqual((await journal.read(tailOptions)).entries.map((entry) => (entry.value as { id: string }).id), ['later'])
  assert.equal(first.entries.length, 2000)
})
