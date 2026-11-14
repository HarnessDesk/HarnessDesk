import assert from 'node:assert/strict'
import { test } from 'node:test'

import { threadAnswerProblem } from '../src/forge-threads.js'

test('a declining answer may be one plain sentence', () => {
  for (const answer of [
    'The current name matches the rest of the module, so it stays.',
    'Is the helper used anywhere else?',
    'The snake_case name matches the database column, so it stays.',
    'It costs 5% more time per call, which is not worth it here.',
  ]) assert.equal(threadAnswerProblem(answer), null, answer)
})

test('a declining answer never mentions anyone, in any spelling', () => {
  for (const answer of [
    'Thanks @jane-doe, but it stays.',
    'Thanks,@jane-doe, but it stays.',
    'As "@jane-doe" said, it stays.',
    'Ask (@jane-doe) about it, it stays.',
    'Write to dev@example.com about it, it stays.',
    'Ping @acme/reviewers if you disagree.',
    'It stays as it is @',
  ]) assert.match(threadAnswerProblem(answer) ?? '', /cannot mention anyone/, answer)
})

test('a declining answer never points at another issue or pull request', () => {
  for (const answer of [
    'This is tracked in #12, so it stays.',
    'This is tracked in acme/other#12, so it stays.',
    'This was settled in (#3) already.',
    'See GH-12 for why it stays.',
  ]) assert.match(threadAnswerProblem(answer) ?? '', /cannot point at another issue or pull request/, answer)
})

test('a declining answer carries no markdown or markup', () => {
  for (const answer of [
    'This **stays** as it is.',
    'This *stays* as it is.',
    'This _stays_ as it is.',
    'This ~~goes~~ stays as it is.',
    'The `name` stays as it is.',
    'The name [stays] as it is.',
    'The name stays as it is \\o/.',
    'The name stays &amp; works.',
    'The name stays <b>as</b> it is.',
    'See [the guide](https://example.com/guide) for the name.',
    'See https://example.com for the name.',
  ]) assert.match(threadAnswerProblem(answer) ?? '', /link or markup/, answer)
})
