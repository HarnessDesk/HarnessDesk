import { useId, useRef, useState } from 'react'

import type { PlanEntry, PlanSuggestion } from '@harnessdesk/protocol'

import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { NativeSelect } from '../ui/native-select'
import { Dialog } from './ModalDialog'
import { Field, FormStack, Note, Row, Rows, SectionHead, Text } from './Settings'

/** `en-US`'s two-decimal reading — the currency a plan's fee/budget carries. */
const money = (amount: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount)

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export interface PlanCardProps {
  /** This account's own stored fee/budget — never a runtime's single cached report. */
  readonly entry: PlanEntry | null
  /** The one suggestion matching this account's own plan string, when known. `null` once a fee is already set. */
  readonly suggestion: PlanSuggestion | null
  /** `plans.json`'s own read failure (where and why), when the file could not be read. */
  readonly refusal: string | null
  /** A UI choice (`docs/wire.ts`): a key account, a metered one, or one that already has a budget stored. */
  readonly showBudget: boolean
  readonly onSetFee: (amount: number, currency: string, period: 'month' | 'year') => Promise<void>
  readonly onClearFee: () => Promise<void>
  readonly onSetBudget: (amount: number, currency: string) => Promise<void>
  readonly onClearBudget: () => Promise<void>
}

/**
 * A plan's fee and a key or metered account's budget: what a person set,
 * once, from a suggested public price confirmed in one click — never applied
 * on its own (rule: `docs/usage-dashboard.md`'s pricing paragraph).
 *
 * Pure presentation: every fact it draws — `entry`, `suggestion`, `refusal` —
 * is handed in, and every write is a callback. `SettingsAgents.tsx` is the
 * only thing that knows how to ask the host for them; this component would
 * look identical mounted from a fixture on the catalogue board.
 */
export const PlanCard = ({ entry, suggestion, refusal, showBudget, onSetFee, onClearFee, onSetBudget, onClearBudget }: PlanCardProps) => {
  const [editing, setEditing] = useState<'fee' | 'budget' | null>(null)
  const [busy, setBusy] = useState<'clearFee' | 'useSuggestion' | 'clearBudget' | null>(null)
  // Use and Clear write directly, with no dialog of their own to show a
  // failure in — so this is where BLOCKING 2's "the UI catches errors from
  // Use and Clear" lives: a rejected write is caught here and shown as a
  // `Note`, rather than becoming a silent unhandled rejection.
  const [actionError, setActionError] = useState<string | null>(null)
  const feeEditRef = useRef<HTMLButtonElement>(null)
  const budgetEditRef = useRef<HTMLButtonElement>(null)

  const fee = entry?.fee ?? null
  const budget = entry?.budget ?? null

  const clearFee = async (): Promise<void> => {
    setBusy('clearFee')
    setActionError(null)
    try {
      await onClearFee()
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(null)
    }
  }

  const useSuggestion = async (row: PlanSuggestion): Promise<void> => {
    setBusy('useSuggestion')
    setActionError(null)
    try {
      await onSetFee(row.amount, row.currency, row.period)
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(null)
    }
  }

  const clearBudget = async (): Promise<void> => {
    setBusy('clearBudget')
    setActionError(null)
    try {
      await onClearBudget()
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SectionHead name="Plan" />
      {refusal && (
        <Note tone="bad">{`Your set plan prices could not be read: ${refusal}`}</Note>
      )}
      {actionError && <Note tone="bad">{actionError}</Note>}
      <Rows>
        <Row
          title="Plan price"
          {...(fee
            ? { desc: fee.source === 'user' ? 'you set this' : undefined }
            : suggestion
              ? {
                  desc: (
                    <span title={suggestion.sourceUrl}>
                      Suggested from {domainOf(suggestion.sourceUrl)}, checked {suggestion.checkedAt}
                    </span>
                  ),
                }
              : { desc: 'No suggested price for this plan.' })}
          control={
            fee ? (
              <span className="inline-flex items-center gap-x-(--hd-space-2)">
                <Text numeric>{money(fee.amount, fee.currency)} a {fee.period === 'year' ? 'year' : 'month'}</Text>
                <Button ref={feeEditRef} variant="secondary" size="sm" aria-label="Edit plan price" onClick={() => setEditing('fee')}>
                  Edit
                </Button>
                <Button variant="secondary" size="sm" aria-label="Clear plan price" disabled={busy === 'clearFee'} onClick={() => void clearFee()}>
                  {busy === 'clearFee' ? 'Clearing…' : 'Clear'}
                </Button>
              </span>
            ) : suggestion ? (
              <span className="inline-flex items-center gap-x-(--hd-space-2)">
                <Button variant="secondary" size="sm" disabled={busy === 'useSuggestion'} onClick={() => void useSuggestion(suggestion)}>
                  {busy === 'useSuggestion' ? 'Setting…' : `Use ${money(suggestion.amount, suggestion.currency)}/mo`}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEditing('fee')}>Other amount…</Button>
              </span>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setEditing('fee')}>Set price…</Button>
            )
          }
        />
        {showBudget && (
          <Row
            title="Monthly budget"
            desc="Your own spending cap for this account, separate from any plan limit."
            control={
              budget ? (
                <span className="inline-flex items-center gap-x-(--hd-space-2)">
                  <Text numeric>{money(budget.amount, budget.currency)} a month</Text>
                  <Button ref={budgetEditRef} variant="secondary" size="sm" aria-label="Edit monthly budget" onClick={() => setEditing('budget')}>
                    Edit
                  </Button>
                  <Button variant="secondary" size="sm" aria-label="Clear monthly budget" disabled={busy === 'clearBudget'} onClick={() => void clearBudget()}>
                    {busy === 'clearBudget' ? 'Clearing…' : 'Clear'}
                  </Button>
                </span>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setEditing('budget')}>Set budget…</Button>
              )
            }
          />
        )}
      </Rows>
      {editing && (
        <PlanAmountDialog
          kind={editing}
          initial={editing === 'fee' ? fee : budget}
          onClose={() => setEditing(null)}
          onSave={async (amount, currency, period) => {
            if (editing === 'fee') await onSetFee(amount, currency, period)
            else await onSetBudget(amount, currency)
            setEditing(null)
            // The button that opened this dialog is a different element once
            // a value goes from unset to set ("Set price…" becomes Edit), so
            // focus is moved explicitly rather than left wherever the removed
            // button used to be — which is `body`, and silently discards
            // whoever was tabbing through the page.
            const target = editing === 'fee' ? feeEditRef : budgetEditRef
            requestAnimationFrame(() => target.current?.focus())
          }}
        />
      )}
    </>
  )
}

/**
 * The one dialog both plan rows edit through: an amount and a currency, plus
 * a month/year choice for the fee alone — a budget is always monthly.
 */
const PlanAmountDialog = ({
  kind,
  initial,
  onClose,
  onSave,
}: {
  kind: 'fee' | 'budget'
  initial: { amount: number; currency: string; period?: 'month' | 'year' } | null
  onClose: () => void
  onSave: (amount: number, currency: string, period: 'month' | 'year') => Promise<void>
}) => {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '')
  const [currency, setCurrency] = useState(initial?.currency ?? 'USD')
  const [period, setPeriod] = useState<'month' | 'year'>(initial?.period ?? 'month')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = Number(amount)
  const ready = amount.trim() !== '' && Number.isFinite(parsed) && parsed > 0 && /^[A-Za-z]{3}$/.test(currency)

  const save = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await onSave(parsed, currency.toUpperCase(), period)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setBusy(false)
    }
  }

  // The footer's Save button lives outside this element (`Dialog` renders
  // its footer as a sibling of the body, never inside one form), so it
  // joins this form the standard HTML way — a `form` attribute naming this
  // element's `id` — rather than a hidden duplicate submit control. That is
  // what makes Enter, pressed in any field below, submit through the same
  // `save()` the visible button calls.
  const formId = useId()

  return (
    <Dialog
      title={kind === 'fee' ? 'Set the plan price' : 'Set a monthly budget'}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" form={formId} type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <FormStack>
          <Field label="Amount">
            {(control) => (
              <Input
                {...control}
                type="number"
                min="0"
                step="0.01"
                value={amount}
                autoFocus
                onChange={(event) => setAmount(event.target.value)}
              />
            )}
          </Field>
          <Field label="Currency">
            {(control) => (
              <Input
                {...control}
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            )}
          </Field>
          {kind === 'fee' && (
            <Field label="Billed">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={period}
                  onChange={(event) => setPeriod(event.target.value as 'month' | 'year')}
                >
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                </NativeSelect>
              )}
            </Field>
          )}
        </FormStack>
        {error && <Note tone="bad">{error}</Note>}
      </form>
    </Dialog>
  )
}
