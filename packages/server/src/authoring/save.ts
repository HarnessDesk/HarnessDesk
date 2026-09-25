/**
 * The order of a configuration save, over the confined transaction port.
 *
 * One queue per tree; every source, dependency and the tree's identity
 * checked again inside it; the journal made durable before the first byte is
 * written; then each file written and its checkpoint recorded before the
 * next — new Agents first, the flow that names them after, a trigger file on
 * its own. A failure part-way reports exactly what is known to have landed and
 * stops: nothing already written is taken back, because a rollback is a
 * second write that can fail the same way and would delete a person's file.
 *
 * This proves ordering, not confinement. The port the plane builds is where
 * confinement lives: every read and write it makes goes through the confined
 * tree (`flow-update.ts`'s `confinedWrites`), and its recovery reads disk,
 * never trusts this list alone.
 */

export interface SaveEdit {
  /** The file's path inside its tree: project-relative, or relative to the desk's own folder. */
  readonly path: string
  /** Its exact bytes when previewed; null when the save creates it. */
  readonly before: string | null
  readonly after: string
}

export interface SavePort {
  serialize<T>(run: () => Promise<T>): Promise<T>
  /** Every source, dependency and the tree's identity, checked again under the queue. Throws a sentence. */
  verify(edits: readonly SaveEdit[]): Promise<void>
  /** The journal, durable before anything is written. */
  prepare(edits: readonly SaveEdit[]): Promise<void>
  /** One file, confined and atomic, its own bytes checked just before it lands. */
  write(edit: SaveEdit): Promise<void>
  /** That file's checkpoint, durable before the next file is written. */
  recorded(path: string): Promise<void>
  finish(): Promise<void>
}

export interface SaveOutcome {
  readonly state: 'applied' | 'partial' | 'refused'
  readonly written: readonly string[]
  readonly message: string
}

export async function applySave(port: SavePort, edits: readonly SaveEdit[]): Promise<SaveOutcome> {
  return port.serialize(async () => {
    const written: string[] = []
    try {
      await port.verify(edits)
      await port.prepare(edits)
      for (const edit of edits) {
        await port.write(edit)
        written.push(edit.path)
        await port.recorded(edit.path)
      }
      await port.finish()
      return { state: 'applied', written, message: 'Saved.' }
    } catch (error) {
      return {
        state: written.length === 0 ? 'refused' : 'partial',
        written,
        message: error instanceof Error ? error.message : 'The files could not be saved. Open them to check what changed.',
      }
    }
  })
}
