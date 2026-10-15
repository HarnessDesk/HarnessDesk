import type { FileDocumentState, FileLiveDocumentState } from './FileView'
export const sameFileDocument = (a: FileLiveDocumentState | null | undefined, b: FileLiveDocumentState | null | undefined): boolean =>
  a === b || !!a && !!b && ('kind' in a || 'kind' in b ? 'kind' in a && 'kind' in b : a.content === b.content && a.pendingCreation === b.pendingCreation
    && a.base.content === b.base.content && a.base.hash === b.base.hash && a.base.truncated === b.base.truncated
    && a.comparison?.content === b.comparison?.content && a.comparison?.hash === b.comparison?.hash && a.comparison?.missing === b.comparison?.missing)
export const isDirtyDocument = (document: FileLiveDocumentState): document is FileDocumentState => !('kind' in document) && (document.pendingCreation || document.content !== document.base.content)
