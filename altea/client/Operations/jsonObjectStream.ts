// Ported from Signum.React/Operations/jsonObjectStream.ts. Parses a newline-delimited JSON stream (one
// object per line) from a fetch Response body reader — the wire format the progress operation endpoints
// (executeMultiple / deleteMultiple / *WithProgress) stream back.
//
// altea divergence: each line goes through `Serializer.parse`, not `JSON.parse`. Signum's lites are plain
// objects, so JSON.parse is enough there; an altea Lite is a CLASS (its `entityType` is a constructor and
// `key()` is a method), and the caller does call `result.entity.key()` — a raw object would blow up.
import { Serializer } from "../../data/serializer";

export async function* jsonObjectStream<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          yield Serializer.parse(line) as T;
        } catch (err) {
          console.error('Failed to parse JSON line:', line, err);
          // Optionally: throw err or continue
        }
      }
    }
  }

  // Handle any trailing JSON object after the last newline
  const last = buffer.trim();
  if (last) {
    try {
      yield Serializer.parse(last) as T;
    } catch (err) {
      console.error('Failed to parse final JSON object:', last, err);
    }
  }
}
