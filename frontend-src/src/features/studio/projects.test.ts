import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ save: vi.fn(), request: vi.fn(), boot: vi.fn(), state: vi.fn() }))
vi.mock('../../api', () => ({ api: calls.request }))
vi.mock('./store', () => ({ flushSave: calls.save, boot: calls.boot, useStore: { setState: calls.state } }))
import { activateProject } from './projects'

describe('project context transitions', () => {
  it('flushes the old page before selecting and loading another project', async () => {
    const order: string[] = []
    calls.save.mockImplementation(async () => { order.push('save') })
    calls.request.mockImplementation(async () => { order.push('select') })
    calls.boot.mockImplementation(async () => { order.push('load') })
    await activateProject('next')
    expect(order).toEqual(['save', 'select', 'load'])
    expect(calls.request).toHaveBeenLastCalledWith('/api/v1/projects/next/select', { method: 'POST' })
  })

  it('preserves the current project if saving fails', async () => {
    calls.request.mockClear()
    calls.save.mockRejectedValueOnce(new Error('save failed'))
    await expect(activateProject('unreached')).rejects.toThrow('save failed')
    expect(calls.request).not.toHaveBeenCalled()
  })
})
