import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ownsStylesheet, stylesheetImports } from './lib/stylesheet-imports.mjs'

test('a stylesheet import is read whatever its file is called', () => {
  // #91: letters alone skipped seven stylesheets, panel-playground.module.css among them.
  const source = [
    "import styles from './panel-playground.module.css'",
    "import board from './rail_board2.module.css'",
    "import plain from './Composer.module.css'",
    // Either quote, the same one at both ends (review of #183).
    'import quoted from "./double-quoted.module.css"',
    `import odd from './mismatched.module.css"`,
    "import other from '../elsewhere.module.css'",
    "import data from './data.json'",
  ].join('\n')
  assert.deepEqual(stylesheetImports(source), [
    { binding: 'styles', file: 'panel-playground.module.css' },
    { binding: 'board', file: 'rail_board2.module.css' },
    { binding: 'plain', file: 'Composer.module.css' },
    { binding: 'quoted', file: 'double-quoted.module.css' },
  ])
})

test("a component's own stylesheet is its own, whichever way the name is spelled", () => {
  // #91: compared as written, panel-playground.module.css was another screen's
  // stylesheet to PanelPlayground.tsx, and seven showcase boards counted as
  // component libraries.
  assert.equal(ownsStylesheet('design/showcase/PanelPlayground.tsx', 'panel-playground.module.css'), true)
  assert.equal(ownsStylesheet('components/Composer.tsx', 'Composer.module.css'), true)
  assert.equal(ownsStylesheet('design/explorer/boards.tsx', 'explorer.module.css'), true)
  assert.equal(ownsStylesheet('components/BrowserPane.tsx', 'ToolPanes.module.css'), false)
  assert.equal(ownsStylesheet('design/showcase/RailBoard.tsx', 'panel-playground.module.css'), false)
  // An underscore is the other separator a file name uses (review of #183).
  assert.equal(ownsStylesheet('design/showcase/RailBoard2.tsx', 'rail_board2.module.css'), true)
})

test('a commented-out import is not an import', () => {
  // Review of #183: imports were read from the raw source, comments and all.
  const source = [
    "// import gone from './line-comment.module.css'",
    "/* import also from './block-comment.module.css' */",
    "import kept from './kept.module.css'",
  ].join('\n')
  assert.deepEqual(stylesheetImports(source), [{ binding: 'kept', file: 'kept.module.css' }])
})
