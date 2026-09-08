import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * The class combiner every shadcn component reaches for.
 *
 * `clsx` folds conditionals; `twMerge` resolves conflicts the Tailwind way —
 * the caller's `h-7` beats the component's `h-9` because it came later, which
 * is what lets a screen adjust a primitive without forking it.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))
