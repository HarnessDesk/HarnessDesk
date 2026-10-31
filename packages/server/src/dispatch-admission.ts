/** Host-only admission: asynchronous scope proof plus the synchronous fence at
 * the actual effect boundary. The latter must be checked after the last await. */
export type DispatchAdmission<T> = ((value: T) => Promise<void>) & { readonly assertDispatch?: () => void }
