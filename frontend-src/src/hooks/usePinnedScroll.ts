import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Follow new output only while the reader has kept the viewport pinned. */
export function usePinnedScroll(revision: unknown, contextKey: string) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lastInput = useRef(-Infinity)
  const context = useRef(contextKey)
  const frame = useRef(0)
  const [showJump, setShowJump] = useState(false)

  const follow = useCallback(() => {
    cancelAnimationFrame(frame.current)
    if (!pinned.current || performance.now() - lastInput.current < 150) return
    frame.current = requestAnimationFrame(() => {
      const element = containerRef.current
      if (element && element.clientHeight && pinned.current && performance.now() - lastInput.current >= 150) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'auto' })
      }
    })
  }, [])
  const release = useCallback(() => {
    lastInput.current = performance.now()
    pinned.current = false
    cancelAnimationFrame(frame.current)
  }, [])
  const handleScroll = useCallback(() => {
    const element = containerRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance > 40) pinned.current = false
    else if (distance <= 4 || performance.now() - lastInput.current >= 150) pinned.current = true
    setShowJump(distance > 120)
  }, [])
  const jumpToLatest = useCallback(() => {
    pinned.current = true
    lastInput.current = -Infinity
    setShowJump(false)
    follow()
  }, [follow])

  useLayoutEffect(() => {
    if (context.current !== contextKey) {
      context.current = contextKey
      pinned.current = true
      lastInput.current = -Infinity
      setShowJump(false)
    }
    follow()
  }, [revision, contextKey, follow])
  useLayoutEffect(() => {
    const element = containerRef.current
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(follow) : null
    if (element) observer?.observe(element)
    // Markdown may lay out after reducer updates; follow the actual DOM change.
    const content = typeof MutationObserver !== 'undefined' ? new MutationObserver(follow) : null
    if (element) content?.observe(element, { childList: true, characterData: true, subtree: true })
    return () => { observer?.disconnect(); content?.disconnect(); cancelAnimationFrame(frame.current) }
  }, [follow])

  return {
    containerRef, showJump, jumpToLatest,
    bind: {
      onScroll: handleScroll,
      onWheel: (event: { deltaY: number; deltaX: number }) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) release() },
      onTouchStart: release,
      onPointerDown: release,
      onKeyDown: (event: { key: string }) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) release() },
      onLoadCapture: follow,
    },
  }
}
