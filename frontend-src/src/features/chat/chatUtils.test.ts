import { describe, expect, it } from 'vitest'
import type { Provider } from '../../types'
import { canStartChatRequest, SseParser, stripDsml, supportsThinking } from './chatUtils'

describe('SseParser', () => {
  it('parses fragmented CRLF frames and multiple data lines', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"type":"content_')).toEqual([])
    expect(parser.push('delta","delta":"你"}\r\n\r\ndata: first\r\ndata: second\r\n\r\n')).toEqual([
      '{"type":"content_delta","delta":"你"}',
      'first\nsecond',
    ])
  })

  it('flushes a final frame without a trailing separator', () => {
    const parser = new SseParser()
    expect(parser.push('data: [DONE]', true)).toEqual(['[DONE]'])
  })
})

describe('chat provider helpers', () => {
  it('uses provider kind for custom DeepSeek thinking support', () => {
    expect(supportsThinking({ id: 'custom-ds', name: 'DS', kind: 'deepseek' } as Provider)).toBe(true)
    expect(supportsThinking({ id: 'deepseek-name-only', name: 'DS', kind: 'openai_compatible' } as Provider)).toBe(false)
  })

  it('removes DSML tool traces from visible reasoning', () => {
    const value = '分析\n< | DSML | tool_calls>secret</ | DSML | tool_calls>\n结论'
    expect(stripDsml(value)).toBe('分析\n\n结论')
  })

  it('blocks Enter/send while a request is active and allows attachments', () => {
    expect(canStartChatRequest('next', 0, true)).toBe(false)
    expect(canStartChatRequest('', 0, false)).toBe(false)
    expect(canStartChatRequest('', 1, false)).toBe(true)
  })
})
