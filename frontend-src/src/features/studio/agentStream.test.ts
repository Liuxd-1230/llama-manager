import { describe, expect, it } from 'vitest'
import { readAgentFrames } from './agentStream'

describe('Agent SSE framing', () => {
  it('preserves Chinese and tool events split at every UTF-8 byte, with CRLF', async () => {
    const text = ': heartbeat\r\n\r\nid: 12\r\ndata: {"type":"text","delta":"你好，画面"}\r\n\r\nid: 14\r\ndata: {"type":"tool","name":"read_page"}\r\n\r\nid: 15\r\ndata: {"type":"done","message":{"content":"完整"}}\r\n\r\n'
    const bytes = new TextEncoder().encode(text)
    const response = new Response(new ReadableStream({start(controller){ for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() }}))
    const frames: unknown[] = []
    await readAgentFrames(response,(data,id)=>frames.push({data,id}))
    expect(frames).toEqual([{data:{type:'text',delta:'你好，画面'},id:12},{data:{type:'tool',name:'read_page'},id:14},{data:{type:'done',message:{content:'完整'}},id:15}])
  })
  it('does not silently swallow malformed JSON or dispatch an incomplete event', async () => {
    await expect(readAgentFrames(new Response('id: 1\ndata: broken\n\n'),()=>{})).rejects.toThrow()
    const result: unknown[]=[]
    await readAgentFrames(new Response('id: 1\ndata: {"type":"text","delta":"half'),data=>result.push(data))
    expect(result).toEqual([])
  })
})
