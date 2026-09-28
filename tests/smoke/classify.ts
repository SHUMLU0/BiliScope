/**
 * Smoke 结论语义（V0.1.3 P1）：
 *
 *   PASS                 —— 真实接口 code=0 且拿到了预期结构的数据
 *   PASS_WITH_ENV_LIMIT  —— 真实接口被 B 站风控（-352 / -412 / -799 …），
 *                           但**对照组同样被拦**，即环境限制，不是代码缺陷
 *   FAIL                 —— 对照组成功而我们失败，或返回结构不符合预期
 *
 * 绝不允许把「因风控拿不到数据」统计成 PASS。
 */

export type SmokeVerdict = 'PASS' | 'PASS_WITH_ENV_LIMIT' | 'FAIL';

export interface ClassifyInput {
  /** 待测路径的业务码（null = 连响应都没解析出来） */
  code: number | null;
  /** 是否拿到了业务数据 */
  hasData: boolean;
  /** 对照组（更简单/更稳定的路径）的业务码 */
  legacyCode: number | null;
  /** 响应结构是否符合预期（JSON 结构错误 → 直接 FAIL） */
  structureOk: boolean;
}

const BLOCKED = new Set([-101, -111, -352, -401, -403, -412, -509, -799]);

export function isBlockedCode(code: number | null): boolean {
  if (code === null) return true;
  if (code === 0) return false;
  return BLOCKED.has(code);
}

export function classifyBili(input: ClassifyInput): SmokeVerdict {
  if (!input.structureOk) return 'FAIL';
  if (input.code === 0 && input.hasData) return 'PASS';
  // 我们被拦，但对照组也拿不到 → 属于环境风控
  if (isBlockedCode(input.code) && isBlockedCode(input.legacyCode)) return 'PASS_WITH_ENV_LIMIT';
  // 对照组成功而我们被拦 → 是我们的问题
  if (isBlockedCode(input.code) && input.legacyCode === 0) return 'FAIL';
  return 'FAIL';
}

/** 把结论写进测试输出，FAIL 直接抛错，PASS_WITH_ENV_LIMIT 只告警 */
export function assertNotFail(verdict: SmokeVerdict, detail: string): void {
  const line = `[smoke:${verdict}] ${detail}`;
  if (verdict === 'FAIL') {
    throw new Error(line);
  }
  if (verdict === 'PASS_WITH_ENV_LIMIT') {
    console.warn(line);
  } else {
    // smoke 结果必须打印到 stdout，CI / 人工验收都要看到这一行
    // eslint-disable-next-line no-console
    console.log(line);
  }
}
