import { describe, expect, it } from 'vitest'
import { downloadMetrics } from './downloadMetrics'
describe('download summary uses actual byte counters',()=>{
  it('aggregates size, throughput and remaining bytes across files',()=>{
    expect(downloadMetrics([{size:100,bytes_done:80,speed:10},{size:300,bytes_done:100,speed:30}],true)).toEqual({total:400,done:180,speed:40,percent:45,eta:6})
  })
  it('does not invent totals or ETA for unknown sizes, stopped transfers or zero speed',()=>{
    expect(downloadMetrics([{size:null,bytes_done:100,speed:20}],true).eta).toBeNull()
    expect(downloadMetrics([{size:200,bytes_done:100,speed:20}],false).eta).toBeNull()
    expect(downloadMetrics([{size:200,bytes_done:100,speed:0}],true).eta).toBeNull()
  })
})
