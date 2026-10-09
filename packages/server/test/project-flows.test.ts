import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot } from '../src/host.js'
import { FlowPreviews } from '../src/flow-preview.js'
import { parseFlowPolicy } from '../src/flow-policy.js'
import { tempDir } from './scratch.js'

const directory = new URL('../../../../.harnessdesk/flows/', import.meta.url)

test('every project Flow parses as current and previews with the shipped Agents without problems', async () => {
  const catalogue = new Agents({ user: tempDir('hd-project-flows-'), builtin: builtinAgentRoot() })
  const roster = await catalogue.list()
  const previews = new FlowPreviews({
    confine: async () => {},
    now: () => 1,
    agents: async () => roster,
    previewAgent: async (_root, id, _seats, grant) => ({
      id, from: 'prefer', winner: 0, blocked: null, ceiling: { level: grant, hold: 'held' },
      candidates: [{ seat: { runtime: id }, label: 'Test Agent', runtimeName: 'Test Agent', state: 'taken', reason: null, fix: null }],
    }),
    providerOf: async runtime => runtime,
  })
  const files = (await readdir(directory, { recursive: true })).filter(name => /\.ya?ml$/i.test(name))
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8')
    const parsed = parseFlowPolicy(source)
    assert.equal(parsed.document?.format, 'agents', file)
    const preview = await previews.preview('/repo', source, { work: 'Build the requested change' })
    assert.deepEqual(preview.problems, [], file)
    assert.ok(preview.token, file)
    if (file === 'race.yml') {
      assert.equal(preview.seats.filter(seat => seat.role === 'competitor' && seat.isolate).length, 2)
      assert.equal(preview.commands.length, 1)
      assert.ok(preview.seats.some(seat => seat.role === 'judge' && seat.reviews))
      assert.ok(parsed.document?.flow.roles.some(role => role.kind === 'person'))
    }
    if (file === 'fix-and-review.yml') {
      assert.equal(preview.seats.filter(seat => seat.role === 'reviewer').length, 3)
      assert.ok(parsed.document?.flow.rules.some(rule => rule.on === 'reviewer' && rule.then.role === 'fixer'))
      assert.ok(parsed.document?.flow.roles.some(role => role.kind === 'person'))
    }
  }
})
