import { ChangeSet, Text } from '@codemirror/state'
import { diff } from '@codemirror/merge'

/** Lives with the lazy editing engine. Preserve peer insertions while mapping actual edits. */
export const rebaseFileChange = (before: string, value: string, latest: string, changes?: ChangeSet): string => {
  if (before === latest) return value
  const between = (a: string, b: string) => ChangeSet.of(diff(a, b, { scanLimit: 500 }).map(change => ({ from: change.fromA, to: change.toA, insert: b.slice(change.fromB, change.toB) })), a.length)
  return (changes ?? between(before, value)).map(between(before, latest)).apply(Text.of(latest.split('\n'))).toString()
}
