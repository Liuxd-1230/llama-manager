import type { Provider } from '../../types'

export function supportsThinking(provider?: Provider) {
  return provider?.kind === 'deepseek'
}

export function canStartChatRequest(input: string, attachmentCount: number, active: boolean) {
  return !active && (Boolean(input.trim()) || attachmentCount > 0)
}

export function stripDsml(value: string) {
  return value
    .replace(/<\s*\|\s*DSML\s*\|\s*tool_calls\s*>[\s\S]*?<\/\s*\|\s*DSML\s*\|\s*tool_calls\s*>/gi, '')
    .replace(/<\s*\|\s*DSML\s*\|\s*invoke[\s\S]*?(?:<\/\s*\|\s*DSML\s*\|\s*invoke\s*>|$)/gi, '')
    .trim()
}

export class SseParser {
  private buffer = ''

  push(chunk: string, flush = false): string[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const frames = this.buffer.split('\n\n')
    this.buffer = flush ? '' : (frames.pop() || '')
    return frames.flatMap(frame => {
      const data = frame.split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
        .trim()
      return data ? [data] : []
    })
  }
}
