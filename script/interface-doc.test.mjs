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

test('both Overview references include the ready-to-wrap default without a Run', () => {
  const design = readFileSync(join(root, 'docs/design.md'), 'utf8').split('## The Team overview')[1].split('\n## ')[0]
  const contract = readFileSync(join(root, 'docs/interface.md'), 'utf8').split("### A Team's Overview")[1].split('\n### ')[0]
  for (const reference of [design, contract]) {
    assert.equal(/(?:Run|there)[\s\S]{0,100}ready to wrap/.test(reference), true, 'Overview also opens for a Team ready to wrap')
    assert.equal(/A Team without a Run opens on Chat/.test(reference), false, 'the later Chat description keeps the ready-to-wrap exception')
  }
})

test('the Seat guide holds plugin installation, like Reload, to the selected tool servers', () => {
  const guide = readFileSync(join(root, 'docs/agents.md'), 'utf8').split('### Native server selection')[1].split('\n## ')[0].replace(/\s+/g, ' ')
  assert.match(guide, /across a Reload or a plugin installation/, 'a Seat keeps its tool servers across both changes')
  assert.match(guide, /Both are held while any conversation on the account has selected tool servers/, 'and both are held by them')
})
