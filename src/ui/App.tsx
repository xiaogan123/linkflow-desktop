import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setDisplayTimeZone } from './display-time';
import type { FormEvent, ReactNode } from 'react';
import { ArrowClockwise, ArrowLeft, ArrowSquareOut, Bell, CalendarBlank, CaretDown, CheckCircle, Clock, DownloadSimple, DotsThree, Eye, FileText, Funnel, Gear, House, Info, Leaf, LinkSimple, MagnifyingGlass, Pause, PencilSimple, Play, Plus, ShieldCheck, SlidersHorizontal, Trash, UploadSimple, UserCircle, WarningCircle, X, ArrowsClockwise } from '@phosphor-icons/react';
import type { Account, ArticleReviewMode, Category, Channel, Settings, Site, Snapshot, Task, TaskStatus } from '../shared/types';
import type { UpdateState } from '../shared/update-types';
import { getArticleReviewMode } from '../shared/article-review-mode';
import { HUMAN_AUTHORED_ONLY_NOTICE, isHumanAuthoredOnlyChannel } from '../shared/human-authored-only';
import { publicationCounts, publicationFormatCounts } from '../shared/publication';
import { demoSnapshot } from './demo';
import { Button, Empty, Field } from './components';
import { OverviewPage, WebsitesPage, SiteDetailPage, PageHeading } from './pages/WorkspacePages';
import { AddSitesForm } from './pages/AddSitesForm';
import { dateTime, nextTask, todoTasks, uiCopy, taskWithPlatform } from './dashboard-model';
import { taskDisplayState, taskReasonForDisplay } from './presentation';
import { PlatformsPage } from './pages/PlatformsPage';
import { FirstRunWizard } from './pages/FirstRunWizard';
import { SiteTools } from './pages/SiteTools';
import { LinksPage } from './pages/LinksPage';
import { SettingsPage } from './pages/SettingsPage';
import { TaskCenter } from './pages/TaskCenter';
import { UpdateCenter } from './pages/UpdateCenter';
import { UpdateReminder, updateReminder, useUpdateStatus } from './update-reminder';
import { DraftCopyActions } from './pages/DraftCopyActions';
import { monthlyPageProgress, monthlyReset, planningStatus } from './planning-status';
import { needsDedicatedConnection } from './account-guidance';
import { articleReviewDetail, articleReviewTitle, canRestartArticleReview, canResumeDeferredTask, canRetryTaskManually, canUseOneReviewRetry, isUserActionTask, oneReviewRetryLabel, taskAutomaticFollowupAt, taskCanManuallyRecoverNostr, taskHasArticleReview, taskHasSubmissionEvidence, taskMessageForDisplay, taskNeedsTelegraphReconciliation, taskPresentation, taskSortRank } from './presentation';
import { HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT, HTML_APP_TERMS_URL, htmlAppPublicNoticeAccepted } from '../shared/html-app-notice';
type Page = 'websites' | 'overview' | 'tasks' | 'tracking' | 'channels' | 'accounts' | 'settings' | 'updates' | 'site';
type Modal = 'add' | 'editSite' | 'migrateSite' | 'account' | 'draft' | 'url' | 'backupExport' | 'backupImport' | 'deleteSite' | 'deleteAccount' | null;
type IconType = typeof House;
const categoryText: Record<Category, string> = {
  software: '软件',
  ai: '人工智能',
  developer: '开发工具',
  design: '设计',
  business: '商业',
  content: '内容',
  education: '教育',
  finance: '金融',
  general: '综合'
};
const taskText: Record<TaskStatus, string> = {
  queued: '等待执行',
  running: '执行中',
  needs_input: '需要处理',
  review: '等待确认',
  live: '当前有效',
  failed: '执行失败',
  skipped: '已跳过',
  expired: '审核超时'
};
const fmt = (date?: string) => {
  if (!date) return '—';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? date : new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric'
  }).format(d);
};
const fullDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long'
});
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const cleanDomain = (value: string) => value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
const isDomain = (value: string) => /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value);
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
export function LinkRelDetail({
  rel
}: {
  rel: string | undefined;
}) {
  return rel === undefined ? null : <><dt>链接属性</dt>
<dd>{rel || 'follow'}</dd></>;
}
function Dialog({
  title,
  children,
  onClose,
  width = 'medium'
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: 'medium' | 'wide';
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Re-renders (the clock, snapshot broadcasts) must not move focus or re-arm the keys: keep the latest onClose in a ref.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('.dialog-form input,.dialog-form select,.dialog-form textarea') ?? ref.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Esc while an input method is composing only cancels the composition.
      if (e.key === 'Escape' && !e.isComposing) closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const all = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
        if (!all.length) return;
        const first = all[0],
          last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={e => {
    if (e.target === e.currentTarget) onClose();
  }}><div ref={ref} className={`dialog ${width}`} role="dialog" aria-modal="true" aria-label={title}><div className="dialog-head"><h2>{title}</h2>
<button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>
{children}</div></div>;
}
function SiteReviewModePicker({
  value,
  onChange,
  name,
  editing = false
}: {
  value: ArticleReviewMode;
  onChange: (value: ArticleReviewMode) => void;
  name: string;
  editing?: boolean;
}) {
  return <fieldset className="site-review-mode"><legend>发布方式</legend>
<div className="site-review-options"><label className={value === 'ai' ? 'selected' : ''}><input type="radio" name={name} value="ai" checked={value === 'ai'} onChange={() => onChange('ai')} />
<strong>全自动（推荐）</strong></label>
<label className={value === 'manual' ? 'selected' : ''}><input type="radio" name={name} value="manual" checked={value === 'manual'} onChange={() => onChange('manual')} />
<strong>每篇我先看</strong></label></div>
<small>每篇我先看：稿子写好后等你确认，48 小时没看就放弃这篇。</small></fieldset>;
}
/** The sidebar says what the update is actually doing; a recovery never reads as a new version. */
function sidebarUpdateText(state: UpdateState, key: string) {
  const version = state.targetVersion ? ` ${state.targetVersion}` : '';
  if (key.startsWith('recovery:')) return '上次更新待恢复';
  if (key.startsWith('downloading:')) return `正在下载新版本${version}`;
  if (key.startsWith('prepared:')) return `新版本${version} 待安装`;
  if (key.startsWith('failed:')) return state.targetVersion ? `更新${version} 没有完成` : '暂时无法检查更新';
  return `有新版本${version}`;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [pendingConnect, setPendingConnect] = useState<{ channelId: string; nonce: number }>();
  const wizardChecked = useRef(false);
  // The first-run guide opens once on a fresh install; once closed, the overview's empty state takes over.
  useEffect(() => {
    if (wizardChecked.current || !snapshot) return;
    wizardChecked.current = true;
    let seen = false;
    try { seen = localStorage.getItem('linkflow.firstRunClosed') === '1'; } catch { /* per-device convenience only */ }
    if (!seen && !snapshot.sites.length) setWizardOpen(true);
  }, [snapshot]);
  const closeWizard = () => { setWizardOpen(false); try { localStorage.setItem('linkflow.firstRunClosed', '1'); } catch { /* ignore */ } };
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const readySent=useRef(false);
  useEffect(()=>{
    if(!api||!snapshot||readySent.current)return;
    readySent.current=true;
    void api.invoke('app:ready').catch(()=>{readySent.current=false});
  },[snapshot]);
  const [demo, setDemo] = useState(false),
    [page, setPage] = useState<Page>('overview'),
    [modal, setModal] = useState<Modal>(null);
  // A connection request from the guide is used once, when the platforms page first opens.
  useEffect(() => { if (page !== 'accounts' && page !== 'channels') setPendingConnect(undefined); }, [page]);
  const [trackingSite, setTrackingSite] = useState('all');
  const [selectedSite, setSelectedSite] = useState(''),
    [selectedTask, setSelectedTask] = useState(''),
    [selectedAccount, setSelectedAccount] = useState('');
  const [pending, setPending] = useState(false),
    [siteSearch, setSiteSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState('all'),
    [taskCenterStatus, setTaskCenterStatus] = useState('active');
  const [domain, setDomain] = useState(''),
    [email, setEmail] = useState(''),
    [target, setTarget] = useState(2);
  const [siteReviewMode, setSiteReviewMode] = useState<ArticleReviewMode>('manual');
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [category, setCategory] = useState<Category>('general'),
    [language, setLanguage] = useState('zh');
  const [accountChannel, setAccountChannel] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [accountMailbox, setAccountMailbox] = useState(''),
    [accountSiteIds, setAccountSiteIds] = useState<string[]>([]);
  const [draftTitle, setDraftTitle] = useState(''),
    [draftDescription, setDraftDescription] = useState(''),
    [draftBody, setDraftBody] = useState(''),
    [url, setUrl] = useState(''),
    [migrationDomain, setMigrationDomain] = useState(''),
    [migrationTaskId, setMigrationTaskId] = useState(''),
    [passphrase, setPassphrase] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null),
    [apiKey, setApiKey] = useState(''),
    [mailPassword, setMailPassword] = useState('');
  const settingsDirty = useRef(false);
  // The settings as they were when editing began: a save submits only what differs from this, so values the
  // backend changed meanwhile (auto-run, paused platforms, an adopted AI limit) are never sent back stale.
  const settingsBase = useRef<Settings | null>(null);
  const mounted = useRef(true),
    refreshPromise = useRef<Promise<void> | null>(null),
    refreshQueued = useRef(false);
  const api = window.linkflow;
  const updateState = useUpdateStatus(!demo),
    updateNotice = updateReminder(updateState);
  useEffect(() => {
    let active: HTMLElement | null = null,
      previous: HTMLElement | null = null;
    const focusable = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')].filter(element => element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true');
    const sync = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      const next = dialogs.at(-1) ?? null;
      if (next === active) return;
      if (!next) {
        if (previous?.isConnected) previous.focus();
        active = null;
        return;
      }
      previous = document.activeElement as HTMLElement | null;
      active = next;
      focusable(next)[0]?.focus();
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    const trap = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Tab' || !active) return;
      const choices = focusable(active);
      if (!choices.length) {
        event.preventDefault();
        return;
      }
      const first = choices[0],
        last = choices.at(-1)!;
      if (!active.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', trap);
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (!api) {
      if (mounted.current) {
        setSnapshot(null);
        setLoading(false);
      }
      return Promise.resolve();
    }
    if (refreshPromise.current) {
      refreshQueued.current = true;
      return refreshPromise.current;
    }
    const promise = (async () => {
      do {
        refreshQueued.current = false;
        try {
          const next = await api.invoke<Snapshot>('snapshot');
          if (mounted.current) setSnapshot(next);
        } catch (e) {
          if (mounted.current) setError(errorText(e));
        }
      } while (refreshQueued.current && mounted.current);
      if (mounted.current) setLoading(false);
    })();
    refreshPromise.current = promise;
    void promise.finally(() => {
      if (refreshPromise.current === promise) refreshPromise.current = null;
    });
    return promise;
  }, []);
  useEffect(() => {
    void refresh();
    const unsub = window.linkflow?.onChange(() => {
      void refresh();
    });
    return () => unsub?.();
  }, [refresh]);
  useEffect(() => {
    settingsDirty.current = false;
    settingsBase.current = null;
    setSettings(demo ? demoSnapshot.settings : snapshot?.settings ?? null);
  }, [demo]);
  useEffect(() => {
    if (!demo && !settingsDirty.current) setSettings(snapshot?.settings ?? null);
  }, [snapshot, demo]);
  const data = demo ? demoSnapshot : snapshot;
  const [clockNow, setClockNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.appearance ?? 'system';
  }, [settings?.appearance]);
  const importableAccountChannels = data?.channels.filter(channel => channel.automation !== 'api' && !needsDedicatedConnection(channel.id)) ?? [];
  const reviewModeFor = (candidate: Site) => getArticleReviewMode(candidate, data?.settings ?? demoSnapshot.settings);
  const act = useCallback(async <T,>(command: string, payload?: unknown, success?: string): Promise<T | undefined> => {
    if (demo) {
      setError('演示模式仅供预览。请关闭演示模式后操作真实数据。');
      return;
    }
    if (!window.linkflow) {
      setError('桌面服务未连接，可开启演示查看界面。');
      return;
    }
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await window.linkflow.invoke<T>(command, payload);
      if (typeof result === 'object' && result !== null && 'cancelled' in result && (result as {
        cancelled?: unknown;
      }).cancelled === true) return result;
      if (!['snapshot', 'settings:test-ai', 'settings:test-mail', 'settings:discover-models', 'account:reveal', 'external:open', 'task:open', 'task:open-result', 'data:export', 'backup:export', 'backup:auto-status', 'app:check-update'].includes(command)) await refresh();
      const resumedSite = command === 'site:pause' && typeof payload === 'object' && payload !== null && 'paused' in payload && (payload as {
        paused?: unknown;
      }).paused === false;
      const defaultSuccess = command === 'task:approve' ? '稿件已确认，任务会继续处理。' : undefined;
      const message = success ?? defaultSuccess;
      if (message) setNotice(!data?.settings.autoRun && (command === 'site:queue-channel' || command === 'task:approve' || resumedSite) ? `${message} 已暂停自动发布；继续自动发布后会继续。` : message);
      return result;
    } catch (e) {
      setError(errorText(e));
      return;
    } finally {
      setPending(false);
    }
  }, [data?.settings.autoRun, demo, refresh]);
  const close = useCallback(() => {
    setModal(null);
    setPassphrase('');
    setPassword('');
  }, []);
  const site = data?.sites.find(s => s.id === selectedSite);
  const chosenTask = data?.tasks.find(t => t.id === selectedTask);
  const account = data?.accounts.find(a => a.id === selectedAccount);
  const accountChannelInfo = account ? data?.channels.find(channel => channel.id === account.channelId) : undefined;
  const accountIsApiIdentity = !!account && (account.credentialKind === 'api_token' || account.credentialKind === 'oauth' || accountChannelInfo?.automation === 'api');
  const zone = data?.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const plannerNow = clockNow;
  // Every date on screen follows the schedule's time zone from 设置; idempotent, so it is safe during render.
  setDisplayTimeZone(data?.settings.timezone);
  const siteForTask = (t: Task) => data?.sites.find(s => s.id === t.siteId);
  const channelForTask = (t: Task) => data?.channels.find(c => c.id === t.channelId);
  const taskChannelEnabled = (task: Task) => channelForTask(task)?.enabled === true;
  const taskReviewMode = (task: Task) => {
    const owner = siteForTask(task);
    return owner ? reviewModeFor(owner) : 'manual';
  };
  const attention = data ? todoTasks(data, plannerNow) : [];
  const migrationRecoveryTasks = site ? data?.tasks.filter(task => task.siteId === site.id && task.status === 'failed' && !!task.topicUrl && !taskHasSubmissionEvidence(task) && (() => {
    try {
      return new URL(task.topicUrl!).origin === new URL(site.url).origin;
    } catch {
      return false;
    }
  })()) ?? [] : [];
  const selectSite = (id: string) => {
    setSelectedTask('');
    setSelectedSite(id);
    setPage('site');
    setTaskFilter('all');
  };
  const openAdd = () => {
    setDomain('');
    setEmail(data?.settings.mail.user ?? '');
    setTarget(2);
    setSiteReviewMode(data?.settings.articleReviewMode ?? 'manual');
    setModal('add');
  };
  const openEdit = (s: Site) => {
    setSelectedSite(s.id);
    setName(s.name);
    setDescription(s.description);
    setCategory(s.category);
    setLanguage(s.language);
    setTarget(s.monthlyTarget);
    setEmail(s.email);
    setSiteReviewMode(reviewModeFor(s));
    setModal('editSite');
  };
  const proposalHost = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  // Closing the dialog only hides it for now; the proposal is dropped only by「保持原来的」.
  const [hiddenProposals, setHiddenProposals] = useState<string[]>([]);
  const hideProposal = () => { if (site) setHiddenProposals(previous => [...previous, site.id]); };
  const openMigration = (s: Site) => {
    setSelectedSite(s.id);
    setMigrationDomain('');
    setMigrationTaskId('');
    setModal('migrateSite');
  };
  const openAccount = (a?: Account, preferredChannel?: string) => {
    const selected = preferredChannel && importableAccountChannels.some(channel => channel.id === preferredChannel) ? preferredChannel : '';
    setSelectedAccount(a?.id ?? '');
    setAccountChannel(a?.channelId ?? selected);
    setEmail(a?.email ?? '');
    setUsername(a?.username ?? '');
    setPassword('');
    setAccountMailbox(a?.mailboxId ?? '');
    setAccountSiteIds(a ? data?.accountBindings.filter(binding => binding.accountId === a.id).map(binding => binding.siteId) ?? [] : []);
    setModal('account');
  };
  const openDraft = (t: Task) => {
    setSelectedTask(t.id);
    setDraftTitle(t.draft?.title ?? '');
    setDraftDescription(t.draft?.description ?? '');
    setDraftBody(t.draft?.body ?? '');
    setModal('draft');
  };
  const openUrl = (t: Task) => {
    setSelectedTask(t.id);
    setUrl(t.publicUrl ?? '');
    setModal('url');
  };
  const saveSite = async (e: FormEvent) => {
    e.preventDefault();
    if (!site || email && !isEmail(email)) {
      setError('请输入有效的公开联系邮箱。');
      return;
    }
    if (!Number.isInteger(target) || target < 1 || target > 20) {
      setError('每月几条须为 1–20 个。');
      return;
    }
    const result = await act('site:update', {
      id: site.id,
      name,
      description,
      category,
      language,
      monthlyTarget: target,
      email: email.trim(),
      publicEmail: email.trim(),
      articleReviewMode: siteReviewMode
    }, '网站资料已保存。');
    if (result) close();
  };
  const saveMigration = async (e: FormEvent) => {
    e.preventDefault();
    if (!site || site.status !== 'paused') {
      setError('请先暂停这个网站。');
      return;
    }
    const next = cleanDomain(migrationDomain);
    if (!isDomain(next)) {
      setError('请输入有效的新域名。');
      return;
    }
    const result = await act<{
      ok?: boolean;
      cancelled?: boolean;
    }>('site:migrate-origin', {
      id: site.id,
      expectedDomain: site.domain,
      expectedUrl: site.url,
      newUrl: `https://${next}/`,
      ...(migrationTaskId ? {
        recoveryTaskId: migrationTaskId
      } : {}),
      operatorAuthorized: true
    }, data?.settings.autoRun ? '域名已更换，这个网站已恢复自动发布。' : '域名已更换。自动发布目前是暂停的，开启后这个网站会照常发布。');
    if (result?.ok) close();
  };
  const saveAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (accountIsApiIdentity && account) {
      const result = await act('account:set-bindings', {
        accountId: account.id,
        mailboxId: accountMailbox || null,
        siteIds: accountSiteIds
      }, '发布账号设置已保存；发布资格仍会在任务中检查。');
      if (result) close();
      return;
    }
    if (!importableAccountChannels.some(channel => channel.id === accountChannel) || !isEmail(email) || !username.trim()) {
      setError('请选择可导入的平台，并填写有效邮箱和用户名。');
      return;
    }
    const result = await act('account:save', {
      id: selectedAccount || undefined,
      channelId: accountChannel,
      email: email.trim(),
      username: username.trim(),
      password: password || undefined,
      mailboxId: accountMailbox || null,
      siteIds: accountSiteIds
    }, '账号已保存；请按账号页显示的下一步确认状态。');
    if (result) close();
  };
  const saveSettings = async () => {
    if (!settings) return false;
    // Only what was edited here: a stale copy must not undo changes made meanwhile (paused platforms, auto-run).
    const saved = (settingsBase.current ?? data?.settings) as Record<string, unknown> | undefined;
    const changed = saved ? Object.fromEntries(Object.entries(settings).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved[key]))) : settings;
    const result = await act<Snapshot>('settings:save', {
      ...changed,
      apiKey: apiKey || undefined,
      mailPassword: mailPassword || undefined
    });
    if (!result) return false;
    settingsDirty.current = false;
    settingsBase.current = null;
    setSettings(result.settings);
    setApiKey('');
    setMailPassword('');
    return true;
  };
  const submitSimple = async (e: FormEvent, command: string, payload: unknown, message: string) => {
    e.preventDefault();
    const result = await act(command, payload, message);
    if (result) close();
  };
  const nav = (to: Page) => {
    setPage(to);
    setError('');
    setNotice('');
  };
  const settingsContent = <SettingsPage initialSection={page === 'updates' ? 'update' : 'ai'} settings={settings} setSettings={next => {
    if (!settingsDirty.current) settingsBase.current = settings;
    settingsDirty.current = true;
    setSettings(next);
  }} mergeSaved={patch => {
    // Already saved by the backend: show it here without marking the form as edited.
    setSettings(previous => previous ? { ...previous, ...patch } : previous);
    if (settingsBase.current) settingsBase.current = { ...settingsBase.current, ...patch };
  }} snapshot={data} apiKey={apiKey} setApiKey={setApiKey} mailPassword={mailPassword} setMailPassword={setMailPassword} disabled={pending || demo} onSave={saveSettings} onAction={act} onResult={(ok, message) => (ok ? setNotice : setError)(message)} onBackup={kind => setModal(kind === 'export' ? 'backupExport' : 'backupImport')} onOpenUpdate={() => nav('updates')} updateContent={<UpdateCenter embedded demo={demo} platform={data?.runtime.platform} currentVersion={data?.runtime.version} taskBusy={!!data?.runtime.busy} onResult={(ok, message) => (ok ? setNotice : setError)(message)} />} />;
  const goTodo = (task: Task) => {
    setSelectedTask(task.id);
    nav('tasks');
  };
  return <div className="app-shell">
    <aside className="sidebar"><div className="traffic" aria-hidden="true" />
<div className="brand"><span className="brand-mark"><LinkSimple size={38} weight="bold" /></span>
<div><strong>外链助手</strong></div></div>
      <nav aria-label="主导航" className="nav">
        <NavButton icon={House} active={page === 'overview'} onClick={() => nav('overview')}>总览</NavButton>
        <NavButton icon={FileText} active={page === 'websites' || page === 'site'} onClick={() => nav('websites')}>网站</NavButton>
        <NavButton icon={Bell} active={page === 'tasks'} onClick={() => nav('tasks')}>待办{attention.length > 0 && <em className="todo-count">{attention.length}</em>}</NavButton>
        <NavButton icon={LinkSimple} active={page === 'tracking'} onClick={() => { setTrackingSite('all'); nav('tracking'); }}>外链</NavButton>
        <NavButton icon={UserCircle} active={page === 'channels' || page === 'accounts'} onClick={() => nav('channels')}>平台与账号</NavButton>
        <NavButton icon={Gear} active={page === 'settings' || page === 'updates'} onClick={() => nav('settings')}>设置</NavButton>
      </nav>
      <div className="sidebar-bottom">{updateState && updateNotice && <div className="sidebar-update"><span>{sidebarUpdateText(updateState, updateNotice.key)}</span>
<Button variant="text" onClick={() => nav('updates')}>查看</Button></div>}
      <div className="runtime-indicator"><span className={`dot ${data?.settings.autoRun ? 'green' : 'gray'}`} />
<div>{data?.settings.autoRun ? <strong>自动发布中 · 下一条 {dateTime(nextTask(data.tasks, plannerNow)?.scheduledAt)}</strong> : <><strong>已暂停自动发布</strong>
<Button variant="text" disabled={pending || demo || !data} onClick={() => void act('plan:run', undefined, '已继续自动发布。')}>继续</Button></>}</div></div></div>
    </aside>
    <main className="main"><div className="topline"><span />
<span>{fullDate.format(plannerNow)}</span></div>
      {!api && !demo && <div className="banner warning"><span>桌面服务未连接，可开启演示查看界面。</span>
<Button variant="text" onClick={() => setDemo(true)}>开启演示</Button></div>}
      {api && !demo && <button className="demo-switch" onClick={() => setDemo(true)}>预览演示</button>}
      {demo && <button className="demo-exit" onClick={() => setDemo(false)}>演示模式 · 返回真实数据</button>}
      {error && <div role="alert" className="banner error"><WarningCircle size={18} />
<span>{error}</span>
<button aria-label="关闭错误" onClick={() => setError('')}><X size={18} /></button></div>}
      {notice && <div role="status" className="banner success"><CheckCircle size={18} />
<span>{notice}</span>
<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={18} /></button></div>}
      {loading && !data ? <div className="loading">正在读取本地数据…</div> : page === 'overview' && data ? <OverviewPage data={data} now={plannerNow} disabled={pending || demo} onAction={act} onSite={selectSite} onAdd={openAdd} onTodos={() => nav('tasks')} onSettings={() => nav('settings')} onPlatforms={() => nav('channels')} onTask={goTodo} /> : page === 'websites' && data ? <WebsitesPage data={data} now={plannerNow} disabled={pending || demo} onAction={act} onSite={selectSite} onAdd={openAdd} onDelete={id => { setSelectedSite(id); setModal('deleteSite'); }} /> : page === 'site' && site && data ? <SiteDetailPage key={site.id} site={site} data={data} initialTab={selectedTask ? 'schedule' : 'links'} now={plannerNow} disabled={demo || pending} onAction={act} onBack={() => nav('websites')} onEdit={() => openEdit(site)} onMigrate={() => openMigration(site)} renderTask={task => <TaskCard key={task.id} task={taskWithPlatform(task, data)} channel={channelForTask(task)} now={plannerNow} selected={selectedTask === task.id} onSelect={() => setSelectedTask(selectedTask === task.id ? '' : task.id)} onAction={async (command, payload, success) => {
        await act(command, payload, success);
      }} onDraft={() => openDraft(task)} onUrl={() => openUrl(task)} demo={demo || pending} reviewMode={reviewModeFor(site)} siteReady={site.status === 'ready'} htmlAppNoticeAccepted={htmlAppPublicNoticeAccepted(data.settings.htmlAppPublicNotice)} />} tools={<SiteTools site={site} data={data} disabled={demo || pending} onAction={act} onTracking={() => {
        setTrackingSite(site.id);
        nav('tracking');
      }} />} /> : page === 'tasks' ? <TaskCenter data={data} now={plannerNow} disabled={demo || pending} status={taskCenterStatus} onStatusChange={setTaskCenterStatus} onAction={act} onEditDraft={openDraft} onSetUrl={openUrl} onSite={(id, taskId) => {
        selectSite(id);
        if (taskId) setSelectedTask(taskId);
      }} onAccount={() => nav('accounts')} /> : page === 'tracking' && data ? <LinksPage key={trackingSite} data={data} now={plannerNow} disabled={demo || pending} initialSiteId={trackingSite} onAction={act} onSite={selectSite} /> : (page === 'channels' || page === 'accounts') && data ? <PlatformsPage data={data} initialConnect={pendingConnect} onInitialConnectHandled={() => setPendingConnect(undefined)} tab={page === 'accounts' ? 'accounts' : 'platforms'} onTab={tab => nav(tab === 'accounts' ? 'accounts' : 'channels')} disabled={pending || demo} onAction={act} onTask={selectSite} onImport={channelId => openAccount(undefined, channelId)} onEditAccount={openAccount} onDeleteAccount={a => {
          setSelectedAccount(a.id);
          setModal('deleteAccount');
        }} onSetup={openAdd} /> : settingsContent}
    </main>

    {wizardOpen && data && !demo && <Dialog title="开始使用外链助手" width="wide" onClose={closeWizard}><FirstRunWizard data={data} disabled={pending} onAction={act} onClose={closeWizard} onSettings={() => { setWizardOpen(false); nav('settings'); }} onConnect={channelId => { closeWizard(); setPendingConnect({ channelId, nonce: Date.now() }); nav('accounts'); }} onOverview={() => { closeWizard(); nav('overview'); }} /></Dialog>}
    {modal === 'add' && <Dialog title="添加网站" onClose={close}><AddSitesForm disabled={pending || demo} onAction={act} onClose={close} defaultMode={data?.settings.articleReviewMode === 'manual' ? 'manual' : 'ai'} /></Dialog>}
    {modal === 'editSite' && site && <Dialog title="编辑网站" onClose={close}><form onSubmit={saveSite} className="dialog-form"><Field label="网站名称"><input value={name} onChange={e => setName(e.target.value)} /></Field>
<Field label="网站简介"><textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} /></Field>
<div className="form-grid"><Field label="类别"><select value={category} onChange={e => setCategory(e.target.value as Category)}>{Object.entries(categoryText).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
<Field label="语言"><input value={language} onChange={e => setLanguage(e.target.value)} /></Field></div>
<div className="form-grid"><Field label="公开联系邮箱" hint="部分平台会公开显示，建议用专用邮箱。"><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
<Field label="每月几条" hint={site.planStatus ? `按现有平台，每站每月最多约 ${site.planStatus.capacity} 条${target > site.planStatus.capacity ? '；超过的部分会按上限执行' : ''}` : undefined}><input type="number" min="1" max="20" required value={target} className={site.planStatus && target > site.planStatus.capacity ? 'over-capacity' : undefined} onChange={e => setTarget(Number(e.target.value))} /></Field></div>
<SiteReviewModePicker name="edit-site-review-mode" value={siteReviewMode} onChange={setSiteReviewMode} editing />
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="primary" type="submit" disabled={pending}>保存</Button></div></form></Dialog>}
    {modal === 'migrateSite' && site && <Dialog title="更换域名" onClose={close}><form onSubmit={saveMigration} className="dialog-form"><p className="dialog-intro">更换后保留历史外链和发布账号，并重新读取网站文章。请先暂停自动发布。</p>
<Field label="当前网址"><input value={site.url} readOnly /></Field>
<Field label="新域名"><input required autoCapitalize="off" value={migrationDomain} onChange={e => setMigrationDomain(e.target.value)} placeholder="new-site.example" /></Field>
<Field label="恢复原失败任务（可选）" hint="只恢复所选的同一个未提交任务一次；累计 AI 调用、重试和换题记录不会清零。"><select value={migrationTaskId} onChange={e => setMigrationTaskId(e.target.value)}><option value="">不恢复旧失败任务</option>
{migrationRecoveryTasks.map(task => <option key={task.id} value={task.id}>{data?.channels.find(channel => channel.id === task.channelId)?.name ?? task.channelId} · {task.topicUrl} · 尝试 {task.attempts} / AI {task.cost?.aiCalls ?? 0}</option>)}</select></Field>
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="primary" type="submit" disabled={pending || demo}>核对并迁移</Button></div></form></Dialog>}
    {modal === 'account' && <Dialog title={accountIsApiIdentity ? '编辑发布账号设置' : account ? '编辑账号与关联' : '导入普通账号'} onClose={close}><form onSubmit={saveAccount} className="dialog-form">{accountIsApiIdentity && account ? <p className="dialog-intro">{accountChannelInfo?.name ?? 'API 平台'} · {account.username}。这是由任务自动创建或通过专用入口连接的发布账号；此处只管理网站与收件箱关联，不会覆盖已保存的密钥。保存关联不代表平台当前可发布。</p> : <><p className="dialog-intro">这里只导入没有专用连接流程的普通登录账号。API、OAuth、SSH 或只读平台请关闭此窗口，并从账号页选择对应平台；软件不会把普通密码保存当作连接成功。</p>
<Field label="平台"><select aria-label="普通账号平台" value={accountChannel} onChange={e => setAccountChannel(e.target.value)} required><option value="">先选择平台</option>
{importableAccountChannels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></Field>
<div className="form-grid"><Field label="登录邮箱"><input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
<Field label="用户名"><input autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} /></Field></div></>}
<Field label="验证收件箱" hint="登录邮箱、网站公开邮箱和自动收件连接可以不同"><select value={accountMailbox} onChange={e => setAccountMailbox(e.target.value)}><option value="">自动选择 / 不关联</option>
{data?.mailboxes.map(box => <option key={box.id} value={box.id}>{box.label} · {box.user}</option>)}</select></Field>
<fieldset className="checkbox-grid"><legend>关联网站</legend>
{data?.sites.map(item => <label key={item.id}><input type="checkbox" checked={accountSiteIds.includes(item.id)} onChange={e => setAccountSiteIds(e.target.checked ? [...accountSiteIds, item.id] : accountSiteIds.filter(id => id !== item.id))} />
{item.domain}</label>)}</fieldset>
{!accountIsApiIdentity && <Field label="密码" hint={account?.hasPassword ? '留空保持原密码' : '仅加密保存在本机；保存后仍需确认平台账号状态'}><input aria-label="普通账号密码" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>}
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="primary" type="submit" disabled={pending}>{accountIsApiIdentity ? '保存关联' : '保存账号'}</Button></div></form></Dialog>}
    {modal === 'draft' && chosenTask && <Dialog title={chosenTask.channelId === 'raindrop' ? '编辑资源短评' : '编辑投稿草稿'} onClose={close} width="wide"><form onSubmit={e => void submitSimple(e, 'task:update-draft', {
        id: chosenTask.id,
        title: draftTitle,
        description: draftDescription,
        body: draftBody
      }, '草稿已保存。')} className="dialog-form"><Field label="标题"><input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} /></Field>
<Field label={chosenTask.channelId === 'raindrop' ? '本机摘要（不发布）' : '摘要'}><textarea rows={3} value={draftDescription} onChange={e => setDraftDescription(e.target.value)} /></Field>
<Field label={chosenTask.channelId === 'raindrop' ? '公开短评' : '正文'} hint={chosenTask.channelId === 'raindrop' ? '请填写 80–2000 字符的纯文本短评，保留有用说明及必要的商业关系披露。这段文字将完整发布到公开合集，目标链接沿用本任务核对的网址。' : undefined}><textarea rows={10} value={draftBody} onChange={e => setDraftBody(e.target.value)} /></Field>
<DraftCopyActions taskId={chosenTask.id} title={draftTitle} description={draftDescription} body={draftBody} />
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="primary" type="submit" disabled={pending}>保存草稿</Button></div></form></Dialog>}
    {modal === 'url' && chosenTask && <Dialog title="填写外链地址" onClose={close}><form onSubmit={e => void submitSimple(e, 'task:set-url', {
        id: chosenTask.id,
        url: url.trim()
      }, '地址已保存。')} className="dialog-form"><p className="dialog-intro">填写外链的完整地址；保存后外链助手会自动检查这条链接。</p>
<Field label="外链地址"><input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/page" /></Field>
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="primary" type="submit" disabled={pending}>保存地址</Button></div></form></Dialog>}
    {(modal === 'backupExport' || modal === 'backupImport') && <Dialog title={modal === 'backupExport' ? '导出加密备份' : '导入加密备份'} onClose={close}><form onSubmit={async e => {
        e.preventDefault();
        if (passphrase.length < 12 || passphrase.length > 256) {
          setError('备份口令需要 12–256 个字符。');
          return;
        }
        const command = modal === 'backupExport' ? 'backup:export' : 'backup:import';
        const r = await act<{
          ok: boolean;
          message: string;
        }>(command, {
          passphrase
        });
        if (r?.ok) {
          setNotice(r.message);
          close();
        } else if (r) setError(r.message);
      }} className="dialog-form"><p className="dialog-intro">{modal === 'backupImport' ? '请选择已有备份文件并输入其口令。导入前建议先导出当前数据。' : '备份包含网站、任务和账号关联。请妥善保存口令。'}</p>
<Field label="备份口令"><input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={passphrase} onChange={e => setPassphrase(e.target.value)} /></Field>
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="primary" type="submit" disabled={pending}>{modal === 'backupImport' ? '选择文件并导入' : '选择位置并导出'}</Button></div></form></Dialog>}
    {page === 'site' && !modal && site?.analysisProposal?.url && proposalHost(site.analysisProposal.url) !== site.domain && !hiddenProposals.includes(site.id) && <Dialog title="网址好像变了" onClose={hideProposal}><div className="dialog-form">
      <p className="dialog-intro">分析发现这个站现在是 {site.analysisProposal.url}，原来填的是 {site.url}。</p>
      <p className="muted">重新分析只补空着的信息，不会改你填过的内容。{site.status === 'paused' ? '' : '更换域名前要先暂停这个网站。'}</p>
      <div className="dialog-actions"><Button onClick={() => void act('site:dismiss-proposal', { id: site.id })}>保持原来的</Button>
        <Button variant="primary" disabled={pending || demo} onClick={async () => {
          const next = site.analysisProposal?.url;
          if (site.status !== 'paused' && await act('site:pause', { id: site.id, paused: true }) === undefined) return;
          openMigration(site);
          if (next) setMigrationDomain(proposalHost(next));
        }}>{site.status === 'paused' ? '用新网址' : '暂停并更换域名'}</Button></div></div></Dialog>}
    {modal === 'deleteSite' && site && <Dialog title="删除网站本地记录" onClose={close}><div className="dialog-form"><p className="dialog-intro">将删除 {site.domain} 的本地计划、任务和记录。已发布在第三方网站的外链不会被删除。</p>
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="danger" onClick={async () => {
            const r = await act('site:delete', {
              id: site.id
            }, '网站已删除。');
            if (r) {
              close();
              // Stay where the delete was started; only a deleted site's own page has to be left.
              if (page === 'site') nav('websites');
            }
          }} disabled={pending}>确认删除</Button></div></div></Dialog>}
    {modal === 'deleteAccount' && account && <Dialog title="删除保存的账号" onClose={close}><div className="dialog-form"><p className="dialog-intro">将从本机删除 {account.email} 的账号记录和{accountIsApiIdentity ? '保存的 API 密钥' : '保存的密码'}。</p>
<div className="dialog-actions"><Button onClick={close}>取消</Button>
<Button variant="danger" onClick={async () => {
            const r = await act('account:delete', {
              id: account.id
            }, '账号已删除。');
            if (r) {
              close();
            }
          }} disabled={pending}>确认删除</Button></div></div></Dialog>}
  </div>;
}
function NavButton({
  icon: Icon,
  active,
  onClick,
  children
}: {
  icon: IconType;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} aria-label={typeof children === 'string' ? children : undefined} aria-current={active ? 'page' : undefined}><Icon size={23} weight={active ? 'fill' : 'regular'} />
<span>{children}</span></button>;
}
function Stat({
  label,
  value,
  icon: Icon
}: {
  label: string;
  value: string;
  icon: IconType;
}) {
  return <div className="stat panel"><div><Icon size={20} />
<span>{label}</span></div>
<strong>{value}</strong></div>;
}
export function TaskCard({
  task,
  channel,
  now,
  selected,
  onSelect,
  onAction,
  onDraft,
  onUrl,
  demo,
  reviewMode = 'manual',
  siteReady = true,
  htmlAppNoticeAccepted = false
}: {
  task: Task;
  channel?: Channel;
  now: Date;
  selected: boolean;
  onSelect: () => void;
  onAction: (command: string, payload: unknown, success?: string) => Promise<void>;
  onDraft: () => void;
  onUrl: () => void;
  demo: boolean;
  reviewMode?: 'manual' | 'ai';
  siteReady?: boolean;
  htmlAppNoticeAccepted?: boolean;
}) {
  const display = taskDisplayState(task, now);
  const reasonText = taskReasonForDisplay(task, now);
  const isArticleReview = taskHasArticleReview(task),
    articleReview = isArticleReview ? task.articleReview : undefined,
    presentation = taskPresentation(task, reviewMode, channel?.enabled === true);
  const humanAuthoredOnly = isHumanAuthoredOnlyChannel(task.channelId);
  const allowManualApproval = isArticleReview && task.checkpoint === 'article_review' && task.draft && reviewMode === 'manual' && isUserActionTask(task, reviewMode, channel?.enabled === true);
  const canRestartReview = canRestartArticleReview(task, reviewMode, channel?.enabled === true),
    canReviewOnce = canUseOneReviewRetry(task, reviewMode, channel?.enabled === true),
    canRetry = canRetryTaskManually(task, reviewMode, channel?.enabled === true),
    canResume = canResumeDeferredTask(task),
    canRecoverNostr = taskCanManuallyRecoverNostr(task, channel?.enabled === true, siteReady),
    followupAt = taskAutomaticFollowupAt(task, channel?.enabled === true);
  return <article className={`task-card ${selected ? 'selected' : ''}`}><button className="task-summary" onClick={onSelect} aria-expanded={selected}><span className={`timeline-dot state-${display.state}`} />
<span className="task-main"><strong>{channel?.name ?? task.sourceDomain}</strong>
<small>{task.sourceDomain} · 更新于 {fmt(task.updatedAt)}</small></span>
<span className={`badge state-${display.state}`}>{display.label}</span>
<CaretDown size={16} className={selected ? 'rotated' : ''} /></button>
{selected && <div className="task-detail"><p>{display.detail}</p>
{display.deadlineText && <p>{display.deadlineText}</p>}
{reasonText && reasonText !== display.detail && display.state === 'action_required' && <p>{reasonText}</p>}
<details className="technical-details"><summary>技术详情</summary>
<p>{task.message}</p></details>
{humanAuthoredOnly && <p className="muted">{HUMAN_AUTHORED_ONLY_NOTICE}</p>}
{task.channelId === 'html-app' && !task.submittedAt && <div className="banner warning"><WarningCircle size={16} />
<span>发布后全文将完全公开，可能被抓取、复制或用于数据收集；免费 best-effort 服务不保证可用性或长期保留。</span>
<Button variant="text" onClick={() => void onAction('external:open', {
          url: HTML_APP_TERMS_URL
        })} disabled={demo}>查看条款</Button>
{!htmlAppNoticeAccepted && <Button variant="primary" onClick={() => void onAction('channel:accept-html-app-public-notice', HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT, '已记录 ht-ml.app 公开发布告知确认。')} disabled={demo}>我已阅读条款并了解</Button>}</div>}
{isArticleReview && <section className={`article-review-status ${articleReview?.status ?? 'pending'}`}><strong>AI 复核</strong>
<details className="technical-details"><summary>技术详情</summary>
<p>{articleReviewDetail(task, reviewMode, channel?.enabled === true)}</p></details>
{articleReview?.reviewedAt && <small>审核时间：{fmt(articleReview.reviewedAt)}</small>}
{articleReview?.evidenceUrls.length ? <><small>审核证据</small>
<ul>{articleReview.evidenceUrls.map((url, index) => <li key={`${url}-${index}`}>{url}</li>)}</ul></> : null}</section>}
<dl>{task.publicationMethod === 'external' && <><dt>发布方式</dt>
<dd>外部发布后接回</dd></>}
<dt>创建时间</dt>
<dd>{fmt(task.createdAt)}</dd>
<dt>计划时间</dt>
<dd>{fmt(task.scheduledAt)}</dd>
{followupAt && <><dt>下次自动操作</dt>
<dd>{fmt(followupAt)}</dd></>}
{(presentation.kind === 'system_retry' || presentation.kind === 'channel_wait') && !followupAt && <><dt>自动后续</dt>
<dd>{taskNeedsTelegraphReconciliation(task, channel?.enabled === true) ? '即将查询' : '未安排'}</dd></>}
<dt>尝试次数</dt>
<dd>{task.attempts}</dd>
{task.publicUrl && <><dt>公开地址</dt>
<dd className="url-value">{task.publicUrl}</dd></>}
<LinkRelDetail rel={task.linkRel} />
{task.verifiedAt && <><dt>检查链接时间</dt>
<dd>{fmt(task.verifiedAt)}</dd></>}
{oneReviewRetryLabel(task) && <><dt>追加审核</dt>
<dd>{oneReviewRetryLabel(task)}</dd></>}</dl>
<div className="task-actions">{task.publicUrl && <Button variant="primary" onClick={() => void onAction('task:open-result', {
          id: task.id
        })} disabled={demo}><ArrowSquareOut size={16} />查看外链</Button>}
{!isArticleReview && <Button onClick={() => void onAction('task:open', {
          id: task.id
        })} disabled={demo}><Play size={16} />打开平台页面</Button>}
<Button onClick={onDraft} disabled={demo}><PencilSimple size={16} />编辑稿件</Button>
<Button onClick={onUrl} disabled={demo}><LinkSimple size={16} />填写地址</Button>
<Button onClick={() => void onAction('task:verify', {
          id: task.id
        })} disabled={demo || !task.publicUrl && !canRecoverNostr}><CheckCircle size={16} />
{canRecoverNostr ? '检查原事件' : '检查链接'}</Button>
{allowManualApproval && <Button variant="primary" onClick={() => void onAction('task:approve', {
          id: task.id
        })} disabled={demo}>已核对稿件，继续发布</Button>}
{canResume && <Button variant="primary" onClick={() => void onAction('task:retry', {
          id: task.id
        }, task.draft ? '已恢复原稿并继续处理。' : '已恢复原任务并继续处理。')} disabled={demo}><ArrowClockwise size={16} />
{task.draft ? '恢复原稿' : '恢复任务'}</Button>}
{canRestartReview && <Button onClick={() => void onAction('task:retry', {
          id: task.id
        })} disabled={demo}><ArrowClockwise size={16} />重新 AI 复核</Button>}
{canReviewOnce && <Button variant="primary" onClick={() => void onAction('task:review-once', {
          id: task.id
        }, '追加 AI 复核已完成。')} disabled={demo}><ArrowClockwise size={16} />追加 1 次 AI 复核</Button>}
{canRetry && <Button onClick={() => void onAction('task:retry', {
          id: task.id
        })} disabled={demo}><ArrowClockwise size={16} />受控重试</Button>}
{!humanAuthoredOnly && !task.draft && !taskHasSubmissionEvidence(task) && <Button onClick={() => void onAction('task:generate', {
          id: task.id
        })} disabled={demo}>生成草稿</Button>}
{task.status !== 'live' && task.status !== 'skipped' && <Button onClick={() => void onAction('task:skip', {
          id: task.id
        })} disabled={demo}>跳过</Button>}</div></div>}</article>;
}
