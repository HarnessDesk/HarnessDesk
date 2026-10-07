import { describe, expect, it } from 'vitest'
import { documentPath } from './committed-document'
const added = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+words\n`
describe('documentPath', () => {
  it('identifies a new document and an updated document for an immutable content read', () => {
    expect(documentPath(added('docs/answer.md'))).toBe('docs/answer.md')
    expect(documentPath('diff --git a/docs/answer.md b/docs/answer.md\n--- a/docs/answer.md\n+++ b/docs/answer.md\n@@ -1 +1 @@\n-old\n+new\n')).toBe('docs/answer.md')
  })
  it('keeps spaces and git quoted UTF-8 paths using the shared diff parser', () => {
    expect(documentPath(added('docs/my plan.txt\t'))).toBe('docs/my plan.txt')
    expect(documentPath('diff --git "a/docs/\\303\\251.md" "b/docs/\\303\\251.md"\nnew file mode 100644\n--- /dev/null\n+++ "b/docs/\\303\\251.md"\n@@ -0,0 +1 @@\n+x\n')).toBe('docs/é.md')
  })
  it('accepts prose extensions and declines code and changes to several files', () => {
    for (const name of ['a.md', 'a.MD', 'a.mdx', 'a.markdown', 'a.txt', 'a.rst', 'a.adoc']) expect(documentPath(added(name))).toBe(name)
    expect(documentPath(added('src/a.ts'))).toBeNull()
    expect(documentPath(added('docs/a.md') + added('docs/b.md'))).toBeNull()
    expect(documentPath('')).toBeNull()
  })
})
