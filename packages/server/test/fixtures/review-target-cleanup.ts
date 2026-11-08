/** Resources owned by a review-target case. */
export interface ReviewTargetCleanup {
  release(): void
  disposeHost(): Promise<void>
  disposeKernel(): Promise<void>
  drain(): Promise<void>
  restore(): void
  remove(): Promise<void>
}

export function registerReviewTargetCleanup(after: (fn: () => void | Promise<void>) => void, owned: ReviewTargetCleanup): void {
  after(async () => {
    try { owned.release() } finally {
      try { await owned.disposeKernel() } finally {
        try { await owned.disposeHost() } finally {
          try { await owned.drain() } finally {
            try { owned.restore() } finally { await owned.remove() }
          }
        }
      }
    }
  })
}
