import { useEffect, useMemo, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'

import type { UiDecoration } from '@harnessdesk/protocol'

import {
  applyDecorations,
  diagnosticsExtension,
  languageForPath,
  loadLanguage,
  look,
  type EditorLook,
} from '../lib/editor'

/**
 * A CodeMirror view, as a React component.
 *
 * The bridge between an imperative editor and a declarative tree is where
 * this kind of component usually goes wrong, so the contract is narrow on
 * purpose:
 *
 * - **React owns the props; CodeMirror owns the document.** The view is
 *   created once and reconfigured through compartments. Re-rendering never
 *   rebuilds it, because rebuilding loses the cursor, the scroll position,
 *   the undo history, and the search panel — every piece of state a person
 *   is mid-way through using.
 * - **`value` is a reset, not a binding.** It is written into the document
 *   only when it genuinely differs from what is there, which happens when the
 *   file is reloaded from disk or a save resolves a conflict. Treating it as
 *   a controlled input would fight the editor on every keystroke and drop
 *   characters typed during a round trip.
 * - **Edits made by that sync are annotated**, so `onChange` fires for the
 *   person's edits and not for the app's. Without that, writing the file back
 *   into the editor after a save marks the pane dirty again immediately.
 */

/** Marks a transaction as the app's own, so `onChange` can ignore it. */
const Sync = Annotation.define<boolean>()

export interface CodeEditorProps {
  readonly value: string
  /** Absolute or relative; only its final segment picks the grammar. */
  readonly path?: string | null
  /** Overrides the grammar `path` implies — a fence language, mostly. */
  readonly language?: string | null
  readonly readOnly?: boolean
  readonly dark: boolean
  readonly look: EditorLook
  readonly lineNumbers?: boolean
  readonly wrap?: boolean
  readonly tabSize?: number
  /**
   * Lines someone else wants marked — a plugin's diagnostics, a review's
   * findings. Drawn by the lint layer, so they underline, hover and list.
   */
  readonly decorations?: readonly UiDecoration[]
  readonly onChange?: (value: string) => void
  /** Cmd/Ctrl+S. The pane decides what saving means; the editor only reports it. */
  readonly onSave?: () => void
  readonly ariaLabel?: string
  readonly className?: string
}

export const CodeEditor = ({
  value,
  path = null,
  language = null,
  readOnly = false,
  dark,
  look: appearance,
  lineNumbers: showLineNumbers = true,
  wrap = false,
  tabSize = 2,
  decorations,
  onChange,
  onSave,
  ariaLabel,
  className,
}: CodeEditorProps) => {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)

  // Compartments are the whole reason this component can be cheap: each is a
  // slot in the running configuration that can be swapped without touching
  // the document or the rest of the setup.
  const compartments = useRef({
    language: new Compartment(),
    look: new Compartment(),
    readOnly: new Compartment(),
    gutter: new Compartment(),
    wrap: new Compartment(),
    tab: new Compartment(),
    save: new Compartment(),
  }).current

  // Held in refs so the keymap and update listener — installed once, at
  // creation — always call the current prop rather than the one that existed
  // when the view was built.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  const resolvedLanguage = useMemo(
    () => language ?? languageForPath(path),
    [language, path],
  )

  const gutterExtension = useMemo(
    (): Extension => (showLineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
    [showLineNumbers],
  )

  useEffect(() => {
    const parent = host.current
    if (!parent) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        compartments.gutter.of(gutterExtension),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        diagnosticsExtension(),
        compartments.tab.of([EditorState.tabSize.of(tabSize), indentUnit.of(' '.repeat(tabSize))]),
        compartments.wrap.of(wrap ? EditorView.lineWrapping : []),
        compartments.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        compartments.look.of(look(appearance, dark)),
        compartments.language.of([]),
        // Save is bound ahead of the defaults so Cmd+S reaches the pane
        // rather than the browser's own "save page".
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.()
              return true
            },
          },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (update.transactions.some((transaction) => transaction.annotation(Sync))) return
          onChangeRef.current?.(update.state.doc.toString())
        }),
        EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      ],
    })

    const created = new EditorView({ state, parent })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
    // Created once. Every prop below is applied by its own effect, and
    // listing them here would rebuild the view — losing cursor, scroll,
    // history and search state — on any change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The document, when something other than typing changed it.
  useEffect(() => {
    const current = view.current
    if (!current) return
    const doc = current.state.doc.toString()
    if (doc === value) return
    current.dispatch({
      changes: { from: 0, to: doc.length, insert: value },
      annotations: Sync.of(true),
      // A reload can shorten the file under a cursor that was near its end;
      // clamping keeps the selection valid instead of throwing.
      selection: { anchor: Math.min(current.state.selection.main.anchor, value.length) },
    })
  }, [value])

  // Marks are positions *into the document*, so they are re-applied whenever
  // either changes — and after the sync above, which is why this effect is
  // declared below it rather than beside the other reconfigurations.
  //
  // The dependency is the serialised list, not the array: a parent that
  // rebuilds `[{...}]` each render is the normal case, and comparing by
  // identity would dispatch a transaction on every keystroke of an unrelated
  // prop.
  const markKey = useMemo(() => JSON.stringify(decorations ?? []), [decorations])
  useEffect(() => {
    const current = view.current
    if (!current) return
    applyDecorations(current, JSON.parse(markKey) as UiDecoration[])
  }, [markKey, value])

  useEffect(() => {
    let cancelled = false
    void loadLanguage(resolvedLanguage).then((extension) => {
      // The pane can be closed, or the path changed to another language,
      // while a grammar chunk is in flight.
      if (cancelled || !view.current) return
      view.current.dispatch({
        effects: compartments.language.reconfigure(extension ?? []),
      })
    })
    return () => {
      cancelled = true
    }
  }, [compartments, resolvedLanguage])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.look.reconfigure(look(appearance, dark)) })
  }, [appearance, compartments, dark])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.readOnly.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [compartments, readOnly])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.gutter.reconfigure(gutterExtension) })
  }, [compartments, gutterExtension])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [compartments, wrap])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.tab.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(' '.repeat(tabSize)),
      ]),
    })
  }, [compartments, tabSize])

  return <div ref={host} className={className} data-testid="code-editor" />
}
