/**
 * Interactive input.
 *   - TTY: reads one character at a time in raw mode; the email is echoed, the password masked with '*' (echo off).
 *   - Non-TTY (pipe): reads all of stdin once and consumes it line by line (for automated tests).
 */

let pipedLines: string[] | null = null
let pipedIndex = 0

/** Read and cache all piped input; each call returns the next line. */
async function nextPipedLine(): Promise<string> {
  if (pipedLines === null) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    // The empty element left by the trailing newline is harmless: out-of-range reads return ''.
    pipedLines = text.split(/\r?\n/)
  }
  return pipedLines[pipedIndex++] ?? ''
}

const CTRL_C = 3
const CTRL_D = 4
const BACKSPACE = 8
const DELETE = 127

/** Read one line in TTY raw mode. mask=true echoes '*' instead (passwords). */
function readRawTTY(mask: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let buf = ''

    const finish = (): void => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
    }

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0)
        if (ch === '\r' || ch === '\n') {
          finish()
          resolve(buf)
          return
        }
        if (code === CTRL_C) {
          finish()
          reject(new Error('Input cancelled'))
          return
        }
        if (code === CTRL_D) {
          finish()
          resolve(buf)
          return
        }
        if (code === BACKSPACE || code === DELETE) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            process.stderr.write('\b \b')
          }
          continue
        }
        if (code < 32) continue // ignore other control characters
        buf += ch
        process.stderr.write(mask ? '*' : ch)
      }
    }

    stdin.on('data', onData)
  })
}

/** Print the label (stderr) and read one line of plain text. */
export async function promptLine(label: string): Promise<string> {
  process.stderr.write(label)
  if (!process.stdin.isTTY) {
    const line = await nextPipedLine()
    process.stderr.write('\n')
    return line.trim()
  }
  return (await readRawTTY(false)).trim()
}

/** Print the label (stderr) and read a password without echo. */
export async function promptPassword(label: string): Promise<string> {
  process.stderr.write(label)
  if (!process.stdin.isTTY) {
    const line = await nextPipedLine()
    process.stderr.write('\n')
    return line
  }
  return await readRawTTY(true)
}
