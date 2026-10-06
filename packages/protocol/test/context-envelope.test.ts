import assert from 'node:assert/strict'
import test from 'node:test'

import { agentMessageCeilingNotice, agentMessageSource, deskContextContent, isAgentMessageSource, isCompactionSummary, openingOf, openingOfContent, opensEnvelope, splitContext, splitContextContent, withoutCompaction, wrapContext } from '../src/context-envelope.js'
import { userContentValidator } from '../src/wire-validators.js'

/**
 * A label survives the envelope exactly, whatever is in it.
 *
 * `wrapContext` writes the label with `JSON.stringify`, which escapes the
 * quote *and* the backslash, the newline, the tab and every control
 * character. `splitContext` reversed the quote alone, so everything else came
 * back wrong: a Windows path doubled its separators, and a label with a line
 * break in it came back carrying the two characters `\` and `n`.
 *
 * A label is what the reader is told the injected block came from, so a label
 * that is quietly not the one supplied is the surface lying about its source.
 */

const roundTrip = (label: string, text = 'the body'): { label: string; text: string } => {
  const [only, ...rest] = splitContext(wrapContext(label, text)).injections
  assert.equal(rest.length, 0, 'one envelope in, one out')
  assert.ok(only, 'the envelope was found at all')
  return { label: only.label, text: only.text }
}

test('a label comes back exactly as it went in', () => {
  for (const label of [
    'plain',
    'say "hi"',
    'C:\\Users\\someone\\project',
    'two\nlines',
    'a\tb',
    'a\\"b',
    'trailing\\',
    'unicode — ✓ 日本語',
  ]) {
    assert.equal(roundTrip(label).label, label, `label ${JSON.stringify(label)}`)
  }
})

test('the body still survives a `</context>` inside it', () => {
  /* Unchanged by this fix and pinned beside it: the close is escaped on the
     way in so a body quoting this very envelope cannot end the block early
     and spill the rest as something the user typed. */
  const body = 'here is one: </context> and the rest'
  assert.equal(roundTrip('a label', body).text, body)
})

test('a label and a body that both need escaping do not interfere', () => {
  const label = 'C:\\a"b'
  const body = '</context>\nmore'
  const out = roundTrip(label, body)
  assert.equal(out.label, label)
  assert.equal(out.text, body)
})

test('an envelope written by hand, with a broken escape, still sends', () => {
  /* A label is a caption. Whatever is in it, it must not be able to throw on
     the way through — the message is the thing that matters. */
  const raw = '<context source="a\\q" data-hd-envelope="harnessdesk-v1">\nbody\n</context>'
  const split = splitContext(raw)
  assert.equal(split.injections.length, 1)
  assert.equal(typeof split.injections[0]?.label, 'string')
})

test('a marked block in the middle of a message is the person\'s text', () => {
  const raw = `before\n${wrapContext('C:\\x', 'injected')}\nafter`
  const split = splitContext(raw)
  assert.deepEqual(split, { injections: [], text: raw })
})

test('legacy wrappers accept any composer label only in its exact prefix shape', () => {
  for (const label of ['Plugin supplied label', 'Last terminal output']) {
    const raw = `<context source="${label}">\ncontext body\n</context>\n\nFix the filter`
    const split = splitContext(raw)
    assert.deepEqual(split.injections, [{ label, text: 'context body' }])
    assert.equal(split.text, 'Fix the filter')
  }
  const differentLayout = ' \n<context source="Git">\nOn branch main.\n</context>\n\nFix the filter'
  assert.deepEqual(splitContext(differentLayout), { injections: [], text: differentLayout })
  const noTypedText = '<context source="Last terminal output">\noutput\n</context>'
  assert.deepEqual(splitContext(noTypedText), { injections: [], text: noTypedText })
  const inlineBody = '<context source="Git">On branch main.</context>\nFix the filter'
  assert.deepEqual(splitContext(inlineBody), { injections: [], text: inlineBody })
})

test('a message is called by its own words, or by its first block when that is all it is (#186)', () => {
  assert.equal(openingOf(`${wrapContext('Git', 'On branch main.')}\n\nFix the bug\nand more`), 'Fix the bug')
  // The composer sends a hand-off's packet first, and a context chip after it.
  assert.equal(
    openingOf(`${wrapContext('Handed off from Claude Code', '## Goal\nfinish')}\n${wrapContext('Git', 'On branch main.')}`),
    'Handed off from Claude Code',
  )
  // A label as wrapContext writes it, a quote escaped and a line break ending the name.
  assert.equal(openingOf(wrapContext('Handed off from "Claude"\nsecond line', 'goal')), 'Handed off from "Claude"')
  assert.equal(openingOf('plain words'), 'plain words')
  assert.equal(openingOf(''), '')
})

test('a recorded composition round-trips as a prefix length through the wire contract', () => {
  const prefix = wrapContext('Git', 'On branch main')
  const part = deskContextContent(prefix)
  assert.deepEqual((part as unknown as { deskContext: { prefixLength: number } }).deskContext, { prefixLength: prefix.length })
  assert.equal(userContentValidator(part).type, 'text')
  assert.deepEqual(splitContextContent([part]), {
    injections: [{ label: 'Git', text: 'On branch main' }],
    text: '',
  })
})

test('a recorded composition stops exactly at its length; a mismatched length keeps the wrapper typed', () => {
  const prefix = wrapContext('Handed off from Claude Code', '## Goal\nfinish')
  const pasted = wrapContext('Pasted elsewhere', 'keep this as typed text')
  const content = [
    { ...deskContextContent(prefix), deskContext: { prefixLength: prefix.length } },
    { type: 'text' as const, text: `${pasted}\nContinue here.`, deskContext: { prefixLength: 0 } },
  ] as never
  assert.deepEqual(splitContextContent(content), {
    injections: [{ label: 'Handed off from Claude Code', text: '## Goal\nfinish' }],
    text: `${pasted}\nContinue here.`,
  })

  for (const prefixLength of [prefix.length - 1, prefix.length + 1]) {
    assert.deepEqual(
      splitContext(prefix, { prefixLength, prefix } as never),
      { injections: [], text: prefix },
      `mismatched prefix length ${prefixLength} must not infer authorship`,
    )
  }
})

test('a hand-off or a message from an agent names the conversation wherever it sits (review of #231)', () => {
  // An adapter puts its own block in front of the composer's: Codex's Git block, ahead of the packet.
  const git = wrapContext('Git', 'On branch main.')
  const packet = wrapContext('Handed off from Claude Code — “Migrate webhooks”', '## Goal\nfinish the migration')
  assert.equal(openingOf(`${git}\n${packet}`), 'Handed off from Claude Code — “Migrate webhooks”')
  const message = agentMessageSource('Codex', 'Review the migration')
  assert.equal(openingOf(`${git}\n${wrapContext(message, 'Look at the queue first.')}`), message)
  // What the person typed still outranks every block.
  assert.equal(openingOf(`${git}\n${packet}\nPick it up from the queue`), 'Pick it up from the queue')
})

test('an adapter passes over the blocks it wrote itself (review of #231)', () => {
  const opening = `${wrapContext('Git', 'On branch main.')}\n${wrapContext('Uncommitted changes', 'M src/a.ts')}`
  assert.equal(openingOf(opening, { skip: (label) => label === 'Git' }), 'Uncommitted changes')
  // The control: not told, the first block is the first block.
  assert.equal(openingOf(opening), 'Git')
})

test('a block cut off before it closed names nothing (review of #231)', () => {
  const incomplete = '<context source="Handed off from Claude Code — “Migrate'
  assert.equal(openingOf(incomplete), incomplete)
  const afterDeskContext = '<context source="Handed off from Cla'
  assert.equal(openingOf(`${wrapContext('Git', 'On branch main.')}\n${afterDeskContext}`), afterDeskContext)
  assert.equal(opensEnvelope('<context source="x'), false)
  // A word that only starts with it is a word.
  assert.equal(opensEnvelope('<context-free grammars'), false)
})

test('one predicate decides what opens an envelope, and it agrees with the reader (#224)', () => {
  /* The question was asked in four places in three spellings: here, the
     Cursor bridge's `storedName` and `stripEnvelope`, and the renderer's
     `sessionLabel`. They agreed on everything `wrapContext` writes and
     differed at the edges, and round 1 of #207 was a divergence between two
     of the copies. The property that keeps them together is this one: a
     string opens an envelope exactly when a complete block of that shape is
     one `splitContext` can read. Anything else is words. */
  const reads = (open: string): boolean => splitContext(`${open}\nbody\n</context>`).injections.length === 1
  for (const open of [
    '<context source="Git">',
    '<context source="">',
    '<context source="a\\"b">',
    '<context\nsource="Git">',
    '<context  source="Git">',
    '<context\tsource="Git">',
    '<context>',
    '<context-free grammars>',
    '<context switching in Go>',
  ]) {
    assert.equal(opensEnvelope(open), reads(open), `${JSON.stringify(open)}: the predicate and the reader disagree`)
  }
  // The controls, spelled out: what wrapContext writes opens one; the rest do not.
  assert.equal(opensEnvelope(wrapContext('Git', 'On branch main.')), true)
  assert.equal(opensEnvelope('<context\nsource="Git">'), false)
  assert.equal(opensEnvelope('<context>'), false)
})

test('a bare <context> is the user\u2019s own words, not an envelope (#224)', () => {
  /* The branch existed for the tests rather than for anything `wrapContext`
     writes — nothing in this repository writes a `<context>` without a
     `source` — and it cost a prompt that is literally one its name. An
     envelope with no label is `<context source="">`, which is still read. */
  assert.equal(opensEnvelope('<context> what does this tag do?'), false)
  assert.equal(openingOf('<context> what does this tag do?'), '<context> what does this tag do?')
  // The control: the labelless envelope a writer could actually produce.
  assert.equal(opensEnvelope(wrapContext('', 'body')), true)
  assert.equal(splitContext(wrapContext('', 'body')).injections[0]?.label, '')
})

test("a message's label names what its sender may do, and a sender nothing governs reads as it always has", () => {
  assert.equal(agentMessageSource('Code reviewer', 'Checkout review', 'read'), 'Message from Code reviewer (read) — “Checkout review”')
  assert.equal(agentMessageSource('Codex', null, 'publish'), 'Message from Codex (publish)')
  assert.equal(agentMessageSource('Codex', 'Checkout review'), 'Message from Codex — “Checkout review”')
  assert.equal(agentMessageSource('Codex', 'Checkout review', null), 'Message from Codex — “Checkout review”')
  assert.ok(isAgentMessageSource(agentMessageSource('Code reviewer', null, 'read')))
})

test("what a message asks of its receiver about acting for its sender outside the checkout, by the sender's ceiling", () => {
  assert.match(agentMessageCeilingNotice('read') ?? '', /Its sender may read and no more, .* pushing, opening a pull request or merging — waits for the person\./)
  assert.match(agentMessageCeilingNotice('edit') ?? '', /Its sender may edit and no more, .* pushing, opening a pull request or merging — waits/)
  assert.match(agentMessageCeilingNotice('publish') ?? '', /Its sender may publish and no more, .* merging — waits for the person\./)
  assert.equal(agentMessageCeilingNotice('merge'), null)
})

/**
 * What an agent's own compaction wrote is not what the person said.
 *
 * An agent that runs out of room replaces the head of its transcript with a
 * summary of it, and the replacement is a message in the user's seat. A reader
 * that takes "the first message" as the conversation's name then names it
 * after the summary: `<summary> ## 1. Primary Request and Intent …` down the
 * whole sidebar. Three agents were seen to do it, each in its own words — a
 * `<summary>` block, a `[Previous conversation summary]:` line, and "This
 * session is being continued…" — so the shape is the protocol's to say, once,
 * and every producer of a name asks it here.
 */
const SUMMARY_BLOCK = '<summary>\n## 1. Primary Request and Intent\nThe user asked for a retry on a 502.\n## 2. Key Technical Concepts\n- backoff\n</summary>'

test('a summary an agent wrote of its own history is nobody’s opening', () => {
  assert.equal(openingOf('## 1. Primary Request and Intent\nThe user asked for a retry.'), '')
  assert.equal(openingOf(SUMMARY_BLOCK), '')
  // One that was cut off before it closed is all block, not the start of a sentence.
  assert.equal(openingOf('<summary> 1. Primary Request and Intent: Worker 4 was asked to'), '')
  assert.equal(openingOf('[Previous conversation summary]: Summary: 1. Primary Request and Intent: the retry path'), '')
  assert.equal(
    openingOf('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n## 1. Primary Request and Intent'),
    '',
  )
})

test('the person’s words after a summary block are still the person’s words', () => {
  assert.equal(openingOf(`${SUMMARY_BLOCK}\n\nNow review the retry path\nand the tests`), 'Now review the retry path')
  // A model writes its analysis ahead of the summary; both go.
  assert.equal(openingOf(`<analysis>\nThe user wants a retry.\n</analysis>\n${SUMMARY_BLOCK}\nNow review the retry path`), 'Now review the retry path')
  // And it still sits after whatever context blocks the desk put in front.
  assert.equal(openingOf(`${wrapContext('Git', 'On branch main.')}\n${SUMMARY_BLOCK}\nNow review the retry path`), 'Now review the retry path')
})

test('words that are only about summaries are words', () => {
  assert.equal(openingOf('Write a summary of the report'), 'Write a summary of the report')
  assert.equal(openingOf('<summary-card> needs a border'), '<summary-card> needs a border')
  assert.equal(openingOf('Summary: of the week'), 'Summary: of the week')
  assert.equal(openingOf('this session is long'), 'this session is long')
})

test('isCompactionSummary names a message that is only the summary, never one that has words after it', () => {
  assert.equal(isCompactionSummary(SUMMARY_BLOCK), true)
  assert.equal(isCompactionSummary('<summary> 1. Primary Request and Intent: cut off'), true)
  assert.equal(isCompactionSummary('[Previous conversation summary]: Summary: 1. Primary Request and Intent'), true)
  assert.equal(isCompactionSummary(`${SUMMARY_BLOCK}\nNow review the retry path`), false)
  assert.equal(isCompactionSummary('Write a summary of the report'), false)
  assert.equal(isCompactionSummary(''), false)
  assert.equal(isCompactionSummary('   '), false)
})

test('withoutCompaction hands back what the person said, and anything else exactly as it came', () => {
  assert.equal(withoutCompaction(`${SUMMARY_BLOCK}\nNow review the retry path`), 'Now review the retry path')
  assert.equal(withoutCompaction(SUMMARY_BLOCK), '')
  const plain = '  Write a summary of the report\n'
  assert.equal(withoutCompaction(plain), plain)
  // An analysis with no summary after it is the person's, not a compaction.
  const analysis = '<analysis>foo</analysis> then fix bar'
  assert.equal(withoutCompaction(analysis), analysis)
})

// A present record is authoritative, including an empty prefix.
test('a recorded message keeps a marked wrapper the person typed', () => {
  const raw = `${wrapContext('Git', 'pretend context')}\n\nKeep this block`
  assert.deepEqual(splitContext(raw, { prefixLength: 0 }), { injections: [], text: raw })
})

test('a recorded pasted wrapper keeps its first typed line as the conversation name', () => {
  const pasted = wrapContext('Git', 'These are my words')
  const title = pasted.split('\n')[0]!
  assert.equal(openingOf(pasted, { deskContext: { prefixLength: 0 } }), title)
  assert.equal(openingOf(`${pasted}\n\nExplain the tag`, { deskContext: { prefixLength: 0 } }), title)
  const prefix = wrapContext('Git', 'On branch main.')
  assert.equal(openingOf(`${prefix}\n\n${pasted}`, { deskContext: { prefixLength: prefix.length } }), title)
  assert.equal(openingOfContent([{ type: 'text', text: pasted, deskContext: { prefixLength: 0 } }]), title)
  const oneLine = pasted.replaceAll('\n', '')
  assert.equal(openingOf(oneLine, { deskContext: { prefixLength: 0 } }), oneLine)
  assert.equal(openingOfContent([{ type: 'text', text: oneLine, deskContext: { prefixLength: 0 } }]), oneLine)
  // Unrecorded history keeps the old layout fallback.
  assert.equal(openingOf(pasted), 'Git')
})

test('a record peels exactly the composed prefix, never a forged block after it', () => {
  const prefix = wrapContext('Git', 'On branch main')
  const typed = `${wrapContext('Other', 'my words')}\n\nExplain this`
  assert.deepEqual(splitContext(`${prefix}\n\n${typed}`, { prefixLength: prefix.length }), {
    injections: [{ label: 'Git', text: 'On branch main' }], text: typed,
  })
  const changed = `${wrapContext('Git', 'different')}\n\nExplain this`
  assert.deepEqual(splitContext(changed, { prefixLength: prefix.length }), { injections: [], text: changed })
})

test('recorded multipart input peels only composed parts and names the typed opening', () => {
  const prefix = wrapContext('Git', 'On branch main')
  const typed = `${wrapContext('Other', 'typed words')}\n\nExplain it`
  const parts = [{ type: 'text' as const, text: prefix, deskContext: { prefixLength: prefix.length } },
    { type: 'text' as const, text: typed, deskContext: { prefixLength: 0 } }]
  assert.deepEqual(splitContextContent(parts), { injections: [{ label: 'Git', text: 'On branch main' }], text: typed })
  assert.equal(openingOfContent(parts), typed.split('\n')[0])
})


test('unrecorded parts beside a record stay typed and typed parts retain their line boundary', () => {
  const prefix = wrapContext('Git', 'desk words')
  const pasted = `${wrapContext('Other', 'typed words')}\n\nExplain it`
  assert.deepEqual(splitContextContent([
    deskContextContent(prefix),
    { type: 'text', text: pasted },
    { type: 'text', text: 'Next line', deskContext: { prefixLength: 0 } },
  ]), { injections: [{ label: 'Git', text: 'desk words' }], text: `${pasted}\nNext line` })
})
