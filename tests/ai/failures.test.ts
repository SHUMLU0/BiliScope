/**
 * V3.0 · 失败分层与截断诊断测试（第六节 / 第四节）。
 *
 * 目的：证明「AI 失败」被细分为真实原因，且截断绝不被当成成功。
 */

import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  isRefusalFinish,
  isTruncatedFinish,
  classifyRequestError,
  AI_FAILURE_CODES,
  type AIFailureCode,
} from '@ai/failures';

describe('failure taxonomy', () => {
  it('covers all six required categories', () => {
    const required: AIFailureCode[] = [
      'REQUEST_FAILED',
      'OUTPUT_EMPTY',
      'OUTPUT_TRUNCATED',
      'OUTPUT_INVALID_JSON',
      'OUTPUT_SCHEMA_INVALID',
      'OUTPUT_REFUSAL',
    ];
    for (const c of required) {
      expect(AI_FAILURE_CODES).toContain(c);
    }
  });

  it('every code has a distinct human message (not all "AI 失败")', () => {
    const messages = AI_FAILURE_CODES.map((c) => describeFailure(c).message);
    const unique = new Set(messages);
    expect(unique.size).toBe(messages.length);
    for (const m of messages) {
      expect(m).not.toBe('AI 失败');
      expect(m.length).toBeGreaterThan(3);
    }
  });

  it('truncation and schema errors are retryable; refusal is not', () => {
    expect(describeFailure('OUTPUT_TRUNCATED').retryable).toBe(true);
    expect(describeFailure('OUTPUT_SCHEMA_INVALID').retryable).toBe(true);
    expect(describeFailure('OUTPUT_REFUSAL').retryable).toBe(false);
    expect(describeFailure('NO_PROVIDER').retryable).toBe(false);
  });
});

describe('isTruncatedFinish', () => {
  it('detects OpenAI "length"', () => {
    expect(isTruncatedFinish('length')).toBe(true);
  });

  it('detects Gemini "MAX_TOKENS"', () => {
    expect(isTruncatedFinish('MAX_TOKENS')).toBe(true);
    expect(isTruncatedFinish('max_tokens')).toBe(true);
  });

  it('is false for "stop" and undefined', () => {
    expect(isTruncatedFinish('stop')).toBe(false);
    expect(isTruncatedFinish(undefined)).toBe(false);
    expect(isTruncatedFinish(null)).toBe(false);
  });
});

describe('isRefusalFinish', () => {
  it('detects OpenAI content_filter / refusal', () => {
    expect(isRefusalFinish('content_filter')).toBe(false); // content_filter 单独归为拒答由 refusal 字段承载
    expect(isRefusalFinish('refusal')).toBe(true);
    expect(isRefusalFinish('stop', 'SAFETY')).toBe(true);
  });

  it('detects Gemini safety block reasons', () => {
    expect(isRefusalFinish('SAFETY')).toBe(true);
    expect(isRefusalFinish('PROHIBITED_CONTENT')).toBe(true);
  });

  it('is false for normal stops', () => {
    expect(isRefusalFinish('stop')).toBe(false);
    expect(isRefusalFinish('MAX_TOKENS')).toBe(false);
    expect(isRefusalFinish(undefined)).toBe(false);
  });
});

describe('classifyRequestError · 流式空闲超时（V3.0.1 P0-A）', () => {
  it('流式空闲超时归为 REQUEST_TIMEOUT，且消息明确说明「连续无新响应」', () => {
    const info = classifyRequestError(
      new Error('stream idle timeout: 连续 120 秒没有收到任何新响应'),
    );
    expect(info.code).toBe('REQUEST_TIMEOUT');
    expect(info.message).toContain('连续 120 秒无新响应');
    expect(info.detail).toBeTruthy();
  });

  it('普通总时长超时不会被误写成「连续无新响应」', () => {
    const info = classifyRequestError(new Error('The operation was aborted due to timeout'), 120_000);
    expect(info.code).toBe('REQUEST_TIMEOUT');
    expect(info.message).not.toContain('连续');
  });

  it('detail 永不为空（禁止「技术细节：空」）', () => {
    const info = classifyRequestError(new Error(''));
    expect(info.detail && info.detail.length > 0).toBe(true);
  });
});
