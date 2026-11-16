/** Numeric/boolean readiness only: no transcript text leaves the renderer. */
export const conversationState = document => {
  const headers = [...document.querySelectorAll('[data-slot="turn-work-header"]')]
  const finished = headers.filter(head => /^Worked(?:\s|$)/.test((head.querySelector('[data-state=done]')?.textContent ?? '').trim()))
  const head = finished.at(-1)
  return {
    headers: headers.length,
    finished: finished.length,
    expanded: head?.getAttribute('aria-expanded') === 'true',
    answer: (document.body.innerText ?? '').includes('502 is retryable alongside 503 and 504 now'),
  }
}

