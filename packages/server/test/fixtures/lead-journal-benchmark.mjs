// Synthetic, isolated histories at the production checkpoint cadence. Fixture setup
// batches disk writes; measured opens include the newest sealed-segment read and anchored metadata-chain verification.
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { initialLeadState, reduceLeadRecord, leadCheckpoint, createLeadJournal, parseLeadJournalRecord } from '@harnessdesk/lead'
import { openLeadFileJournal } from '../../src/lead/journal.js'

for (const count of [2000, 8000, 32000]) {
  const home = await fs.mkdtemp(join(tmpdir(), 'hd-lead-benchmark-'))
  try {
    const directory = join(home, 'lead')
    await fs.mkdir(directory)
    let state = initialLeadState(), head = '0'.repeat(64), frames = [], records = 0
    const segments = []
    let segmentHead = '0'.repeat(64)
    const frame = record => {
      const checksum = createHash('sha256').update(JSON.stringify({ record, previous: head })).digest('hex')
      frames.push(JSON.stringify({ record, previous: head, checksum }) + '\n'); head = checksum
    }
    for (let i = 0; i < count; i++) {
      for (const event of [
        { type: 'attempt', id: `read-${i}`, correlationId: `read-${i}`, method: 'library/usage', action: null,
          kind: 'read', stepId: null, policyRevision: null, projectPolicyRevision: null, contractRevision: null, arguments: { type: 'object', size: 0, fields: [] } },
        { type: 'decision', id: `read-${i}`, effect: 'allow', reason: 'policy', rule: null },
        { type: 'dispatch-start', id: `read-${i}`, dispatched: true },
        { type: 'result', id: `read-${i}`, outcome: 'succeeded', identity: null },
      ]) {
        if (records >= 1024) {
          const name = `thread-1.ndjson.sealed-benchmark-${segments.length}`, bytes = frames.join('')
          await fs.writeFile(join(directory, name), bytes)
          const segment = { name, hash: createHash('sha256').update(bytes).digest('hex'), previous: segmentHead }
          segmentHead = createHash('sha256').update(JSON.stringify(segment)).digest('hex')
          segments.push({ ...segment, checksum: segmentHead })
          frames = []; frame(leadCheckpoint(state, head)); records = 0
        }
        const record = parseLeadJournalRecord({ version: 1, seq: state.seq + 1, ...event })
        state = reduceLeadRecord(state, record); frame(record); records++
      }
    }
    await fs.writeFile(join(directory, 'thread-1.ndjson'), frames.join(''))
    const database = new DatabaseSync(join(directory, 'thread-1.writer.sqlite'))
    database.exec('CREATE TABLE journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const put = database.prepare('INSERT INTO journal VALUES (?, ?)')
    put.run('head', JSON.stringify({ seq: state.seq, hash: head, segments: segmentHead })); put.run('segments', JSON.stringify(segments)); database.close()
    const samples = []
    for (let run = 0; run < 3; run++) {
      const begin = performance.now(), disk = await openLeadFileJournal(home, 'thread-1'), journal = await createLeadJournal(disk)
      samples.push(performance.now() - begin)
      if (journal.state.seq !== count * 4 || journal.state.attempts.size > 64) throw new Error('benchmark state mismatch')
      await disk.close()
    }
    samples.sort((a, b) => a - b)
    console.log(JSON.stringify({ attempts: count, medianMs: Number(samples[1].toFixed(2)), samplesMs: samples.map(n => Number(n.toFixed(2))), sealedSegments: segments.length }))
  } finally { await fs.rm(home, { recursive: true, force: true }) }
}
