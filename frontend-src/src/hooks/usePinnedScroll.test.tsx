import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedScroll } from './usePinnedScroll'
import { isComposingKey, useImeGuard } from './useImeGuard'

let frames = new Map<number, FrameRequestCallback>()
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }

beforeEach(() => {
  let id = 0
  frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (value: number) => frames.delete(value))
})
afterEach(() => vi.unstubAllGlobals())

describe('stream viewport ownership', () => {
  it('stops following after upward input, and resumes only when explicitly requested', () => {
    const { result, rerender } = renderHook(({ revision }) => usePinnedScroll(revision, 'chat'), { initialProps: { revision: 1 } })
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } })
    Object.defineProperty(element, 'scrollTo', { configurable: true, value: vi.fn() })
    result.current.containerRef.current = element
    act(() => rerender({ revision: 2 }))
    act(flush)
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
    vi.mocked(element.scrollTo).mockClear()
    act(() => { result.current.bind.onWheel({ deltaY: -100, deltaX: 0 }); element.scrollTop = 200; result.current.bind.onScroll(); rerender({ revision: 3 }) })
    act(flush)
    expect(element.scrollTo).not.toHaveBeenCalled()
    expect(result.current.showJump).toBe(true)
    act(() => { result.current.jumpToLatest(); flush() })
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
    expect(result.current.showJump).toBe(false)
  })

  it('resets a released viewport when switching conversations', () => {
    const { result, rerender } = renderHook(({ context }) => usePinnedScroll(1, context), { initialProps: { context: 'first' } })
    const element = document.createElement('div')
    Object.defineProperties(element, { scrollHeight: { value: 900 }, clientHeight: { value: 200 } })
    Object.defineProperty(element, 'scrollTo', { configurable: true, value: vi.fn() })
    result.current.containerRef.current = element
    act(() => { result.current.bind.onTouchStart(); rerender({ context: 'second' }) })
    act(flush)
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'auto' })
  })
})

describe('IME guard', () => {
  it('covers the browser flag, Safari 229 fallback and composition events', () => {
    expect(isComposingKey({ isComposing: true })).toBe(true)
    expect(isComposingKey({ keyCode: 229 })).toBe(true)
    const { result } = renderHook(useImeGuard)
    act(() => result.current.onCompositionStart())
    expect(result.current.isComposing({})).toBe(true)
    act(() => result.current.onCompositionEnd())
    expect(result.current.isComposing({ keyCode: 13 })).toBe(false)
  })
})
