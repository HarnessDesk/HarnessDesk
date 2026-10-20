import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('docs/interface.md documents measured title floor at 375px window (#293)', () => {
  const doc = readFileSync(join(root, 'docs/interface.md'), 'utf8')
  // #192 recorded 165px before #143 merged the git chip (adding ~34px + gap),
  // reducing the measured title width to 139px with a repository checkout.
  assert.match(
    doc,
    /at a 375px window it keeps\s+about 139px with a repository checkout/,
  )
  assert.doesNotMatch(doc, /about 165px/)
})

test('Team membership and label weight descriptions match the shipped frame', () => {
  const design = readFileSync(join(root, 'docs/design.md'), 'utf8')
  const contract = readFileSync(join(root, 'docs/interface.md'), 'utf8')
  assert.equal(/interfaces vary a label's weight|member on a team's rail|The rail, Overview and sidebar/.test(design), false, 'design uses the shared label weight and members popover')
  assert.equal(/Agent name card, room rail/.test(contract), false, 'the ceiling appears in the members popover')
  const pane = readFileSync(join(root, 'packages/ui/src/components/TeamRoomPane.tsx'), 'utf8')
  assert.equal(/What the \*rail\* could not do, said on the rail/.test(pane), false, 'member failures belong to their popover')
})

test('both Team references document Work as the default, including a Team without a Run or ready to wrap', () => {
  const section = (path, heading, nextHeading) => {
    const doc = readFileSync(join(root, path), 'utf8')
    const [, body] = doc.split(heading)
    assert.ok(body, `${path} includes ${heading}`)
    return body.split(nextHeading)[0]
  }
  const design = section('docs/design.md', '## The Team overview', '\n## ')
  const contract = section('docs/interface.md', "### A Team's Work", '\n### ')
  for (const reference of [design, contract]) {
    assert.match(reference, /Work opens by default/, 'Work is the unconditional Team default, including ready-to-wrap Teams')
    assert.match(reference, /Team without a Run/, 'Work remains usable without a Run')
    assert.doesNotMatch(reference, /one with neither opens on Chat|A Team without a Run opens on Chat/, 'Chat is an explicit destination rather than the no-Run default')
  }
})

test('the Seat guide holds plugin installation, like Reload, to the selected tool servers', () => {
  const guide = readFileSync(join(root, 'docs/agents.md'), 'utf8').split('### Native server selection')[1].split('\n## ')[0].replace(/\s+/g, ' ')
  assert.match(guide, /across a Reload or a plugin installation/, 'a Seat keeps its tool servers across both changes')
  assert.match(guide, /Both are held while any conversation on the account has selected tool servers/, 'and both are held by them')
})
