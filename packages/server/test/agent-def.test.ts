import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAgentDefinition } from '../src/agent-def.js'

/**
 * One AGENT.md, read. The parser reports problems and never throws, the way
 * `parseFlow` does, because a file somebody is still editing must not take a
 * listing down with it.
 */

const REVIEWER = `---
name: Code reviewer
description: Reads a diff it did not write and reports findings.
permission: read
answers: [approve, request-changes]
produces: [review]
skills: [review-checklist]
prefer: [cursor=gemini-3.8-flash/high, claude=opus-5/high]
---

Sweep the whole diff before reporting.
`

test('a complete definition parses, and the body is the brief', () => {
  const { agent, problems } = parseAgentDefinition(REVIEWER, 'code-reviewer')
  assert.deepEqual(problems, [])
  assert.equal(agent?.id, 'code-reviewer')
  assert.equal(agent?.name, 'Code reviewer')
  assert.equal(agent?.permission, 'read')
  assert.deepEqual(agent?.answers, ['approve', 'request-changes'])
  assert.deepEqual(agent?.produces, ['review'])
  assert.deepEqual(agent?.skills, ['review-checklist'])
  assert.equal(agent?.brief, 'Sweep the whole diff before reporting.')
})

test('prefer is parsed with the seat grammar the flow engine already uses', () => {
  const { agent } = parseAgentDefinition(REVIEWER, 'code-reviewer')
  assert.equal(agent?.prefer.length, 2)
  /* The shape is `parseSeat`'s own, to the key: a field nobody wrote is absent
     rather than present and false, which is what `flow.test.ts` pins for a
     role's seats. Normalising it here would make one spec parse into two
     different objects depending on which file it was written in. */
  assert.deepEqual(agent?.prefer[0], {
    runtime: 'cursor',
    model: 'gemini-3.8-flash',
    effort: 'high',
  })
  assert.equal(agent?.prefer[1]?.runtime, 'claude')
})

test('a seat keeps its switches', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Thinker\nprefer: [claude=opus-5/high+thinking]\n---\nThink first.\n',
    'thinker',
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.prefer[0], {
    runtime: 'claude',
    model: 'opus-5',
    effort: 'high',
    thinking: true,
  })
})

test('a model id with a slash in it is written as a map, the way a role writes one', () => {
  /* `cline=deepseek/deepseek-v4-flash` compactly reads as the model "deepseek"
     at effort "deepseek-v4-flash", which no care in the compact grammar can
     catch. The flow engine's answer is the map, and it is the same answer here. */
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Cheap\nprefer:\n  - runtime: cline\n    model: deepseek/deepseek-v4-flash\n---\nWork.\n',
    'cheap',
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.prefer[0], { runtime: 'cline', model: 'deepseek/deepseek-v4-flash' })
})

test('a seat that does not parse is refused, never pushed through as itself', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Bad seat\nprefer: [claude=opus-5+turbo]\n---\nx\n',
    'bad-seat',
  )
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'prefer[0]')
  assert.match(problems[0]?.text ?? '', /\+thinking/)
})

test('permission defaults to read, the narrowest ceiling', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Scout\n---\nLook around.\n', 'scout')
  assert.deepEqual(problems, [])
  assert.equal(agent?.permission, 'read')
})

test('an unknown permission is an error, not a silent widening', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Bad\npermission: admin\n---\nx\n',
    'bad',
  )
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.level, 'error')
  assert.equal(problems[0]?.at, 'permission')
  assert.match(problems[0]?.text ?? '', /read, publish or merge/)
})

test('a file with no front matter is the brief, and says a name is missing', () => {
  const { agent, problems } = parseAgentDefinition('Just a brief.\n', 'plain')
  assert.equal(agent?.name, 'plain')
  assert.equal(agent?.brief, 'Just a brief.')
  assert.equal(problems.some((one) => one.level === 'warning' && one.at === 'name'), true)
})

test('an empty brief is an error — an Agent with no instructions is not an Agent', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Hollow\n---\n\n', 'hollow')
  assert.equal(agent, null)
  assert.equal(problems[0]?.at, 'brief')
})

test('broken YAML is reported at the line, and throws nothing', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: [unclosed\n---\nx\n', 'broken')
  assert.equal(agent, null)
  assert.equal(problems[0]?.level, 'error')
})
