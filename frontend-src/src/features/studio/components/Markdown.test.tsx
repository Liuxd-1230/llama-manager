import {render,screen} from '@testing-library/react'
import {describe,expect,it} from 'vitest'
import {Markdown} from './Markdown'
describe('shared Agent Markdown',()=>{
  it('keeps Chinese prose fences readable and nested lists semantic',()=>{
    const {container}=render(<Markdown text={'```markdown\n## 光线\n\n- 窗边\n  - 反光\n```'}/> )
    expect(screen.getByRole('heading',{name:'光线'})).toBeInTheDocument()
    expect(container.querySelector('ul ul')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })
  it('keeps JSON as code with the common copy control',()=>{
    const {container}=render(<Markdown text={'```json\n{"caption":"雨后书房"}\n```'}/> )
    expect(container.querySelector('pre')).not.toBeNull()
    expect(screen.getByTitle('复制代码')).toBeInTheDocument()
  })
})
