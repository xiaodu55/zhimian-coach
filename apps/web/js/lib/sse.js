/**
 * 极简 SSE 客户端（支持 POST + ReadableStream）。
 *
 * 为什么不用 EventSource：EventSource 只支持 GET，而我们的复盘/追问都是 POST 带 body。
 * 这里手写解析，协议与服务端约定一致：
 *   event: stage | delta | result | error
 *   data:  JSON
 */
export async function postSSE(url, body, { onStage, onDelta, signal } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body || {}),
    signal,
  });

  if (!res.ok || !res.body) {
    // 服务端不支持流式（老版本）→ 直接回落到普通 JSON
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), data?.error || {});
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let failure = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 事件之间以空行分隔
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt = parseEvent(raw);
      if (!evt) continue;
      if (evt.event === 'stage') onStage?.(evt.data);
      else if (evt.event === 'delta') onDelta?.(evt.data);
      else if (evt.event === 'result') result = evt.data;
      else if (evt.event === 'error') failure = evt.data;
    }
  }

  if (failure) throw new Error(failure.message || '流式调用失败');
  if (!result) throw new Error('流式调用没有返回结果');
  return result;
}

function parseEvent(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const text = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}
