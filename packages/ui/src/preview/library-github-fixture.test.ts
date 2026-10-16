import { expect, it } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { previewStore } from './harness'

it('answers fetched skills, planned files, reads and per-op writes through the preview transport', async () => {
  const transport = previewStore().transport
  const source = await transport.request('library/source/fetch', { url: 'https://github.com/acme-dev/skills' })
  expect(source.repo).toBe('acme-dev/skills')
  const skill = source.skills.find(s => s.runnable > 0)!
  expect(skill).toBeTruthy()
  const plan = await transport.request('library/plan', { intents: [{ kind: 'installSkill', name: skill.name, sourcePath: skill.sourcePath, targetRuntime: runtimeId('alpha'), origin: { url: source.url, ref: source.ref, commit: source.commit, path: skill.dir, bundle: skill.bundle } }] })
  expect(plan.ops[0]?.files?.some(f => f.runnable)).toBe(true)
  const path = plan.ops[0]!.files!.find(f => f.runnable)!.path
  const file = await transport.request('library/source/file', { sourcePath: skill.sourcePath, path })
  expect(file.text).toContain('#!/bin/sh')
  const applied = await transport.request('library/apply', { ops: plan.ops })
  expect(applied).toEqual([{ id: plan.ops[0]!.id, outcome: 'done' }])
})
