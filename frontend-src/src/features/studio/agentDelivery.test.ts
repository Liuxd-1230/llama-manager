import { describe,expect,it,vi,afterEach } from 'vitest'
import { runAgent,type RunBody } from './api'
import { emptyDoc } from './lib/doc'
const body:RunBody={page_id:'page',doc:emptyDoc(),message:'hello',selection:[],skill_ids:[],attachments:[]}
afterEach(()=>vi.unstubAllGlobals())
describe('Agent delivery ownership',()=>{
  it('replays the original durable tail after a premature EOF',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('id: 1\ndata: {"type":"text","delta":"前"}\n\n',{headers:{'X-Atelier-Job':'job'}})).mockResolvedValueOnce(new Response('id: 2\ndata: {"type":"text","delta":"后"}\n\nid: 3\ndata: {"type":"done","message":{"content":"前后"}}\n\n'))
    vi.stubGlobal('fetch',fetcher);const events:unknown[]=[]
    await runAgent('session',body,e=>events.push(e),new AbortController().signal)
    expect(fetcher.mock.calls[1][0]).toBe('/api/v1/jobs/job/events?after=1')
    expect(events).toContainEqual({type:'text',delta:'后'})
    expect(events.at(-1)).toEqual({type:'done',message:{content:'前后'}})
  })
  it('cancels by request identity when stopped before response headers',async()=>{
    const fetcher=vi.fn((url:string,init:RequestInit)=>url.endsWith('/run')?new Promise<Response>((_,reject)=>init.signal?.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')))):Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch',fetcher);const control=new AbortController()
    const running=runAgent('session',body,()=>{},control.signal);control.abort()
    await expect(running).rejects.toMatchObject({name:'AbortError'})
    expect(fetcher.mock.calls[1][0]).toBe('/api/v1/moss/sessions/session/cancel')
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body)).request_id).toBe(JSON.parse(String(fetcher.mock.calls[0][1].body)).request_id)
  })
})
