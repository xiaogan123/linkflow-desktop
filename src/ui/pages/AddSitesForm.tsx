import { useRef, useState, type FormEvent } from 'react';
import type { AddSitesBatchResult } from '../../shared/types';
import { Button, Field } from '../components';
import { parseSiteInput, uiCopy } from '../dashboard-model';
export function AddSitesForm({
  disabled,
  onAction,
  onClose,
  hideMode = false,
  defaultMode = 'ai',
  onAdded
}: {
  disabled: boolean;
  onAction: <T>(command: string, payload?: unknown, success?: string) => Promise<T | undefined>;
  onClose: () => void;
  /** The first-run guide asks for the publishing mode in its own step. */
  hideMode?: boolean;
  /** The global default for new sites (设置 → 新网站默认发布方式). */
  defaultMode?: 'ai' | 'manual';
  onAdded?: (result: AddSitesBatchResult) => void;
}) {
  const [text, setText] = useState(''),
    [target, setTarget] = useState(2),
    [mode, setMode] = useState<'ai' | 'manual'>(defaultMode),
    [siteType, setType] = useState('auto'),
    [email, setEmail] = useState(''),
    [result, setResult] = useState<AddSitesBatchResult | null>(null),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    entered = parseSiteInput(text),
    domains = [...new Map(entered.map(value => [value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''), value.trim()])).values()],
    repeated = entered.length - domains.length;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const response = await onAction<AddSitesBatchResult>('site:add-batch', {
      domains,
      monthlyTarget: target,
      articleReviewMode: mode,
      siteType,
      contactEmail: email.trim()
    });
    if (response) { setResult(response); onAdded?.(response); }
  };
  return <form className="dialog-form" onSubmit={submit}><Field label="网址" hint="每行一个，可以一次粘贴很多个；也可以导入 CSV。"><textarea autoFocus required rows={6} value={text} onChange={e => {
        setText(e.target.value);
        setResult(null);
      }} placeholder="example.com" /></Field>
<input ref={input} type="file" accept=".csv,text/csv" hidden onChange={async e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const values = parseSiteInput(await file.text());
        if (!values.length) {
          setError(uiCopy.invalidCsv);
          return;
        }
        setText(old => [old, ...values].filter(Boolean).join('\n'));
        setError('');
        setResult(null);
      } catch {
        setError(uiCopy.importFailed);
      }
    }} />
<Button onClick={() => input.current?.click()}>导入 CSV</Button>
 <Field label="每月几条" hint="建议 2–4 条，新站第一个月只发 1 条"><input type="number" min={1} max={20} required value={target} onChange={e => setTarget(Number(e.target.value))} /></Field>
 {!hideMode && <Field label="发布方式" hint="每篇我先看：稿子写好后等你确认，48 小时没看就放弃这篇。"><select value={mode} onChange={e => setMode(e.target.value as 'ai' | 'manual')}><option value="ai">全自动（推荐）</option>
<option value="manual">每篇我先看</option></select></Field>}
 <Field label="网站类型"><select value={siteType} onChange={e => setType(e.target.value)}><option value="auto">自动识别</option>
<option value="finance-zh">全部是金融·简体中文</option></select></Field>
 <Field label="公开联系邮箱（可不填）" hint="部分平台会公开显示，建议用专用邮箱。"><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
 {error && <p role="alert">{error}</p>}
{result && <div role="status" className="batch-result">{result.added > 0 && <p>已添加 {result.added} 个网站。第一批明天开始发，{result.rolloutDays} 天内全部铺开。</p>}
{(result.errors.length > 0 || result.duplicates > 0) && <p>{uiCopy.batchAddPartial(result.errors.length, result.duplicates)}</p>}
{result.errors.map((item, index) => <p key={index}>{item.input} · {item.message}</p>)}</div>}
 {repeated > 0 && !result && <p className="muted">重复 {repeated} 个，已忽略。</p>}
 <div className="dialog-actions"><Button onClick={onClose}>{result ? '完成' : '取消'}</Button>
<Button variant="primary" type="submit" disabled={disabled || !domains.length || !!result}>添加 {domains.length} 个网站</Button></div></form>;
}
