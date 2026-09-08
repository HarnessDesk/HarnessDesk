import { expect, it } from 'vitest'

import { views } from './views'
import './builtins'

import browserPane from '../components/BrowserPane.tsx?raw'
import filePane from '../components/FilePane.tsx?raw'
import gitPane from '../components/GitPane.tsx?raw'
import previewPane from '../components/PreviewPane.tsx?raw'
import teamRoomPane from '../components/TeamRoomPane.tsx?raw'
import terminalPane from '../components/TerminalPane.tsx?raw'
import toolPaneHeader from '../components/ToolPaneHeader.tsx?raw'

/**
 * `ownsChrome` is a promise, and this is the only thing that can hold a view
 * to it.
 *
 * A view that claims it gets **no strip above it** when it is alone in its
 * stack: no tabs, and none of the panel's verbs. That is the right trade for
 * the browser, whose own tab row was otherwise drawn under an identical-looking
 * one — but a view that claims it and then does not render `PanelActions` is a
 * panel with no way to move, expand, or close it, and nothing at runtime
 * notices. The registry cannot check it; only the source can.
 *
 * Read as text rather than rendered, for the same reason `composer.parity`
 * is: what is being asserted is that the code *says* something, and mounting
 * five components against five fake hosts to find that out would be a worse
 * test of it.
 */

const SOURCE: Record<string, string> = {
  browser: browserPane,
  file: filePane,
  git: gitPane,
  preview: previewPane,
  room: teamRoomPane,
  terminal: terminalPane,
}

/** Whether a component draws the verbs, directly or through the shared header. */
const drawsThem = (source: string): boolean =>
  source.includes('<PanelActions') || source.includes('<ToolPaneHeader')

it('every view that claims the chrome actually draws it', () => {
  const claiming = views
    .all()
    .filter((definition) => definition.ownsChrome === true)
    .map((definition) => definition.kind)

  expect(claiming.sort()).toEqual(Object.keys(SOURCE).sort())
  for (const kind of claiming) {
    const source = SOURCE[kind]
    expect(source, `${kind} claims ownsChrome but has no source listed here`).toBeDefined()
    expect(drawsThem(source ?? ''), `${kind} claims ownsChrome and draws no PanelActions`).toBe(true)
  }
})

it('and the shared header is where four of the six get them', () => {
  // `ToolPaneHeader` is the frame a file, a preview, a repository and a browser
  // all wear; the terminal has a bar of its own and the room has its top row,
  // and both draw them directly.
  expect(toolPaneHeader).toContain('<PanelActions')
  expect(terminalPane).toContain('<PanelActions')
  expect(teamRoomPane).toContain('<PanelActions')
})

it('a view with nowhere to put them does not claim them', () => {
  // The conversation and the board paint their own frames — `bare` — but
  // neither has a header with room for an expand button, so each keeps the
  // strip. `bare` and `ownsChrome` are different promises and this is the
  // difference.
  //
  // The room was in this list and has left it: its top row is a full-width bar
  // carrying the room's name, its counts and its board-only switch, and the
  // verbs at the end of that row are three fewer things than the strip above
  // it was drawing. Leaving it here meant `Room — <name>` printed over a rail
  // already printing `<name>`.
  for (const kind of ['conversation', 'board']) {
    const definition = views.get(kind)
    expect(definition?.bare, `${kind} should still paint its own frame`).toBe(true)
    expect(definition?.ownsChrome ?? false, `${kind} has nowhere to draw the verbs`).toBe(false)
  }
  expect(views.get('room')?.bare, 'the room still paints its own frame').toBe(true)
})
