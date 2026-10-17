import { expect, it } from 'vitest'
import { isChatFolder } from './chats'

it('groups unknown folders and recorded host allocations, including their descendants', () => {
  const folders = ['/data/chats/2026-10-16-ABC123', '/old/2026-10-15-DEF456']
  expect(isChatFolder('', folders)).toBe(true)
  expect(isChatFolder(folders[0]!, folders)).toBe(true)
  expect(isChatFolder(`${folders[0]}/notes`, folders)).toBe(true)
  expect(isChatFolder(folders[1]!, folders)).toBe(true)
  for (const project of ['/data/chats', '/data/chats/project', '/data/chats/2026-10-16-existing', '/data/chats-project']) {
    expect(isChatFolder(project, folders)).toBe(false)
  }
})

it('does not infer ownership from the configured parent or a dated name', () => {
  expect(isChatFolder('/2026-10-16-ABC123', [])).toBe(false)
  expect(isChatFolder('/project', [''])).toBe(false)
})
