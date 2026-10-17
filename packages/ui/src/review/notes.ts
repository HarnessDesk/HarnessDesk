import { useSyncExternalStore } from 'react'

/**
 * Review notes: a pin on one scene, at one point of its window, with what was
 * there and what the reviewer said about it.
 *
 * Kept in this browser's storage and handed on as Markdown or JSON — the form
 * an issue, a pull request comment or an agent's brief takes — so a review
 * leaves the board as a list someone can act on, element by element.
 */
export type Note = {
  readonly id: string
  readonly scene: string
  readonly theme: 'light' | 'dark'
  /** Window coordinates, in CSS pixels of the scene's own window. */
  readonly x: number
  readonly y: number
  readonly element: string | null
  readonly path: string | null
  readonly text: string
  readonly done: boolean
  readonly at: number
}

const KEY = 'hd-review-notes'
let notes: Note[] = (() => {
  try { return JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as Note[] } catch { return [] }
})()
const listeners = new Set<() => void>()
const commit = (next: Note[]) => {
  notes = next
  try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* not kept past this tab */ }
  for (const listener of listeners) listener()
}

export const useNotes = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => notes)

export const addNote = (note: Omit<Note, 'id' | 'text' | 'done' | 'at'>): Note => {
  const made: Note = { ...note, id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: '', done: false, at: Date.now() }
  commit([...notes, made])
  return made
}
export const updateNote = (id: string, patch: Partial<Pick<Note, 'text' | 'done' | 'element' | 'path'>>) =>
  commit(notes.map((one) => (one.id === id ? { ...one, ...patch } : one)))
export const removeNote = (id: string) => commit(notes.filter((one) => one.id !== id))

/** The review as Markdown: one section per scene, one numbered item per note. */
export const notesMarkdown = (all: readonly Note[], titleOf: (scene: string) => string) => {
  const byScene = new Map<string, Note[]>()
  for (const note of all) byScene.set(note.scene, [...(byScene.get(note.scene) ?? []), note])
  const lines = ['# Design review', '']
  let n = 0
  for (const [scene, list] of byScene) {
    lines.push(`## ${titleOf(scene)} (\`${scene}\`)`, '')
    for (const note of list) {
      n++
      const where = [note.element ? `\`${note.element}\`` : null, note.path ? `in ${note.path}` : null, `at ${Math.round(note.x)},${Math.round(note.y)}`, note.theme].filter(Boolean).join(' · ')
      lines.push(`${n}. ${note.done ? '~~' : ''}${note.text.trim() || '(no comment)'}${note.done ? '~~' : ''}`, `   ${where}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
