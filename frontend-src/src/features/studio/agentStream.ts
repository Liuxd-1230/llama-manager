/** UTF-8 and SSE framing survive arbitrary transport splits, including CRLF. */
export async function readAgentFrames(response: Response, onFrame: (data: unknown, id: number) => void) {
  if (!response.body) throw new Error('Agent 连接没有响应体')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (block: string) => {
    const lines = block.split(/\r?\n/)
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    const id = Number(lines.find(line => line.startsWith('id:'))?.slice(3).trim() || 0)
    onFrame(JSON.parse(data), Number.isFinite(id) ? id : 0)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        parse(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
      if (done) break
    }
  } finally { reader.releaseLock() }
}
