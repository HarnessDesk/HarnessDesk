import type { FileDocumentState } from './FileView'
export const sameFileDocument = (a: FileDocumentState | null | undefined, b: FileDocumentState | null | undefined): boolean =>
  a === b || !!a && !!b && a.content === b.content && a.pendingCreation === b.pendingCreation
    && a.base.content === b.base.content && a.base.hash === b.base.hash && a.base.truncated === b.base.truncated
    && a.comparison?.content === b.comparison?.content && a.comparison?.hash === b.comparison?.hash && a.comparison?.missing === b.comparison?.missing
export const isDirtyDocument = (document: FileDocumentState): boolean => document.pendingCreation || document.content !== document.base.content
