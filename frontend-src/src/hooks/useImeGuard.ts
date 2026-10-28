import { useRef } from 'react'

export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }, composing = false) {
  return composing || event.isComposing === true || event.keyCode === 229
}

/** Composition flags and keyCode 229 cover differing browser event order. */
export function useImeGuard() {
  const composing = useRef(false)
  return {
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false },
    isComposing: (event: { isComposing?: boolean; keyCode?: number }) => isComposingKey(event, composing.current),
  }
}
