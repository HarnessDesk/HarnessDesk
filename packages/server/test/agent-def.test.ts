import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAgentDefinition } from '../src/agent-def.js'
import { parseFlow } from '../src/flow.js'

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
  assert.equal(agent?.description, 'Reads a diff it did not write and reports findings.')
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

test('a YAML refusal names the line of the file, not the line of the slice', () => {
  /* `answers:` is line 3 of the file and line 2 of the front-matter slice.
     Reporting 2 sends somebody to the line above their mistake, which on a
     three-field header is somebody else's field. */
  const { agent, problems } = parseAgentDefinition('---\nname: Reviewer\nanswers: [unclosed\n---\nx\n', 'off-by-one')
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'line 3')
})

test('a lone scalar is read where a list belongs, because it is what somebody meant', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\nname: One\nskills: review-checklist\nanswers: approve\n---\nWork.\n',
    'one',
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.skills, ['review-checklist'])
  assert.deepEqual(agent?.answers, ['approve'])
})

test('a list of maps where words belong is dropped, never read as "[object Object]"', () => {
  /* `- name: review` is how people write a list of things with names, and a
     skill called "[object Object]" is a lookup that fails later and elsewhere.
     A flow drops non-scalars; so does this, from the same helper. */
  const { agent, problems } = parseAgentDefinition('---\nname: Mapper\nskills:\n  - name: review\n---\nWork.\n', 'mapper')
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.skills, [])
})

test('a seat that is not a scalar is refused here the way a flow refuses it', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Nested\nprefer: [[cursor, claude]]\n---\nWork.\n', 'nested')
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'prefer[0]')
  assert.match(problems[0]?.text ?? '', /a seat needs at least an agent/)
})

test('a name that is written and unusable warns, the same as a name nobody wrote', () => {
  for (const source of ['---\nname:\n---\nWork.\n', '---\nname: [Reviewer]\n---\nWork.\n']) {
    const { agent, problems } = parseAgentDefinition(source, 'nameless')
    assert.equal(agent?.name, 'nameless')
    assert.equal(problems.length, 1)
    assert.equal(problems[0]?.level, 'warning')
    assert.equal(problems[0]?.at, 'name')
  }
})

test('a permission field with nothing in it says it is empty, not that "null" is no permission', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Blank\npermission:\n---\nWork.\n', 'blank')
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'permission')
  assert.match(problems[0]?.text ?? '', /empty/)
  assert.doesNotMatch(problems[0]?.text ?? '', /null/)
})

test('the refusal for a word that is no permission is the flow engine’s own sentence', () => {
  /* One field, two files, one sentence. Compared rather than quoted, because a
     copy of the wording here drifts from the flow's the first time either is
     reworded and nothing says so. */
  const agent = parseAgentDefinition('---\nname: Bad\npermission: admin\n---\nWork.\n', 'bad')
  const flow = parseFlow('name: F\nroles:\n  r:\n    permission: admin\n')
  const mine = agent.problems.find((one) => one.at === 'permission')
  const theirs = flow.problems.find((one) => one.at === 'roles.r.permission')
  assert.equal(typeof theirs?.text, 'string')
  assert.equal(mine?.text, theirs?.text)
})

test('front matter that opens and never closes is an error, not a brief that eats the fields', () => {
  /* The likeliest mistake in a hand-edited file. Read as a brief it discards a
     declared permission in silence and then blames the file for having no name
     — one warning, no error, diagnosing the wrong thing. */
  const { agent, problems } = parseAgentDefinition('---\nname: Reviewer\npermission: merge\n', 'reviewer')
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.level, 'error')
  assert.equal(problems[0]?.at, 'front matter')
  assert.match(problems[0]?.text ?? '', /never closed/)
})

test('a fence is a line of exactly ---, so a rule with a word after it opens nothing', () => {
  const { agent } = parseAgentDefinition('--- draft\nname: Reviewer\n---\nWork.\n', 'draft')
  assert.equal(agent?.name, 'draft')
  assert.match(agent?.brief ?? '', /^--- draft/)
})

test('CRLF front matter still splits, fields and brief both', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\r\nname: Win\r\npermission: merge\r\n---\r\nBody here.\r\n',
    'win',
  )
  assert.deepEqual(problems, [])
  assert.equal(agent?.name, 'Win')
  assert.equal(agent?.permission, 'merge')
  assert.equal(agent?.brief, 'Body here.')
})

test('empty front matter closes, and is the same as no front matter', () => {
  const { agent, problems } = parseAgentDefinition('---\n---\nJust a brief.\n', 'empty')
  assert.equal(agent?.brief, 'Just a brief.')
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'name')
})
