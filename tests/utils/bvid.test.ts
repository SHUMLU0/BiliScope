/**
 * V3.2.1 · parseBvid / detectCommentAnalysisVersion 单元回归。
 *
 * parseBvid：BV 号解析唯一入口 —— 裸号 / 完整 URL / 分 P / spm 参数 / 非法输入。
 * detectCommentAnalysisVersion：评论 AI 结果三态判定（current / legacy / invalid），
 * 不用 try/catch 猜、不做强制迁移。
 */

import { describe, it, expect } from 'vitest';
import { parseBvid } from '@utils/bvid';
import { detectCommentAnalysisVersion } from '@ai/compat';
import { CURRENT_RESULT, LEGACY_RESULT } from '../ui/fixtures/comment-result-fixtures';

describe('parseBvid：BV 号解析统一入口', () => {
  it('解析裸 BV 号', () => {
    expect(parseBvid('BV1AbCdEfGh1')).toBe('BV1AbCdEfGh1');
  });

  it('解析完整视频链接（含协议/域名/路径）', () => {
    expect(parseBvid('https://www.bilibili.com/video/BV1AbCdEfGh1/')).toBe('BV1AbCdEfGh1');
  });

  it('解析带分 P 与 spm 参数的链接', () => {
    expect(parseBvid('https://www.bilibili.com/video/BV1AbCdEfGh1?p=2&spm_id_from=333.788')).toBe(
      'BV1AbCdEfGh1',
    );
  });

  it('解析带 query 的短形式', () => {
    expect(parseBvid('BV1AbCdEfGh1?p=3')).toBe('BV1AbCdEfGh1');
  });

  it('容忍首尾空白', () => {
    expect(parseBvid('  BV1AbCdEfGh1  ')).toBe('BV1AbCdEfGh1');
  });

  it('非法输入一律返回 null（绝不猜测/截断凑数）', () => {
    expect(parseBvid('')).toBeNull();
    expect(parseBvid(null)).toBeNull();
    expect(parseBvid(undefined)).toBeNull();
    expect(parseBvid('av170001')).toBeNull();
    expect(parseBvid('BV123')).toBeNull(); // 位数不足
    expect(parseBvid('https://example.com/video/BV1AbCdEfGh1')).toBe('BV1AbCdEfGh1'); // 任意域名也可提取
  });
});

describe('detectCommentAnalysisVersion：三态判定', () => {
  it('V3.2 研究契约结果 → current', () => {
    expect(detectCommentAnalysisVersion(CURRENT_RESULT)).toBe('current');
  });

  it('V3.1.x 分类式结果 → legacy（绝不强转成新 schema）', () => {
    expect(detectCommentAnalysisVersion(LEGACY_RESULT)).toBe('legacy');
    // 单独的 legacy 特征字段也认
    expect(detectCommentAnalysisVersion({ facts: ['a'] })).toBe('legacy');
    expect(detectCommentAnalysisVersion({ themes: [{ name: 't', refs: [] }] })).toBe('legacy');
    // 同名标量不算 legacy 证据
    expect(detectCommentAnalysisVersion({ facts: 'not-array' })).toBe('invalid');
  });

  it('损坏 / 无关数据 → invalid', () => {
    expect(detectCommentAnalysisVersion({ foo: 'bar' })).toBe('invalid');
    expect(detectCommentAnalysisVersion(null)).toBe('invalid');
    expect(detectCommentAnalysisVersion(undefined)).toBe('invalid');
    expect(detectCommentAnalysisVersion('garbage')).toBe('invalid');
    expect(detectCommentAnalysisVersion([1, 2, 3])).toBe('invalid');
  });
});
