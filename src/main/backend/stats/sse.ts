/**
 * Incremental Server-Sent-Events parser.
 *
 * Feed it raw bytes as they arrive (in any chunking); it emits one callback per complete
 * event with the concatenated `data:` payload. Handles \n, \r\n and \r line endings and
 * multi-byte UTF-8 characters split across chunks.
 */
export interface SseEvent {
  event?: string
  data: string
  id?: string
}

export class SseParser {
  private buffer = ''
  private decoder = new TextDecoder('utf-8')
  private dataLines: string[] = []
  private eventName: string | undefined
  private lastId: string | undefined

  constructor(private readonly onEvent: (ev: SseEvent) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    let idx: number
    // Process complete lines only; keep the trailing partial line in the buffer.
    while ((idx = this.findLineEnd()) !== -1) {
      const line = this.buffer.slice(0, idx)
      // Consume the line terminator (\r\n counts as one).
      let skip = 1
      if (this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n') skip = 2
      this.buffer = this.buffer.slice(idx + skip)
      this.handleLine(line)
    }
  }

  /** Flush any pending event (call when the stream ends). */
  end(): void {
    const rest = this.decoder.decode()
    if (rest) this.buffer += rest
    if (this.buffer.length > 0) {
      this.handleLine(this.buffer)
      this.buffer = ''
    }
    this.dispatch()
  }

  private findLineEnd(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i]
      if (c === '\n') return i
      if (c === '\r') {
        // A lone \r at the very end might be the first half of \r\n: wait for more data.
        if (i === this.buffer.length - 1) return -1
        return i
      }
    }
    return -1
  }

  private handleLine(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) return // comment / keep-alive
    const colon = line.indexOf(':')
    let field: string
    let value: string
    if (colon === -1) {
      field = line
      value = ''
    } else {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
    }
    switch (field) {
      case 'data':
        this.dataLines.push(value)
        break
      case 'event':
        this.eventName = value
        break
      case 'id':
        this.lastId = value
        break
      default:
        break
    }
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) {
      this.eventName = undefined
      return
    }
    const ev: SseEvent = { data: this.dataLines.join('\n') }
    if (this.eventName) ev.event = this.eventName
    if (this.lastId) ev.id = this.lastId
    this.dataLines = []
    this.eventName = undefined
    this.onEvent(ev)
  }
}
