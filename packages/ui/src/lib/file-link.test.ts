import { expect, it } from 'vitest'
import { sanitizeHtml } from './sanitize'
it('retains relative path:line links while refusing arbitrary schemes and image sources', () => {
  expect(sanitizeHtml('<a href="src/file.ts:12">file</a>')).toContain('href="src/file.ts:12"')
  expect(sanitizeHtml('<a href="README.md:3">notes</a>')).toContain('href="./README.md:3"')
  expect(sanitizeHtml('<a href="javascript:12">bad</a>')).not.toContain('href')
  expect(sanitizeHtml('<img src="src/file.ts:12">')).not.toContain('src=')
})

it('recognizes local path and file URL lines without treating external schemes as paths', async () => {
  const { fileLink, filePathInRoot } = await import('./file-link')
  for (const href of ['src/file.ts:12', 'file:///work/src/file.ts:12', '/work/src/file.ts#L12']) expect(fileLink(href)?.line).toBe(12)
  for (const href of ['https://example.com/file.ts:12', 'javascript:12', 'file://example.com/work/file.ts:12', 'src/file.ts:0', 'src/file.ts:99999999999999999', '/work/bad%00.ts:2']) expect(fileLink(href)).toBeNull()
  expect(filePathInRoot('./src/file.ts', '/work/tree')).toBe('/work/tree/src/file.ts')
  expect(filePathInRoot('../other/file.ts', '/work/tree')).toBeNull()
  expect(filePathInRoot('/work/other/file.ts', '/work/tree')).toBeNull()
})

it('supports conventional bare extensionless filenames without exposing their colon as a URL scheme', async () => {
  const { fileLink } = await import('./file-link')
  expect(fileLink('Makefile:12')).toEqual({ path: 'Makefile', line: 12 })
  expect(fileLink('Dockerfile:3')).toEqual({ path: 'Dockerfile', line: 3 })
  expect(sanitizeHtml('<a href="Makefile:12">build</a>')).toContain('href="./Makefile:12"')
  expect(sanitizeHtml('<a href="javascript:12">bad</a>')).not.toContain('href=')
})

it('decodes a file URL pathname exactly once after URL parsing', async () => {
  const { fileLink } = await import('./file-link')
  for (const [href, path] of [
    ['file:///work/my%20file.ts:12', '/work/my file.ts'],
    ['file:///work/my file.ts:12', '/work/my file.ts'],
    ['file:///work/na%C3%AFve.ts:12', '/work/naïve.ts'],
    ['file:///work/naïve.ts:12', '/work/naïve.ts'],
    ['file:///work/100%25.ts:12', '/work/100%.ts'],
    ['file:///work/literal%2520.ts:12', '/work/literal%20.ts'],
  ]) expect(fileLink(href!)).toEqual({ path, line: 12 })
})
it('normalizes every bare file href into a relative URL, including dotted filenames', () => {
  for (const name of ['README.md', 'zoom.us', 'Makefile']) {
    const host = document.createElement('div'); host.innerHTML = sanitizeHtml(`<a href="${name}:3">file</a>`)
    const href = host.querySelector('a')!.getAttribute('href')!
    expect(href).toBe(`./${name}:3`)
    expect(new URL(href, 'http://127.0.0.1:5273/').protocol).toBe('http:')
  }
})
