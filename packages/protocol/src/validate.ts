/**
 * Wire-boundary validation.
 *
 * Small on purpose: the goal is to reject structurally wrong messages before
 * they reach code that assumes the types, not to re-derive TypeScript at
 * runtime. Anything crossing a process boundary goes through here.
 */

export class ValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'ValidationError'
  }
}

export type Validator<T> = (value: unknown, path?: string) => T

const fail = (path: string, message: string): never => {
  throw new ValidationError(path, message)
}

const typeName = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

export const isString: Validator<string> = (value, path = '') =>
  typeof value === 'string' ? value : fail(path, `expected string, got ${typeName(value)}`)

export const isNumber: Validator<number> = (value, path = '') =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(path, `expected finite number, got ${typeName(value)}`)

export const isBoolean: Validator<boolean> = (value, path = '') =>
  typeof value === 'boolean' ? value : fail(path, `expected boolean, got ${typeName(value)}`)

export const isUnknown: Validator<unknown> = (value) => value

export const isObject: Validator<Record<string, unknown>> = (value, path = '') =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(path, `expected object, got ${typeName(value)}`)

export const arrayOf =
  <T>(item: Validator<T>): Validator<T[]> =>
  (value, path = '') => {
    if (!Array.isArray(value)) return fail(path, `expected array, got ${typeName(value)}`)
    return value.map((entry, index) => item(entry, `${path}[${index}]`))
  }

export const recordOf =
  <T>(item: Validator<T>): Validator<Record<string, T>> =>
  (value, path = '') => {
    const source = isObject(value, path)
    const out: Record<string, T> = {}
    for (const [key, entry] of Object.entries(source)) out[key] = item(entry, `${path}.${key}`)
    return out
  }

export const optional =
  <T>(inner: Validator<T>): Validator<T | undefined> =>
  (value, path = '') =>
    value === undefined || value === null ? undefined : inner(value, path)

export const literalUnion =
  <const T extends readonly string[]>(...allowed: T): Validator<T[number]> =>
  (value, path = '') => {
    const text = isString(value, path)
    return (allowed as readonly string[]).includes(text)
      ? (text as T[number])
      : fail(path, `expected one of ${allowed.join(' | ')}, got ${JSON.stringify(text)}`)
  }

/**
 * Validates the listed keys and passes the rest through untouched. Forward
 * compatibility matters more than strictness here: a newer host adding a field
 * must not break an older renderer.
 */
export const shape =
  <T extends Record<string, unknown>>(fields: {
    [K in keyof T]: Validator<T[K]>
  }): Validator<T> =>
  (value, path = '') => {
    const source = isObject(value, path)
    const out: Record<string, unknown> = { ...source }
    for (const key of Object.keys(fields) as (keyof T & string)[]) {
      const validator = fields[key]
      out[key] = validator(source[key], path ? `${path}.${key}` : key)
    }
    return out as T
  }

/** Dispatches on a discriminant field, so unions validate their real branch. */
export const taggedUnion =
  <T extends { readonly [K in D]: string }, D extends string = 'type'>(
    discriminant: D,
    branches: Record<string, Validator<T>>,
  ): Validator<T> =>
  (value, path = '') => {
    const source = isObject(value, path)
    const tag = isString(source[discriminant], path ? `${path}.${discriminant}` : discriminant)
    const branch = branches[tag]
    if (!branch) return fail(path, `unknown ${discriminant} ${JSON.stringify(tag)}`)
    return branch(source, path)
  }

export const parse = <T>(validator: Validator<T>, value: unknown, label = ''): T =>
  validator(value, label)

/** Non-throwing variant for hot paths that log and drop rather than crash. */
export const tryParse = <T>(
  validator: Validator<T>,
  value: unknown,
  label = '',
): { ok: true; value: T } | { ok: false; error: ValidationError } => {
  try {
    return { ok: true, value: validator(value, label) }
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error }
    throw error
  }
}
