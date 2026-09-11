import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bareSource, ownsStylesheet, resolveStylesheet, stylesheetImports } from './lib/stylesheet-imports.mjs'

test('a stylesheet import is read whatever its file is called', () => {
  // #91: letters alone skipped seven stylesheets, panel-playground.module.css among them.
  const source = [
    "import styles from './panel-playground.module.css'",
    "import board from './rail_board2.module.css'",
    "import plain from './Composer.module.css'",
    // Either quote, the same one at both ends (review of #183).
    'import quoted from "./double-quoted.module.css"',
    // Any whitespace between the words, and a dot in the name (round 2 of #183's review).
    "import   spaced   from   './spaced.module.css'",
    "import dotted from './name.sub.module.css'",
    `import odd from './mismatched.module.css"`,
    "import other from '../elsewhere.module.css'",
    // From another folder, by its path (round 3 of #183's review).
    "import piece from './parts/piece.module.css'",
    // Through the UI's alias (round 4).
    "import aliased from '@/components/Other.module.css'",
    "import data from './data.json'",
  ].join('\n')
  assert.deepEqual(stylesheetImports(source), [
    { binding: 'styles', file: 'panel-playground.module.css' },
    { binding: 'board', file: 'rail_board2.module.css' },
    { binding: 'plain', file: 'Composer.module.css' },
    { binding: 'quoted', file: 'double-quoted.module.css' },
    { binding: 'spaced', file: 'spaced.module.css' },
    { binding: 'dotted', file: 'name.sub.module.css' },
    { binding: 'other', file: '../elsewhere.module.css' },
    { binding: 'piece', file: 'parts/piece.module.css' },
    { binding: 'aliased', file: '@/components/Other.module.css' },
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
  // A stylesheet in another folder is another screen's, whatever it's called (round 3).
  assert.equal(ownsStylesheet('components/Sidebar.tsx', '../design/Sidebar.module.css'), false)
  assert.equal(ownsStylesheet('design/showcase/PanelPlayground.tsx', 'parts/panel-playground.module.css'), false)
})

test('a commented-out import is not an import', () => {
  // Review of #183: imports were read from the raw source, comments and all.
  const source = [
    "// import gone from './line-comment.module.css'",
    "/* import also from './block-comment.module.css' */",
    // Round 2: a line comment after code, which bareSource leaves in.
    "const x = 1 // import trailing from './trailing-comment.module.css'",
    "import kept from './kept.module.css'",
  ].join('\n')
  assert.deepEqual(stylesheetImports(source), [{ binding: 'kept', file: 'kept.module.css' }])
})

test('an aliased import is resolved against the UI source before it is compared', () => {
  // Round 4 of #183's review: `@/` imports went unread.
  const src = '/r/packages/ui/src'
  assert.equal(resolveStylesheet(`${src}/components`, '@/components/Sidebar.module.css', src), 'Sidebar.module.css')
  assert.equal(resolveStylesheet(`${src}/components`, '@/design/Kit.module.css', src), '../design/Kit.module.css')
  assert.equal(resolveStylesheet(`${src}/components`, 'Sidebar.module.css', src), 'Sidebar.module.css')
  assert.equal(ownsStylesheet('components/Sidebar.tsx', resolveStylesheet(`${src}/components`, '@/components/Sidebar.module.css', src)), true)
})

test('a trailing line comment is not code, and a URL is', () => {
  // Round 4 of #183's review: `x = 1 // styles.removed` counted as a use of `removed`.
  assert.equal(bareSource('const x = 1 // styles.removed'), 'const x = 1 ')
  assert.equal(bareSource("const url = 'https://example.com/a' // a link"), "const url = 'https://example.com/a' ")
  assert.equal(bareSource('<p>see http://example.com</p>'), '<p>see http://example.com</p>')
})
