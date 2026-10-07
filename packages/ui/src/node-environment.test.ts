import { describe, expect, test } from 'vitest'

import { NODE_TESTS } from '../vitest.node-tests.ts'

/**
 * The files `vitest.node-tests.ts` runs without a DOM.
 *
 * A test that needs a DOM fails there on its own, loudly. The quiet failure is
 * the other one: code that asks whether a DOM exists and takes a different
 * road without it. The test still passes, and no longer proves the road it
 * was written for — so nothing a listed file imports may ask.
 *
 * The sources are read through Vite (`?raw`), not the filesystem: nothing in
 * the renderer imports a `node:` builtin, and this file is the renderer's.
 */

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx,js,mjs}', { query: '?raw', import: 'default', eager: true })

// A branch on the presence of a DOM or its storage: `typeof window`,
// `'document' in`, `window?.`, `window && …`, `if (!document)`.
const ASKS_FOR_A_DOM =
  /typeof\s+(?:window|document|localStorage|sessionStorage|navigator|requestAnimationFrame|matchMedia|self)\b|['"](?:window|document|localStorage|navigator)['"]\s+in\s|globalThis\.(?:window|document|localStorage|navigator)\b|\b(?:window|document)\?\.|\b(?:window|document|localStorage|sessionStorage|navigator)\s*(?:&&|\|\||\?\?)|if\s*\(\s*!?\s*(?:window|document|localStorage|sessionStorage|navigator)\s*\)/

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g

/** The key a specifier names in `sources`, or null: a package, a stylesheet, a `?raw` import (text, not code that runs). */
const resolveImport = (from: string, specifier: string): string | null => {
  if (specifier.includes('?')) return null
  const path = specifier.startsWith('@/') ? `/src/${specifier.slice(2)}` : specifier.startsWith('.') ? new URL(specifier, `file://${from}`).pathname : null
  if (!path) return null
  const base = path.replace(/\.js$/, '')
  return [path, `${base}.ts`, `${base}.tsx`, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`].find((key) => key in sources) ?? null
}

/** The file and everything it imports from this package, through `@/` and relative paths alike. */
const closure = (file: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(file) || !(file in sources)) return seen
  seen.add(file)
  for (const [, specifier] of (sources[file] ?? '').matchAll(IMPORT)) {
    const found = specifier ? resolveImport(file, specifier) : null
    if (found) closure(found, seen)
  }
  return seen
}

describe('the files that run in Node', () => {
  test('are each a real test file, named once', () => {
    expect(new Set(NODE_TESTS).size).toBe(NODE_TESTS.length)
    for (const name of NODE_TESTS) {
      expect(name, name).toMatch(/^src\/.*\.test\.ts$/)
      expect(`/${name}` in sources, `${name} is gone: take it off the list`).toBe(true)
    }
  })

  test('import nothing that asks whether there is a DOM', () => {
    const asking: string[] = []
    for (const name of NODE_TESTS) {
      for (const file of closure(`/${name}`)) {
        if (file !== `/${name}` && /\.test\.tsx?$/.test(file)) continue
        const found = (sources[file] ?? '').match(ASKS_FOR_A_DOM)
        if (found) asking.push(`${name} → ${file.slice(1)}: ${found[0].replace(/\s+/g, ' ')}`)
      }
    }
    expect(asking, 'these would take their no-DOM branch here; take the test off the list').toEqual([])
  })

  test('the walk finds what a test imports', () => {
    // A walk that found nothing would pass the test above without looking.
    const reached = closure('/src/lib/team-seats.test.ts')
    expect(reached.size).toBeGreaterThan(1)
    expect([...reached].some((file) => file.startsWith('/src/lib/') && !file.endsWith('.test.ts'))).toBe(true)
  })

  test('the pattern sees what it is for', () => {
    for (const asks of ['typeof window === "undefined"', "typeof document !== 'undefined'", 'window?.matchMedia', "'document' in globalThis", 'if (!localStorage) return']) {
      expect(ASKS_FOR_A_DOM.test(asks), asks).toBe(true)
    }
    for (const plain of ['const window = 1', 'a window of time', 'documentation', 'const documents = []']) {
      expect(ASKS_FOR_A_DOM.test(plain), plain).toBe(false)
    }
  })
})
