/**
 * 极简 SSE（Server-Sent Events）解析器。
 * 处理 `data: {json}\n\n` 分帧，忽略注释行与 `[DONE]`。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string, void, void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            if (data && data !== '[DONE]') yield data;
          }
        }
      }
    }
    // 收尾：可能还有未以空行结尾的数据
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data && data !== '[DONE]') yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
