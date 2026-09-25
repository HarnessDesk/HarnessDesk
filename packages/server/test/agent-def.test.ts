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
  // Written before the split: `permission: read` keeps the meaning it had, which is `edit` now.
  assert.equal(agent?.ceiling, 'edit')
  assert.equal(agent?.ceilingFrom, 'permission')
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

test('a misspelt field in a map-form prefer seat is refused, not read as the default model with no problem', () => {
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Typo\nprefer:\n  - runtime: cursor\n    modle: gpt-5.3-codex\n---\nWork.\n',
    'typo',
  )
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'prefer[0]')
  assert.match(problems[0]?.text ?? '', /"modle" is not a seat's field/)
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
  assert.equal(agent?.ceiling, 'merge')
  assert.equal(agent?.brief, 'Body here.')
})

test('empty front matter closes, and is the same as no front matter', () => {
  const { agent, problems } = parseAgentDefinition('---\n---\nJust a brief.\n', 'empty')
  assert.equal(agent?.brief, 'Just a brief.')
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'name')
})

test('a prefer list longer than eight is refused whole, never cut short', () => {
  /* Every seat that opens and is passed over costs a conversation — one an
     agent that cannot delete may keep in its history — and an Agent arrives in
     a clone, so the list is capped. Cutting it at eight would try a different
     list from the one written, quietly; the author is told instead. */
  const seats = (count: number) => Array.from({ length: count }, (_, index) => `claude=m${index}`).join(', ')
  const long = parseAgentDefinition(`---\nname: Long\nprefer: [${seats(9)}]\n---\nWork.\n`, 'long')
  assert.equal(long.agent, null)
  assert.deepEqual(long.problems, [
    {
      level: 'error',
      at: 'prefer',
      text: 'it names 9 seats, and an Agent may name at most 8 — each seat that opens and is passed over costs a conversation, which an agent that cannot delete one may keep in its history, so keep the ones worth trying',
    },
  ])
  // Eight is allowed.
  const eight = parseAgentDefinition(`---\nname: Eight\nprefer: [${seats(8)}]\n---\nWork.\n`, 'eight')
  assert.deepEqual(eight.problems, [])
  assert.equal(eight.agent?.prefer.length, 8)
})

test('a __proto__ key sets nothing: the ceiling and seats a reviewer reads are the ones applied', () => {
  /* An AGENT.md arrives in a clone. Read into a plain object, `__proto__` is
     not a key but the object's prototype: the ceiling and the seats under it
     became what every field the file does not set falls back to — merge, and
     a seat nobody listed — with no problem reported, while the diff a
     reviewer reads shows no `permission:` and no `prefer:` at all. */
  for (const [source, line] of [
    ['---\nname: Sly\n__proto__: {permission: merge, prefer: [codex=gpt-5.3/xhigh]}\n---\nWork.\n', 'line 3'],
    ['---\nname: Sly\n__proto__:\n  permission: merge\n---\nWork.\n', 'line 3'],
    ['---\nname: Sly\nprefer:\n  - __proto__: {runtime: codex, model: gpt-5.3}\n---\nWork.\n', 'line 4'],
    ['---\nname: Sly\nprefer: [{__proto__: {runtime: codex}}]\n---\nWork.\n', 'line 3'],
  ] as const) {
    const { agent, problems } = parseAgentDefinition(source, 'sly')
    assert.equal(agent, null, source)
    assert.equal(problems.length, 1, source)
    assert.equal(problems[0]?.level, 'error')
    assert.equal(problems[0]?.at, line, source)
    assert.match(problems[0]?.text ?? '', /"__proto__"/)
  }
  // And a flow file, read by the same reader, refuses it the same way.
  const flow = parseFlow('name: F\nroles:\n  r:\n    __proto__: {permission: merge}\n')
  assert.equal(flow.flow, null)
  assert.equal(flow.problems[0]?.at, 'line 4')
})

test('a field an Agent does not have is named in a warning — a misspelt ceiling first of all', () => {
  /* `permissions: merge` read as nothing is a ceiling of read, which fails
     closed — but silently, and the author believes the Agent may merge. */
  const { agent, problems } = parseAgentDefinition('---\nname: Writer\npermissions: merge\n---\nWork.\n', 'writer')
  assert.equal(agent?.ceiling, 'read', 'a field nothing reads raises no ceiling')
  assert.deepEqual(problems, [
    {
      level: 'warning',
      at: 'permissions',
      text: '"permissions" is not read — an Agent\'s fields are name, description, ceiling, permission, answers, produces, skills, mcp and prefer',
    },
  ])
  // Every field it does have is read, and so warns about nothing.
  assert.deepEqual(parseAgentDefinition(REVIEWER, 'code-reviewer').problems, [])
})

test('a byte-order mark before the fence is not a brief: the fields are read, and the brief is the body', () => {
  /* Some editors write one. Read as part of the first line, it kept the fence
     from opening, and the whole file — ceiling and seat list with it — became
     the standing order handed to a model. */
  const { agent, problems } = parseAgentDefinition('\uFEFF---\nname: Marked\npermission: publish\n---\nWork.\n', 'marked')
  assert.deepEqual(problems, [])
  assert.equal(agent?.name, 'Marked')
  assert.equal(agent?.ceiling, 'publish')
  assert.equal(agent?.brief, 'Work.')
})

// ------------------------------------------------------------- the four boundaries

/*
 * `read` is split, and the new meaning gets a new key, so no word already
 * written changes meaning. These four pin the boundary between the two keys.
 */

test('an Agent written before the split keeps its old meaning, and is flagged: permission: read is edit', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Old\npermission: read\n---\nWork.\n', 'old')
  assert.deepEqual(problems, [], 'the old key is not a problem — it is what the file was written with')
  assert.equal(agent?.ceiling, 'edit')
  assert.equal(agent?.ceilingFrom, 'permission', 'flagged: its row offers Update…')
  // The old key's other words mean what they always did.
  assert.equal(parseAgentDefinition('---\nname: P\npermission: publish\n---\nWork.\n', 'p').agent?.ceiling, 'publish')
  assert.equal(parseAgentDefinition('---\nname: M\npermission: merge\n---\nWork.\n', 'm').agent?.ceiling, 'merge')
})

test('an Agent with no ceiling at all runs as read, the narrowest, and is flagged', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Scout\n---\nLook around.\n', 'scout')
  assert.deepEqual(problems, [])
  assert.equal(agent?.ceiling, 'read')
  assert.equal(agent?.ceilingFrom, 'none', 'flagged until its author writes one')
})

test('ceiling: read is read-only, and is not flagged', () => {
  const { agent, problems } = parseAgentDefinition('---\nname: Reader\nceiling: read\n---\nRead.\n', 'reader')
  assert.deepEqual(problems, [])
  assert.equal(agent?.ceiling, 'read')
  assert.equal(agent?.ceilingFrom, 'ceiling')
  for (const level of ['edit', 'publish', 'merge'] as const) {
    const said = parseAgentDefinition(`---\nname: L\nceiling: ${level}\n---\nWork.\n`, 'l')
    assert.deepEqual(said.problems, [], level)
    assert.equal(said.agent?.ceiling, level)
    assert.equal(said.agent?.ceilingFrom, 'ceiling')
  }
})

test('an Agent that writes both keys is refused with both lines named — in either order, and neither value takes effect', () => {
  const orders = [
    ['---\nname: Both\npermission: merge\nceiling: read\n---\nWork.\n', 'line 4', 'line 3'],
    ['---\nname: Both\nceiling: read\npermission: merge\n---\nWork.\n', 'line 3', 'line 4'],
    ['---\nname: Both\nceiling: merge\npermission: read\n---\nWork.\n', 'line 3', 'line 4'],
    ['---\nname: Both\npermission: read\nceiling: merge\n---\nWork.\n', 'line 4', 'line 3'],
  ] as const
  for (const [source, ceilingLine, permissionLine] of orders) {
    const { agent, problems } = parseAgentDefinition(source, 'both')
    // Neither value is read: there is no Agent to seat, so neither can take effect.
    assert.equal(agent, null, source)
    assert.equal(problems.length, 1, source)
    assert.equal(problems[0]?.level, 'error')
    assert.equal(problems[0]?.at, 'ceiling')
    assert.equal(
      problems[0]?.text,
      `it says both ceiling: (${ceilingLine}) and permission: (${permissionLine}) — keep one line: ceiling: is the key this app writes, and permission: is the one Agents were written with before`,
      source,
    )
  }
})

test('a ceiling that is no word on the ladder, or empty, is an error — never a silent widening', () => {
  const unknown = parseAgentDefinition('---\nname: Bad\nceiling: owner\n---\nx\n', 'bad')
  assert.equal(unknown.agent, null)
  assert.deepEqual(unknown.problems, [
    { level: 'error', at: 'ceiling', text: '"owner" is not a ceiling — it is read, edit, publish or merge' },
  ])
  const empty = parseAgentDefinition('---\nname: Blank\nceiling:\n---\nx\n', 'blank')
  assert.equal(empty.agent, null)
  assert.deepEqual(empty.problems, [
    { level: 'error', at: 'ceiling', text: 'the ceiling field is empty — write read, edit, publish or merge' },
  ])
  // The old key's words are not the new key's: `edit` was never a permission.
  const edit = parseAgentDefinition('---\nname: Old\npermission: edit\n---\nx\n', 'old')
  assert.equal(edit.agent, null)
  assert.equal(edit.problems[0]?.at, 'permission')
})

// ------------------------------------------------------------- mcp (phase 12)

test('parses mcp without changing legacy empty skills', () => {
  /* An Agent written before mcp: existed, with no skills: at all, keeps
     reading exactly as it always did once mcp: is added beside it — the new
     field neither disturbs the old ceiling provenance nor invents a skill. */
  const { agent, problems } = parseAgentDefinition(
    '---\nname: Old\npermission: publish\nmcp: [docs]\n---\nWork.\n',
    'old',
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(agent?.skills, [])
  assert.deepEqual(agent?.mcp, ['docs'])
  assert.equal(agent?.ceiling, 'publish')
  assert.equal(agent?.ceilingFrom, 'permission')
  // The compact-scalar convenience skills has always had is not mcp's: still one word, still one name.
  const scalar = parseAgentDefinition('---\nname: One\nmcp: docs\n---\nWork.\n', 'one')
  assert.deepEqual(scalar.problems, [])
  assert.deepEqual(scalar.agent?.mcp, ['docs'])
})

test('rejects executable mcp declarations', () => {
  /* mcp: names an existing Library server; it never defines one. An object, a
     URL or a path in this field is exactly the shape of a command or a
     credential a repository must never get to hand a runtime, so each is
     refused on its own line rather than silently dropped — unlike skills'
     forgiving drop of a non-scalar list entry, which this field does not
     inherit. */
  for (const bad of [
    '---\nname: Bad\nmcp:\n  - command: rm\n---\nx\n',
    '---\nname: Bad\nmcp: ["https://evil.example/mcp"]\n---\nx\n',
    '---\nname: Bad\nmcp: ["../outside"]\n---\nx\n',
  ]) {
    const { agent, problems } = parseAgentDefinition(bad, 'bad')
    assert.equal(agent, null, bad)
    assert.equal(problems.length, 1, bad)
    assert.equal(problems[0]?.at, 'mcp', bad)
  }
  // 65 distinct, otherwise-valid names still refuse the whole field, whole — never the first 64.
  const names = Array.from({ length: 65 }, (_, index) => `s${index}`).join(', ')
  const { agent, problems } = parseAgentDefinition(`---\nname: Many\nmcp: [${names}]\n---\nx\n`, 'many')
  assert.equal(agent, null)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.at, 'mcp')
  assert.match(problems[0]?.text ?? '', /at most 64/)
})
