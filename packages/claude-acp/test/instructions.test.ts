import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withInstructions } from '../src/bridge.js'

/**
 * The desk's standing instruction, folded into Claude Code's own instruction
 * layer. Three cases, and the one that matters most is the one that must do
 * nothing: a client that supplied a whole system prompt of its own keeps it
 * to the letter.
 */

const sentence = 'Use the pr_create tool rather than gh.'

test('with nothing else asked, the sentence becomes the append to the preset prompt', () => {
  const out = withInstructions({ cwd: '/w', _meta: { harnessdesk: { instructions: sentence } } })
  assert.deepEqual(out._meta, { harnessdesk: { instructions: sentence }, systemPrompt: { append: sentence } })
})

test('an append the client already asked for keeps its own text, and the sentence follows it', () => {
  const out = withInstructions({
    cwd: '/w',
    _meta: { harnessdesk: { instructions: sentence }, systemPrompt: { append: 'Answer in French.' } },
  })
  assert.deepEqual(out._meta?.['systemPrompt'], { append: `Answer in French.\n\n${sentence}` })
})

test('a whole custom prompt is never touched, and no sentence means no change', () => {
  const custom = { cwd: '/w', _meta: { harnessdesk: { instructions: sentence }, systemPrompt: 'You are a poet.' } }
  assert.equal(withInstructions(custom), custom, 'the same object back: nothing was rebuilt')
  const silent = { cwd: '/w', _meta: { harnessdesk: { options: { effort: 'high' } } } }
  assert.equal(withInstructions(silent), silent)
  const blank = { cwd: '/w', _meta: { harnessdesk: { instructions: '   ' } } }
  assert.equal(withInstructions(blank), blank)
  const bare = { cwd: '/w', _meta: undefined }
  assert.equal(withInstructions(bare), bare)
})
