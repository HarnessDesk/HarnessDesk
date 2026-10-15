import { expect, it } from 'vitest'

import { views } from './views'
import './builtins'

import browserPane from '../components/BrowserPane.tsx?raw'
import filePane from '../components/FilePane.tsx?raw'
import gitPane from '../components/GitPane.tsx?raw'
import previewPane from '../components/PreviewPane.tsx?raw'
import teamRoomPane from '../components/TeamRoomPane.tsx?raw'
import terminalPane from '../components/TerminalPane.tsx?raw'

const SOURCE = { browser: browserPane, file: filePane, git: gitPane, preview: previewPane, room: teamRoomPane, terminal: terminalPane }
it('fixed tools contain body controls rather than a second frame header or dock actions', () => {
  for (const [kind, source] of Object.entries(SOURCE)) {
    expect(source, kind).not.toContain('<ToolPaneHeader')
    expect(source, kind).not.toContain('<PanelActions')
    if (kind === 'terminal') {
      expect(source).toContain('data-terminal-id={view.terminalId}')
      expect(source).toContain('Close terminal')
    } else if (kind === 'room') expect(source).toContain('useTopBar')
    else if (kind === 'file') expect(source).toContain('<FileView')
    else if (kind === 'preview') expect(source).toContain('<FilePane')
    else expect(source, kind).toContain('<ToolBodyControls')
  }
})
it('native tool bodies remain registered and main still owns its work frame', () => {
  for (const kind of Object.keys(SOURCE)) expect(views.get(kind)?.bare).toBe(true)
  for (const kind of ['conversation', 'board']) expect(views.get(kind)?.ownsChrome ?? false).toBe(false)
})
