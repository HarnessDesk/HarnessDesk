import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPromptLinkInbox,
  parsePromptLink,
  PROMPT_LINK_MAX_PROMPT,
  PROMPT_LINK_MAX_URL,
  promptLinkFromArgv,
} from './prompt-link.mjs'

const link = (params) => `harnessdesk://new?${new URLSearchParams(params)}`
const ok = (repo, prompt, pr = null, flow = null) => ({ repo, prompt, pr, flow })

const table = [
  // Accepted.
  ['owner/name', link({ repo: 'acme.dev/widgets', prompt: 'Fix the build' }), ok('acme.dev/widgets', 'Fix the build')],
  ['host/owner/name', link({ repo: 'github.com/acme/widgets', prompt: 'Hi' }), ok('github.com/acme/widgets', 'Hi')],
  ['a trailing .git is dropped', link({ repo: 'acme/widgets.git', prompt: 'Hi' }), ok('acme/widgets', 'Hi')],
  ['an absolute path', link({ repo: '/home/jane/widgets', prompt: 'Hi' }), ok('/home/jane/widgets', 'Hi')],
  ['a Windows path', link({ repo: 'C:\\code\\widgets', prompt: 'Hi' }), ok('C:\\code\\widgets', 'Hi')],
  ['a trailing slash path', `harnessdesk://new/?repo=acme/widgets&prompt=Hi`, ok('acme/widgets', 'Hi')],
  ['pr and flow', link({ repo: 'acme/widgets', prompt: 'Review', pr: '42', flow: 'review-2' }), ok('acme/widgets', 'Review', 42, 'review-2')],
  ['percent-encoded newlines and tabs survive', 'harnessdesk://new?repo=acme/widgets&prompt=one%0Atwo%09three', ok('acme/widgets', 'one\ntwo\tthree')],
  ['CRLF becomes LF', 'harnessdesk://new?repo=acme/widgets&prompt=one%0D%0Atwo', ok('acme/widgets', 'one\ntwo')],
  ['NUL and controls are stripped', 'harnessdesk://new?repo=acme/widgets&prompt=a%00b%07c%1Bd%7Fe%C2%85f', ok('acme/widgets', 'abcdef')],
  ['bidi overrides are stripped', `harnessdesk://new?repo=acme/widgets&prompt=${encodeURIComponent('safe\u202Eevil\u2066x')}`, ok('acme/widgets', 'safeevilx')],
  ['unknown params are ignored', link({ repo: 'acme/widgets', prompt: 'Hi', send: '1', token: 'never-read' }), ok('acme/widgets', 'Hi')],
  ['exactly the prompt cap', link({ repo: 'acme/widgets', prompt: 'x'.repeat(PROMPT_LINK_MAX_PROMPT) }), ok('acme/widgets', 'x'.repeat(PROMPT_LINK_MAX_PROMPT))],
  // Refused.
  ['a return URL', 'harnessdesk://return?token=abc', null],
  ['a return URL with a prompt', link({ repo: 'acme/widgets', prompt: 'Hi' }).replace('//new', '//return'), null],
  ['wrong scheme', 'https://new?repo=acme/widgets&prompt=Hi', null],
  ['wrong host', 'harnessdesk://news?repo=acme/widgets&prompt=Hi', null],
  ['a path', 'harnessdesk://new/send?repo=acme/widgets&prompt=Hi', null],
  ['credentials', 'harnessdesk://jane@new?repo=acme/widgets&prompt=Hi', null],
  ['a port', 'harnessdesk://new:80?repo=acme/widgets&prompt=Hi', null],
  ['a fragment', 'harnessdesk://new?repo=acme/widgets&prompt=Hi#x', null],
  ['no repo', link({ prompt: 'Hi' }), null],
  ['no prompt', link({ repo: 'acme/widgets' }), null],
  ['a blank prompt', link({ repo: 'acme/widgets', prompt: ' \n\t' }), null],
  ['a prompt of only controls', 'harnessdesk://new?repo=acme/widgets&prompt=%00%01', null],
  ['a repeated prompt', 'harnessdesk://new?repo=acme/widgets&prompt=a&prompt=b', null],
  ['a repeated repo', 'harnessdesk://new?repo=a/b&repo=c/d&prompt=Hi', null],
  ['a bare name', link({ repo: 'widgets', prompt: 'Hi' }), null],
  ['a dot-dot segment', link({ repo: 'acme/..', prompt: 'Hi' }), null],
  ['a relative path', link({ repo: './widgets', prompt: 'Hi' }), null],
  ['four segments', link({ repo: 'a/b/c/d', prompt: 'Hi' }), null],
  ['a URL as repo', link({ repo: 'https://acme.dev/widgets', prompt: 'Hi' }), null],
  ['pr zero', link({ repo: 'acme/widgets', prompt: 'Hi', pr: '0' }), null],
  ['pr negative', link({ repo: 'acme/widgets', prompt: 'Hi', pr: '-1' }), null],
  ['pr not a number', link({ repo: 'acme/widgets', prompt: 'Hi', pr: '12a' }), null],
  ['pr huge', link({ repo: 'acme/widgets', prompt: 'Hi', pr: '99999999999' }), null],
  ['flow upper case', link({ repo: 'acme/widgets', prompt: 'Hi', flow: 'Review' }), null],
  ['flow leading dash', link({ repo: 'acme/widgets', prompt: 'Hi', flow: '-review' }), null],
  ['flow too long', link({ repo: 'acme/widgets', prompt: 'Hi', flow: 'a'.repeat(65) }), null],
  ['an oversized prompt', link({ repo: 'acme/widgets', prompt: 'x'.repeat(PROMPT_LINK_MAX_PROMPT + 1) }), null],
  ['an oversized URL', `harnessdesk://new?repo=acme/widgets&prompt=Hi&pad=${'x'.repeat(PROMPT_LINK_MAX_URL)}`, null],
  ['not a URL', 'not a url', null],
  ['not a string', 42, null],
]

for (const [name, input, expected] of table) {
  test(`prompt link: ${name}`, () => {
    const parsed = parsePromptLink(input)
    assert.deepEqual(parsed === null ? null : { ...parsed }, expected)
  })
}

test('a parsed link is frozen', () => {
  assert.ok(Object.isFrozen(parsePromptLink(link({ repo: 'acme/widgets', prompt: 'Hi' }))))
})

test('argv: only an element starting with harnessdesk://new is read, and only the first', () => {
  const url = link({ repo: 'acme/widgets', prompt: 'One' })
  assert.deepEqual({ ...promptLinkFromArgv(['app.exe', '--flag', url, link({ repo: 'acme/widgets', prompt: 'Two' })]) }, ok('acme/widgets', 'One'))
  assert.equal(promptLinkFromArgv(['app.exe', `--x=${url}`]), null)
  assert.equal(promptLinkFromArgv(['app.exe', 'harnessdesk://return?token=ignored']), null)
  assert.equal(promptLinkFromArgv(undefined), null)
})

const windowRig = () => {
  const sent = []
  const webContents = { send: (...args) => sent.push(args) }
  return { sent, window: { webContents, isDestroyed: () => false } }
}

test('the inbox keeps a link until the app window takes it, then never again', () => {
  let current = null
  const inbox = createPromptLinkInbox({ currentWindow: () => current })
  const first = parsePromptLink(link({ repo: 'acme/widgets', prompt: 'Hi' }))
  inbox.offer(first)
  assert.equal(inbox.pending, first, 'kept before any window exists')
  const { sent, window } = windowRig()
  current = window
  assert.equal(inbox.take({}), null, 'another sender cannot take it')
  assert.equal(inbox.take(window.webContents), first)
  assert.equal(inbox.take(window.webContents), null, 'delivered once')
  assert.deepEqual(sent, [])
  const second = parsePromptLink(link({ repo: 'acme/widgets', prompt: 'Two' }))
  inbox.offer(second)
  assert.deepEqual(sent, [['harnessdesk:prompt-link', null]], 'the nudge carries no link')
  const third = parsePromptLink(link({ repo: 'acme/widgets', prompt: 'Three' }))
  inbox.offer(third)
  assert.equal(inbox.take(window.webContents), third, 'a newer link replaces one not yet taken')
  inbox.offer(null)
  assert.equal(inbox.pending, null)
})
