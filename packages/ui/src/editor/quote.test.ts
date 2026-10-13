import { expect, it } from 'vitest'
import { quoteSelection, previewSelection } from './quote'

it('quotes a one-based inclusive line range and the file language', () => {
  expect(quoteSelection('src/auth.ts', 'one\ntwo\nthree', 4, 8)).toBe('src/auth.ts:2\n```typescript\ntwo\n```\n')
  expect(quoteSelection('src/auth.ts', 'one\ntwo\nthree', 0, 8)).toBe('src/auth.ts:1–2\n```typescript\none\ntwo\n```\n')
})
it('uses a fence longer than every selected backtick run without changing bytes', () => {
  expect(quoteSelection('README.md', '```js\nx\n```', 0, 11)).toBe('README.md:1–3\n````markdown\n```js\nx\n```\n````\n')
})
it('maps only unique Preview source matches and otherwise quotes the path alone', () => {
  expect(previewSelection('README.md', '# Intro\n\nUnique words here.', 'Unique words')).toBe('README.md:3\n```markdown\nUnique words\n```\n')
  expect(previewSelection('README.md', 'same\nother\nsame', 'same')).toBe('README.md\n```markdown\nsame\n```\n')
  expect(previewSelection('README.md', '**formatted** words', 'formatted words')).toBe('README.md\n```markdown\nformatted words\n```\n')
})
it('does not quote an empty selection or invent a language for unknown extensions', () => {
  expect(quoteSelection('a.unknown', 'abc', 0, 0)).toBeNull()
  expect(quoteSelection('a.unknown', 'abc', 0, 1)).toBe('a.unknown:1\n```\na\n```\n')
})

it('quotes a supported 300 KB selection with many short backtick runs', () => {
  const selected = '`x'.repeat(150_000)
  expect(quoteSelection('large.ts', selected, 0, selected.length)).toBe(`large.ts:1\n\`\`\`typescript\n${selected}\n\`\`\`\n`)
})
