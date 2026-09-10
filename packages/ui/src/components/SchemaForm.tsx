import { useCallback, useMemo, useState } from 'react'

import type { JsonSchema } from '@harnessdesk/protocol'

import { Btn, Input, kit, Note, Row, Rows, Segmented, Toggle } from '../design/primitives/Kit'
import styles from './SchemaForm.module.css'

/**
 * A form from a JSON Schema.
 *
 * Deliberately narrow: object schemas with string, number, boolean, and enum
 * properties, plus arrays of strings. A plugin whose configuration needs more
 * than that should ship its own settings panel through `ctx.ui` — pretending to
 * support arbitrary schemas would produce forms nobody could use.
 *
 * Anything unsupported is shown read-only rather than dropped, so a plugin's
 * configuration is never silently unreachable.
 */

interface Property {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly type: 'string' | 'number' | 'boolean' | 'enum' | 'stringArray' | 'unsupported'
  readonly options?: readonly string[]
  readonly required: boolean
  /**
   * What the plugin uses when the field is left alone, shown as the field's
   * placeholder — so an untouched setting reads as what it is rather than as
   * empty, and clearing it is visibly a different act from never touching it.
   */
  readonly fallback?: string
}

const readProperties = (schema: JsonSchema | undefined): Property[] => {
  if (!schema || typeof schema !== 'object') return []
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  if (!properties || typeof properties !== 'object') return []
  const required = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: string[] }).required as string[])
      : [],
  )

  return Object.entries(properties).map(([key, raw]) => {
    const entry = (raw ?? {}) as {
      type?: string
      title?: string
      description?: string
      enum?: unknown[]
      items?: { type?: string }
      default?: unknown
    }
    const title = entry.title ?? key
    const base = {
      key,
      title,
      ...(entry.description ? { description: entry.description } : {}),
      required: required.has(key),
      ...(typeof entry.default === 'string' || typeof entry.default === 'number'
        ? { fallback: String(entry.default) }
        : {}),
    }
    if (Array.isArray(entry.enum)) {
      return { ...base, type: 'enum' as const, options: entry.enum.map(String) }
    }
    if (entry.type === 'boolean') return { ...base, type: 'boolean' as const }
    if (entry.type === 'number' || entry.type === 'integer') {
      return { ...base, type: 'number' as const }
    }
    if (entry.type === 'string') return { ...base, type: 'string' as const }
    if (entry.type === 'array' && entry.items?.type === 'string') {
      return { ...base, type: 'stringArray' as const }
    }
    return { ...base, type: 'unsupported' as const }
  })
}

export const SchemaForm = ({
  schema,
  value,
  onSubmit,
}: {
  schema: JsonSchema | undefined
  value: Readonly<Record<string, unknown>>
  onSubmit: (next: Record<string, unknown>) => void
}) => {
  const properties = useMemo(() => readProperties(schema), [schema])
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...value })
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(value),
    [draft, value],
  )

  const set = useCallback((key: string, next: unknown) => {
    setDraft((current) => ({ ...current, [key]: next }))
  }, [])

  if (properties.length === 0) {
    return <Note>This plugin has nothing to configure.</Note>
  }

  return (
    <>
      <Rows>
        {properties.map((property) => (
          <Row
            key={property.key}
            title={
              <>
                {property.title}
                {property.required && ' *'}
              </>
            }
            {...(property.description ? { desc: property.description } : {})}
            control={
              property.type === 'boolean' ? (
                <Toggle
                  label={property.title}
                  on={Boolean(draft[property.key])}
                  onChange={(next) => set(property.key, next)}
                />
              ) : property.type === 'enum' ? (
                <Segmented
                  label={property.title}
                  value={String(draft[property.key] ?? '')}
                  options={(property.options ?? []).map((option) => ({ value: option, label: option }))}
                  onChange={(next) => set(property.key, next)}
                />
              ) : property.type === 'string' ? (
                <Input
                  className={styles.text}
                  aria-label={property.title}
                  {...(property.fallback !== undefined ? { placeholder: property.fallback } : {})}
                  value={String(draft[property.key] ?? '')}
                  onChange={(event) => set(property.key, event.target.value)}
                />
              ) : property.type === 'number' ? (
                <Input
                  className={styles.number}
                  aria-label={property.title}
                  type="number"
                  {...(property.fallback !== undefined ? { placeholder: property.fallback } : {})}
                  value={String(draft[property.key] ?? '')}
                  onChange={(event) =>
                    set(
                      property.key,
                      event.target.value === '' ? undefined : Number(event.target.value),
                    )
                  }
                />
              ) : property.type === 'stringArray' ? (
                <Input
                  className={styles.text}
                  aria-label={property.title}
                  placeholder="Comma separated"
                  value={(Array.isArray(draft[property.key])
                    ? (draft[property.key] as string[])
                    : []
                  ).join(', ')}
                  onChange={(event) =>
                    set(
                      property.key,
                      event.target.value
                        .split(',')
                        .map((entry) => entry.trim())
                        .filter(Boolean),
                    )
                  }
                />
              ) : (
                <span className={kit.wire}>{JSON.stringify(draft[property.key] ?? null)}</span>
              )
            }
          />
        ))}
      </Rows>
      <div className={styles.foot}>
        <Btn variant="primary" disabled={!dirty} onClick={() => onSubmit(draft)}>
          Apply and reload
        </Btn>
      </div>
    </>
  )
}
