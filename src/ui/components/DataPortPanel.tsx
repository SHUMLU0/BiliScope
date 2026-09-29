/**
 * V3.1.0 · P1：数据导入 / 导出面板（挂「我的数据」页底部）。
 *
 * 导出：exportAll → JSON 下载（文件名含版本号，单一来源 __APP_VERSION__）。
 * 导入：选文件 → previewImport（Zod 逐行校验）→ 如实显示合法/非法计数
 *       → 用户显式选择 merge / replace → applyImport。
 * replace 是**覆盖全部表**的危险操作，必须二次 confirm。
 */

import { useState } from 'react';
import { exportAll, toJsonBlob, downloadBlob } from '@services/export';
import { previewImport, applyImport, type ImportPreview } from '@services/import';

export function DataPortPanel(): JSX.Element {
  const [preview, setPreview] = useState<(ImportPreview & { fileName: string }) | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload = await exportAll();
      const blob = toJsonBlob(payload);
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `biliscope-export-v${payload.version}-${date}.json`);
      const total = Object.values(payload.data).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
      setStatus(`已导出 ${total} 条记录（v${payload.version} · ${date}）`);
    } catch (e) {
      setStatus(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const text = await file.text();
      const r = await previewImport(text);
      setPreview({ ...r, fileName: file.name });
      setStatus('');
    } catch (e) {
      setStatus(`读取文件失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (!preview?.payload) return;
    if (
      mode === 'replace' &&
      !confirm('replace 模式会先清空全部现有数据再导入，且不可撤销。确认继续？')
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await applyImport(preview.payload, mode);
      const imported = Object.values(r.imported).reduce((a, b) => a + b, 0);
      const skipped = Object.values(r.skipped).reduce((a, b) => a + b, 0);
      setStatus(`导入完成（${mode}）：写入 ${imported} 条，跳过 ${skipped} 条`);
      setPreview(null);
    } catch (e) {
      setStatus(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>导入 / 导出</h3>
      <p className="faint" style={{ margin: 0 }}>
        全部数据导出为单个 JSON 文件；导入前逐行校验，非法数据会被跳过并如实上报。
      </p>
      <div className="row wrap">
        <button className="primary" onClick={handleExport} disabled={busy}>
          导出全部数据（JSON）
        </button>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {status && <div className="faint">{status}</div>}

      {preview && (
        <div className="stack">
          <div className="row wrap">
            <strong>{preview.fileName}</strong>
            {preview.ok ? (
              <span className="tag ok">校验通过</span>
            ) : (
              <span className="tag danger">校验失败</span>
            )}
          </div>
          {preview.ok ? (
            <>
              <div className="mono faint">
                合法：{Object.entries(preview.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' · ') || '（空文件）'}
              </div>
              {Object.keys(preview.invalid).length > 0 && (
                <div className="warn mono">
                  非法：{Object.entries(preview.invalid).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' · ')}
                </div>
              )}
              {preview.errors.length > 0 && (
                <div className="faint">{preview.errors.slice(0, 5).join('；')}</div>
              )}
              <div className="row">
                <button onClick={() => handleApply('merge')} disabled={busy}>
                  合并导入（保留现有数据）
                </button>
                <button className="danger" onClick={() => handleApply('replace')} disabled={busy}>
                  替换导入（先清空全部）
                </button>
                <button onClick={() => setPreview(null)} disabled={busy}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <div className="error">{preview.error ?? '文件不是合法的 BiliScope 导出格式'}</div>
          )}
        </div>
      )}
    </section>
  );
}
