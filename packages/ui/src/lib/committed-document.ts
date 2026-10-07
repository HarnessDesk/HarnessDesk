import { splitByFile } from './diff'

/** A document a card committed: where it is, and its complete words at that revision. */
export interface CommittedDocument {
  path: string
  text: string
}
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i

/** The single prose file a diff writes. Its content is read separately at the recorded revision. */
export const documentPath = (diff: string): string | null => {
  const files = splitByFile(diff)
  return files.length === 1 && PROSE.test(files[0]!.path) ? files[0]!.path : null
}
