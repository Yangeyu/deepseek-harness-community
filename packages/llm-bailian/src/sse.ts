import { EventSourceParserStream } from 'eventsource-parser/stream'

export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onActivity: () => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment: onActivity }))
  for await (const { data } of events) {
    onActivity()
    yield data
  }
}
