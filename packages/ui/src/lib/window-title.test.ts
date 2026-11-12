import { expect, test } from 'vitest'
import { windowTitleOf } from './window-title'

const chat = { title: 'build a game', preview: null }
test('the window is titled after the page in front, not the conversation behind it', () => {
  expect(windowTitleOf({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } }, 'dex', chat)).toBe('Settings')
  expect(windowTitleOf({ kind: 'settings', route: { kind: 'add-runtime' } }, 'dex', chat)).toBe('Settings')
  expect(windowTitleOf({ kind: 'lead' }, 'lex', chat)).toBe('Lex')
  expect(windowTitleOf({ kind: 'lead' }, null, chat)).toBe('Lead')
  expect(windowTitleOf({ kind: 'work', view: { kind: 'empty' } as never }, 'dex', chat)).toBe('build a game')
  expect(windowTitleOf({ kind: 'work', view: { kind: 'empty' } as never }, 'dex', null)).toBe('HarnessDesk')
})
