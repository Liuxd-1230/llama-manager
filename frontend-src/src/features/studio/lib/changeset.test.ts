import { describe, expect, it } from 'vitest'
import { applyChanges, diffDocs, wordDiff } from './changeset'
import type { Doc } from '../types'

function doc(items: Array<{ id: string; caption: string }>): Doc {
  return {
    kind: 'layout',
    caption: { caption: '' },
    layout: {
      width: 1024, height: 1536, bbox_coord_space: 'abs', bbox_format: 'xyxy',
      summary: { caption: '', canvas: 'single' },
      camera: { az: 0, zoom: 1, panX: 0, panY: 0 },
      items: items.map((it) => ({ id: it.id, label: 'text', box: [0.1, 0.1, 0.4, 0.4], caption: it.caption })),
    },
  } as unknown as Doc
}

describe('wordDiff', () => {
  it('标记新增与删除的词段', () => {
    const segs = wordDiff('a red cat', 'a blue cat')
    expect(segs.some((s) => s.op === 'del' && s.t.includes('red'))).toBe(true)
    expect(segs.some((s) => s.op === 'add' && s.t.includes('blue'))).toBe(true)
    expect(segs.some((s) => s.op === 'same' && s.t.includes('cat'))).toBe(true)
  })

  it('空输入退化为整段增删', () => {
    const segs = wordDiff('', 'hello')
    expect(segs).toEqual([{ t: 'hello', op: 'add' }])
  })
})

describe('diffDocs / applyChanges', () => {
  it('caption 修改生成提案，接受后生效', () => {
    const base = doc([{ id: 'i1', caption: 'old' }])
    const next = doc([{ id: 'i1', caption: 'new words' }])
    const changes = diffDocs(base, next)
    expect(changes.length).toBeGreaterThan(0)
    const accepted = new Set(changes.map((c) => c.key))
    const merged = applyChanges(base, base, next, accepted)
    expect(merged.layout.items[0].caption).toBe('new words')
  })

  it('全部拒绝时保持原文档', () => {
    const base = doc([{ id: 'i1', caption: 'old' }])
    const next = doc([{ id: 'i1', caption: 'new' }])
    const merged = applyChanges(base, base, next, new Set())
    expect(merged.layout.items[0].caption).toBe('old')
  })
})


describe('segmented proposals',()=>{
  it('applies one segment while preserving a fixed passage',()=>{
    const base=doc([]);base.kind='caption';base.caption={caption:'fixed\nold',segments:[{id:'a',name:'固定',text:'fixed',locked:true},{id:'b',name:'光线',text:'old'}]};
    const next=structuredClone(base);next.caption.segments![0].text='unwanted';next.caption.segments![1].text='new';next.caption.caption='unwanted\nnew';
    const merged=applyChanges(base,base,next,new Set(['seg:a','seg:b']));
    expect(merged.caption.caption).toBe('fixed\nnew');expect(merged.caption.segments![0].locked).toBe(true);
  });
});
