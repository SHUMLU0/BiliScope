/**
 * V3.2.1 · P1：最小 React ErrorBoundary（评论研究页最后保险）。
 *
 * 定位（三层防御的最外层，不可越位）：
 *   1. 数据入口 schema 验证（loadStoredReport 三态分类）—— 核心防线；
 *   2. 组件内 `?? []` 兜底（CommentAIReport）—— 防线；
 *   3. 本组件 —— 保险丝：任何未预期渲染异常都落到这里，**绝不白屏**。
 * ⚠️ 它的存在不是为了掩盖 1/2 层的 schema bug：错误摘要原文显示在页面上，
 *    有 bug 就该被看见、被修，而不是被静默吞掉。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** 区域标签（显示在错误卡里，方便定位是哪一块崩了） */
  label?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 仅控制台留痕（开发排错用）；UI 上原文展示，不静默。
    console.error(`[BiliScope] 渲染异常（${this.props.label ?? '页面'}）:`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="card stack" style={{ borderColor: 'var(--danger)' }}>
        <h3 style={{ margin: 0 }}>页面渲染出错</h3>
        <div className="error">
          {this.props.label ? `${this.props.label}区域在渲染时遇到未预期的错误。` : '页面在渲染时遇到未预期的错误。'}
          数据本身未受影响；若反复出现，请通过「AI 历史」检查原始数据并在仓库反馈。
        </div>
        <div className="faint mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
          {error.message || String(error)}
        </div>
        <div>
          <button className="primary" onClick={this.handleRetry}>
            重试渲染
          </button>
        </div>
      </section>
    );
  }
}
