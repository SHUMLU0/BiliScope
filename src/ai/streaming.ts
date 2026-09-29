/**
 * V3.0.1 · P0-A：流式（SSE）通用工具与超时常量。
 *
 * 设计要点（对应任务书「超时策略」）：
 *  1. **首个响应等待 30s**：只提示「模型尚未返回首个响应」，**不终止请求**。
 *  2. 一旦收到 **任意有效 chunk** → 进入 streaming 模式，只监控「距上次新数据」的时间。
 *  3. **连续空闲超过上限** → AbortController 终止 → 分类 `REQUEST_TIMEOUT`。
 *  4. **没有总时长硬切断**：总时长不构成失败条件。
 *
 * V3.1.1 · P0（时长策略）：**默认不限制**。
 *  - `AnalyzeRequest.idleTimeoutMs = number` → 该数值就是空闲/总时长上限；
 *  - `null` / `undefined` → **不创建任何 BiliScope 人为 timer**（不限制）；
 *  - 不再存在「未设置就落回 300s」的隐藏默认 —— 不设置就是不限制。
 *
 * ⚠️ 红线：不限制 ≠ 删除中止能力 —— AbortController 与外部 signal 照常工作。
 * ⚠️ 本模块不做任何 probe 逻辑，只监控真实请求自身的活性。
 */

/** 流式：首个有效 chunk 的等待上限（仅提示，不终止） */
export const STREAM_FIRST_BYTE_TIMEOUT_MS = 30_000;

/**
 * 从 SSE 响应体中逐行解析出 `data:` 负载。
 *
 * 只处理 RFC 风格的最小 SSE 子集：
 *   - 以 `data:` 开头（允许 `data: ` 与 `data:` 两种写法）
 *   - `data: [DONE]` 视为流结束标记，不产出负载
 *   - 空行 / 注释行（`:` 开头）/ 其他字段（`event:` / `id:`）一律忽略
 *
 * 返回的是**字符串负载**，由调用方决定如何解析（OpenAI 与 Gemini 的负载结构不同）。
 */
export function parseSseDataLines(chunk: string): { payloads: string[]; done: boolean } {
  const payloads: string[] = [];
  let done = false;
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).replace(/^\s/, '');
    if (!payload) continue;
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    payloads.push(payload);
  }
  return { payloads, done };
}

/**
 * 把 `ReadableStream<Uint8Array>` 解码为文本，并在文本不完整时**保留尾巴**。
 *
 * `TextDecoder.decode(..., { stream: true })` 能正确处理跨 chunk 的多字节字符，
 * 但 SSE 的**行**可能被 chunk 边界切断，因此这里维护一个 `buffer`，
 * 只把「以 \n 结尾的完整行」交给回调，剩余的半行留到下一轮。
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  shouldAbort?: () => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (shouldAbort?.()) {
        throw new Error('stream aborted by idle watchdog');
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
        idx = buffer.indexOf('\n');
      }
    }
    // 收尾：把剩余缓冲（若有）也交出去
    buffer += decoder.decode();
    if (buffer.trim()) onLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 流已关闭 */
    }
  }
}
