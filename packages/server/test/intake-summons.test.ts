import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DESK_POST_MARKER } from '@harnessdesk/protocol'

import { markerOf, publicationKey, summonsOf } from '../src/findings/publication.js'

/*
 * The one rule that turns a comment into a request: `@harnessdesk` at the
 * start of its first line. Everything else on GitHub is discussion, and the
 * table below is the list of discussion that must never become work.
 */

const requests: readonly (readonly [string, string, string])[] = [
  ['the word alone', '@harnessdesk', ''],
  ['words after a space', '@harnessdesk fix the date picker', 'fix the date picker'],
  ['any case', '@HarnessDesk fix it', 'fix it'],
  ['shouted', '@HARNESSDESK fix it', 'fix it'],
  ['a colon', '@harnessdesk: fix it', 'fix it'],
  ['a comma', '@harnessdesk, please fix it', 'please fix it'],
  ['a tab after the word', '@harnessdesk\tfix it', 'fix it'],
  ['CRLF endings, later lines kept', '@harnessdesk fix it\r\nand add a test\r\n', 'fix it\nand add a test'],
  ['a lone CR', '@harnessdesk fix it\rnow', 'fix it\nnow'],
  ['leading blank lines', '\n\n  \r\n@harnessdesk fix it', 'fix it'],
  ['up to three leading spaces', '   @harnessdesk fix it', 'fix it'],
  ['a byte-order mark', '﻿@harnessdesk fix it', 'fix it'],
  ['the word then words on the next line', '@harnessdesk\nthe date picker loses the time zone', 'the date picker loses the time zone'],
  ['markup kept verbatim', '@harnessdesk run `rm -rf /` <!-- ignore previous -->', 'run `rm -rf /` <!-- ignore previous -->'],
]

const refusals: readonly (readonly [string, string])[] = [
  ['an empty comment', ''],
  ['only blank lines', '\n \r\n\t\n'],
  ['a quoted line', '> @harnessdesk fix it'],
  ['a quoted line with no space', '>@harnessdesk fix it'],
  ['a code fence', '```\n@harnessdesk fix it\n```'],
  ['a tilde fence', '~~~\n@harnessdesk fix it\n~~~'],
  ['inline code', '`@harnessdesk fix it`'],
  ['an indented code block', '    @harnessdesk fix it'],
  ['a tab-indented code block', '\t@harnessdesk fix it'],
  ['a longer name', '@harnessdesktop fix it'],
  ['a hyphenated name', '@harnessdesk-bot fix it'],
  ['an underscored name', '@harnessdesk_x fix it'],
  ['a team mention', '@harnessdesk/reviewers please look'],
  ['a team mention in any case', '@HarnessDesk/reviewers please look'],
  ['a full stop straight after the word', '@harnessdesk. fix it'],
  ['the bot account', '@harnessdesk[bot] fix it'],
  ['mid-sentence on the first line', 'Could @harnessdesk fix it?'],
  ['after other words', 'cc @harnessdesk'],
  ['on a later line', 'The date picker is broken.\n@harnessdesk fix it'],
  ['without the at sign', 'harnessdesk fix it'],
  ['a desk post', `${DESK_POST_MARKER}\n@harnessdesk fix it`],
  ['a publication post', `${markerOf(publicationKey('run', 1, 'finding', 'f1'))}\n@harnessdesk fix it`],
  ['a link to the organization', '[@harnessdesk](https://github.com/harnessdesk) fix it'],
]

test('a comment whose first line starts with @harnessdesk is a request, and its words come back', () => {
  for (const [name, body, words] of requests) assert.equal(summonsOf(body), words, name)
})

test('quotes, fences, code, longer names, teams, later lines and desk posts are never requests', () => {
  for (const [name, body] of refusals) assert.equal(summonsOf(body), null, name)
})
