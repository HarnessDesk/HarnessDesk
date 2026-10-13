import { useEffect, useMemo, useRef } from 'react'
import { history } from '@codemirror/commands'
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap'
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, ChangeSet, Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { getOriginalDoc, originalDocChangeEffect, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge'
import {
  EditorView,
  Decoration,
  type DecorationSet,
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
} from './languages'
import { countTextChanges, type ChangeCounts } from './counts'
import { mergeTheme } from './merge-theme'
import type { EditorLineTarget } from './state'
import { rebaseFileChange } from './rebase'

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

// The window owns mode switching, Ask in chat, the Command palette and Go to file.
// Remove their chords, including palette prefixes, from the editing and
// search-panel maps so neither claims the DOM event.
// Search still advances on Enter in its field and F3 in either scope.
const editingKeymap = [...vscodeKeymap, ...searchKeymap].filter((binding) =>
  ![binding.key, binding.mac, binding.win, binding.linux].some((key) =>
    key !== undefined && /^(?:Mod|Cmd|Ctrl)-(?:[glp]$|k(?:\s|$))/i.test(key),
  ),
)

/** Marks a transaction as the app's own, so `onChange` can ignore it. */
const Sync = Annotation.define<boolean>()

export interface EditorSelection {
  readonly source: string
  readonly from: number
  readonly to: number
  readonly rect: DOMRect | null
}

const markLinkedLine = StateEffect.define<number>()
const linkedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, transaction) => {
    marks = marks.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(markLinkedLine)) marks = Decoration.set([Decoration.line({ class: 'cm-linkedLine' }).range(effect.value)])
    return marks
  },
  provide: field => EditorView.decorations.from(field),
})

export interface CodeViewProps {
  readonly value: string
  readonly lineTarget?: EditorLineTarget
  readonly onLineTargetReached?: (request: number) => void
  /** Absolute or relative; only its final segment picks the grammar. */
  readonly path?: string | null
  /** Overrides the grammar `path` implies — a fence language, mostly. */
  readonly language?: string | null
  readonly readOnly?: boolean
  readonly dark: boolean
  readonly look: EditorLook
  readonly lineNumbers?: boolean
  readonly wrap?: boolean
  readonly minimap?: boolean
  readonly tabSize?: number
  /**
   * Lines someone else wants marked — a plugin's diagnostics, a review's
   * findings. Drawn by the lint layer, so they underline, hover and list.
   */
  readonly decorations?: readonly UiDecoration[]
  /** Full value for simple consumers; applyTo rebases actual edits onto a shared peer document. */
  readonly onChange?: (value: string, applyTo: (latest: string) => string) => void
  readonly onSelection?: (selection: EditorSelection | null) => void
  /** Cmd/Ctrl+S. The pane decides what saving means; the editor only reports it. */
  readonly onSave?: () => void
  readonly ariaLabel?: string
  readonly className?: string
}

interface EditorSurfaceProps extends CodeViewProps {
  readonly original?: string
  readonly onCountsChange?: (counts: ChangeCounts) => void
}

/** Internal shared engine; the public CodeView and MergeView choose its mode. */
export const EditorSurface = ({
  value,
  lineTarget,
  onLineTargetReached,
  path = null,
  language = null,
  readOnly = false,
  dark,
  look: appearance,
  lineNumbers: showLineNumbers = true,
  wrap = false,
  minimap = false,
  tabSize = 2,
  decorations,
  onChange,
  onSelection,
  onSave,
  ariaLabel,
  className,
  original,
  onCountsChange,
}: EditorSurfaceProps) => {
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
    minimap: new Compartment(),
    tab: new Compartment(),
    save: new Compartment(),
  }).current

  // Held in refs so the keymap and update listener — installed once, at
  // creation — always call the current prop rather than the one that existed
  // when the view was built.
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const reportSelection = (current: EditorView): void => {
    // Removed text is a native widget selection, not a range in the current
    // document. FileView owns its quote and refreshes its geometry on scroll.
    const native = current.dom.ownerDocument.getSelection()
    const anchor = native?.anchorNode
    const deleted = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('.cm-deletedChunk')
    if (native && !native.isCollapsed && deleted && current.dom.contains(deleted)
      && native.focusNode && current.dom.contains(native.focusNode)) return
    const { from, to, empty } = current.state.selection.main
    if (empty) { onSelectionRef.current?.(null); return }
    const at = current.coordsAtPos(from)
    onSelectionRef.current?.({ source: current.state.doc.toString(), from, to, rect: at ? new DOMRect(at.left, at.top, at.right - at.left, at.bottom - at.top) : null })
  }

  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  const onCountsRef = useRef(onCountsChange)
  onCountsRef.current = onCountsChange
  const lastCounts = useRef('')
  const reportCounts = (state: EditorState): void => {
    if (original === undefined) return
    const counts = countTextChanges(getOriginalDoc(state).toString(), state.doc.toString())
    const key = `${counts.added}:${counts.removed}`
    if (key === lastCounts.current) return
    lastCounts.current = key
    onCountsRef.current?.(counts)
  }

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
        ...(original === undefined ? [] : [
          unifiedMergeView({ original, mergeControls: false, gutter: true }),
          mergeTheme,
        ]),
        compartments.gutter.of(gutterExtension),
        linkedLine,
        EditorView.theme({ '.cm-linkedLine': { backgroundColor: 'var(--hd-accent-dim)' } }),
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
        compartments.minimap.of([]),
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
        keymap.of(editingKeymap),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) reportSelection(update.view)
          if (update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(updateOriginalDoc)))) {
            reportCounts(update.state)
          }
          if (!update.docChanged) return
          if (update.transactions.some((transaction) => transaction.annotation(Sync))) return
          const before = update.startState.doc.toString(), value = update.state.doc.toString(), changes = update.changes
          onChangeRef.current?.(value, latest => rebaseFileChange(before, value, latest, changes))
        }),
        EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      ],
    })

    const created = new EditorView({ state, parent })
    view.current = created
    const scrolled = () => reportSelection(created)
    created.scrollDOM.addEventListener('scroll', scrolled)
    return () => {
      created.scrollDOM.removeEventListener('scroll', scrolled)
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

  // A request is transient, and deliberately independent of value changes.
  useEffect(() => {
    const current = view.current
    if (!current || !lineTarget) return
    const line = current.state.doc.line(Math.max(1, Math.min(current.state.doc.lines, lineTarget.line)))
    current.dispatch({ selection: { anchor: line.from }, effects: [markLinkedLine.of(line.from), EditorView.scrollIntoView(line.from, { y: 'center' })] })
    onLineTargetReached?.(lineTarget.request)
  }, [lineTarget])

  useEffect(() => {
    const current = view.current
    if (!current || original === undefined) return
    const previous = getOriginalDoc(current.state)
    if (previous.toString() === original) return
    current.dispatch({ effects: originalDocChangeEffect(current.state,
      ChangeSet.of({ from: 0, to: previous.length, insert: original }, previous.length)),
    })
  }, [original])

  useEffect(() => {
    const current = view.current
    if (!current || original === undefined) return
    const counts = countTextChanges(getOriginalDoc(current.state).toString(), current.state.doc.toString())
    lastCounts.current = `${counts.added}:${counts.removed}`
    onCountsChange?.(counts)
  }, [onCountsChange])

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
    const current = view.current
    if (!current) return
    if (!minimap) {
      current.dispatch({ effects: compartments.minimap.reconfigure([]) })
      return
    }
    let cancelled = false
    void import('@replit/codemirror-minimap').then(({ showMinimap }) => {
      // A closed pane or a newer off choice owns the result of a late load.
      if (cancelled || view.current !== current) return
      current.dispatch({ effects: compartments.minimap.reconfigure([
        showMinimap.of({
          create: () => ({ dom: current.dom.ownerDocument.createElement('div') }),
          displayText: 'blocks',
        }),
        EditorView.theme({
          '.cm-minimap-gutter': { backgroundColor: 'var(--hd-background)' },
          '.cm-minimap-overlay': { background: 'var(--hd-foreground)' },
          '.cm-minimap-box-shadow': { boxShadow: 'none' },
        }),
      ]) })
    }).catch(() => {
      // An unavailable optional chunk leaves the primary editor usable.
      // No state is replaced; toggling off and on can request it again.
    })
    return () => { cancelled = true }
  }, [compartments, minimap])

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

export const CodeView = (props: CodeViewProps) => <EditorSurface {...props} />
