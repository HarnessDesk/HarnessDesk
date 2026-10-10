import assert from 'node:assert/strict'
import { test } from 'node:test'

import { wallHtml, wallOf } from './frame-wall.mjs'

test('frames group by destination, then width, then theme', () => {
  const wall = wallOf(['team-board-720-dark.png', 'team-board-1440-light.png', 'conversation-1440-light.png', 'notes.txt'])
  assert.deepEqual(wall.map((row) => row.destination), ['conversation', 'team-board'])
  assert.deepEqual(wall[1].widths.map((one) => one.width), [1440, 720])
  assert.deepEqual(wall[1].widths[1].themes, { dark: 'team-board-720-dark.png' })
})

test('the page shows every frame, and its earlier frame beside it when given', () => {
  const html = wallHtml(wallOf(['draft-1100-light.png']), { before: 'before' })
  assert.match(html, /<img[^>]+src="draft-1100-light\.png"/)
  assert.match(html, /<img[^>]+src="before\/draft-1100-light\.png"/)
  assert.match(html, /<h2>draft<\/h2>/)
})
