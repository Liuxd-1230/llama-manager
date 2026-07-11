import { describe, expect, it } from 'vitest'
import type { Candidate, ChatTurn } from '../../types'
import { chatReducer, initialChatState } from './chatReducer'

const turn = (id: string): ChatTurn => ({ id, user: { content: id, display: id }, candidates: [], activeCandidateId: '' })
const candidate = (id: string): Candidate => ({ id, provider: 'deepseek', model: 'deepseek-chat', content: '', reasoning: '', tools: [], status: 'streaming' })

describe('chatReducer', () => {
  it('updates only the requested turn and candidate during regeneration', () => {
    let state = chatReducer(initialChatState, { type: 'add_turn', turn: turn('first') })
    state = chatReducer(state, { type: 'add_turn', turn: turn('second') })
    state = chatReducer(state, { type: 'add_candidate', turnId: 'first', candidate: candidate('old') })
    state = chatReducer(state, { type: 'finish', turnId: 'first', candidateId: 'old', status: 'done' })
    state = chatReducer(state, { type: 'add_candidate', turnId: 'first', candidate: candidate('new') })
    state = chatReducer(state, { type: 'append', turnId: 'first', candidateId: 'new', field: 'content', delta: 'replacement' })

    expect(state.turns[0].candidates).toHaveLength(2)
    expect(state.turns[0].activeCandidateId).toBe('new')
    expect(state.turns[0].candidates[0].content).toBe('')
    expect(state.turns[0].candidates[1].content).toBe('replacement')
    expect(state.turns[1].candidates).toHaveLength(0)
  })

  it('keeps candidate navigation scoped to its turn', () => {
    let state = chatReducer(initialChatState, { type: 'add_turn', turn: turn('turn') })
    state = chatReducer(state, { type: 'add_candidate', turnId: 'turn', candidate: candidate('one') })
    state = chatReducer(state, { type: 'add_candidate', turnId: 'turn', candidate: candidate('two') })
    state = chatReducer(state, { type: 'select', turnId: 'turn', candidateId: 'one' })
    expect(state.turns[0].activeCandidateId).toBe('one')
  })
})
