import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from './api'
import { emptyDoc } from './lib/doc'
const body={page_id:'page',doc:emptyDoc('caption'),message:'文稿',selection:[],skill_ids:[],attachments:[]}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})

describe('durable Agent subscription',()=>{
  it('reconnects using the last event id and never repeats POST or tool events',async()=>{
    vi.useFakeTimers()
    const urls:string[]=[];let postCount=0
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);urls.push(url)
      if(init?.method==='POST'){
        postCount++
        return new Response('id: 2\ndata: {"type":"text","delta":"你好"}\n\n',{headers:{'X-Atelier-Job':'job-1'}})
      }
      if(url.endsWith('/events?after=2')) return new Response('id: 2\ndata: {"type":"text","delta":"你好"}\n\nid: 3\ndata: {"type":"tool","name":"read_page","label":"读取","brief":"","ok":true,"result":"文稿"}\n\nid: 4\ndata: {"type":"done","message":{"content":"你好"}}\n\n')
      return new Response(JSON.stringify({status:'running'}))
    }))
    const events:any[]=[]
    const promise=runAgent('session',body,event=>events.push(event),new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1000);await promise
    expect(postCount).toBe(1)
    expect(urls).toContain('/api/v1/jobs/job-1/events?after=2')
    expect(events.filter(e=>e.type==='text').map(e=>e.delta).join('')).toBe('你好')
    expect(events.filter(e=>e.type==='tool')).toHaveLength(1)
  })
  it('refresh attachment only subscribes to the existing job',async()=>{
    const fetcher=vi.fn(async()=>new Response('id: 9\ndata: {"type":"done","message":{"content":"已保存"}}\n\n'))
    vi.stubGlobal('fetch',fetcher)
    await runAgent('session',body,()=>{},new AbortController().signal,'original')
    expect(fetcher).toHaveBeenCalledWith('/api/v1/jobs/original/events?after=0',expect.objectContaining({signal:expect.any(AbortSignal)}))
    expect(fetcher.mock.calls).toHaveLength(1)
  })
})
