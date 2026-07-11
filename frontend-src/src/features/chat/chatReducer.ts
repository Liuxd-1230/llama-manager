import type { Candidate, ChatTurn, ToolEvent } from '../../types'

export interface ChatState { turns: ChatTurn[]; generating: { turnId: string; candidateId: string } | null }
export type ChatAction =
  | { type: 'add_turn'; turn: ChatTurn }
  | { type: 'add_candidate'; turnId: string; candidate: Candidate }
  | { type: 'set_backend_id'; turnId: string; candidateId: string; backendId: string }
  | { type: 'append'; turnId: string; candidateId: string; field: 'content' | 'reasoning'; delta: string }
  | { type: 'tool'; turnId: string; candidateId: string; event: ToolEvent }
  | { type: 'finish'; turnId: string; candidateId: string; status: Candidate['status']; error?: string }
  | { type: 'select'; turnId: string; candidateId: string }
  | { type: 'clear' }

export const initialChatState: ChatState = { turns: [], generating: null }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'clear') return initialChatState
  if (action.type === 'add_turn') return { ...state, turns: [...state.turns, action.turn] }
  const turns = state.turns.map(turn => {
    if (turn.id !== ('turnId' in action ? action.turnId : '')) return turn
    if (action.type === 'add_candidate') return { ...turn, candidates: [...turn.candidates, action.candidate], activeCandidateId: action.candidate.id }
    if (action.type === 'select') return { ...turn, activeCandidateId: action.candidateId }
    const candidates = turn.candidates.map(candidate => {
      if (candidate.id !== ('candidateId' in action ? action.candidateId : '')) return candidate
      if (action.type === 'set_backend_id') return { ...candidate, backendId: action.backendId }
      if (action.type === 'append') return { ...candidate, [action.field]: candidate[action.field] + action.delta }
      if (action.type === 'tool') return { ...candidate, tools: [...candidate.tools, action.event] }
      if (action.type === 'finish') return { ...candidate, status: action.status, error: action.error }
      return candidate
    })
    return { ...turn, candidates }
  })
  if (action.type === 'add_candidate') return { turns, generating: { turnId: action.turnId, candidateId: action.candidate.id } }
  if (action.type === 'finish') return { turns, generating: null }
  return { ...state, turns }
}

export function activeCandidate(turn: ChatTurn) { return turn.candidates.find(candidate => candidate.id === turn.activeCandidateId) }
