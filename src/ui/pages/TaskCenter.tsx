import { useState } from 'react';
import {HUMAN_AUTHORED_ONLY_NOTICE} from '../../shared/human-authored-only';
import { CheckCircle } from '@phosphor-icons/react';
import type { Snapshot, Task } from '../../shared/types';
import { Button, Empty } from '../components';
import { taskDisplayState, taskHumanActionGroup, taskHumanActionUrgent, taskReasonForDisplay } from '../presentation';
import { taskWithPlatform, todoTasks, uiCopy } from '../dashboard-model';
import { PageHeading } from './WorkspacePages';
type Props = {
  data: Snapshot | null;
  disabled: boolean;
  status: string;
  onStatusChange: (status: string) => void;
  onAction: <T>(command: string, payload?: unknown, success?: string) => Promise<T | undefined>;
  onEditDraft: (task: Task) => void;
  onSetUrl: (task: Task) => void;
  onSite: (id: string, taskId?: string) => void;
  onAccount?: (task: Task) => void;
  now?: Date;
};
const groupLabels = {
  verification: '要你验证',
  account: '要你连接账号',
  review: '要你看稿',
  manual_write: '要你手写并发布',
  manual_publish: '软件写好、等你发'
} as const;
export function TaskCenter({
  data,
  disabled,
  onAction,
  onEditDraft,
  onSetUrl,
  onSite,
  onAccount,
  now = new Date()
}: Props) {
  const [expanded, setExpanded] = useState('');
  const tasks = data ? todoTasks(data, now) : [];
  const groups = Object.entries(groupLabels).map(([id, label]) => ({
    id,
    label,
    tasks: tasks.filter(t => taskHumanActionGroup(t, now) === id)
  })).filter(g => g.tasks.length).sort((a, b) => Number(taskHumanActionUrgent(b.tasks[0], now)) - Number(taskHumanActionUrgent(a.tasks[0], now)));
  const handle = (task: Task) => {
    if(task.checkpoint==='html_app_public_notice'){onSite(task.siteId,task.id);return;}
    const group = taskHumanActionGroup(task, now);
    if (group === 'account') {
      onAccount?.(task);
      return;
    }
    if (group === 'review' || group === 'manual_publish' || group === 'manual_write') {
      setExpanded(expanded === task.id ? '' : task.id);
      return;
    }
    void onAction('task:open', {
      id: task.id
    });
  };
  return <div className="page todo-page"><PageHeading title="待办" summary={tasks.length ? `${tasks.length} 件事要你处理` : '没有要你处理的事'} />
    {!tasks.length ? <Empty icon={CheckCircle} title="没有要你处理的事" body="没有要你处理的事。外链助手会按计划自动发布。" /> : groups.map(group => <section className="todo-group" key={group.id}><h2>{group.label}</h2>
<div className="todo-grid">{group.tasks.map(task => {
          const display = taskDisplayState(taskWithPlatform(task, data!), now),
            urgent = taskHumanActionUrgent(task, now);
          return <article className={`panel todo-card ${urgent ? 'urgent' : ''}`} key={task.id}>
      <div className="todo-title"><strong>{data?.sites.find(s => s.id === task.siteId)?.domain} · {data?.channels.find(c => c.id === task.channelId)?.name ?? task.sourceDomain}</strong>
{urgent && <span className="badge amber">马上过期</span>}</div>
<p>{group.id === 'manual_write' ? HUMAN_AUTHORED_ONLY_NOTICE : display.detail}</p>
{display.deadlineText && <p className="deadline">{display.deadlineText}</p>}
<div className="heading-actions"><Button variant="primary" disabled={disabled} onClick={() => handle(task)}>{group.id === 'manual_publish' || group.id === 'manual_write' ? '去发布' : display.action ?? '去处理'}</Button>
{(() => {
                // Only when the app can check or resume the step itself; otherwise the card waits for its own result.
                const capability = data?.humanActionCapabilities?.[task.id];
                return capability?.canDone ? <Button disabled={disabled} onClick={() => void onAction('human-action:done', {
                  id: task.id
                }, '好的，外链助手继续处理。')}>{capability.mode === 'confirm_email' ? '确认' : task.humanAction?.kind === 'consent' ? '同意' : '我做完了'}</Button> : null;
              })()}
<Button disabled={disabled} onClick={() => void onAction('task:skip', {
                id: task.id
              }, uiCopy.skipDone)}>跳过</Button></div>
      {expanded === task.id && <div className="todo-expanded">{task.draft && <><h3>{task.draft.title}</h3>
<div className="draft-body">{task.draft.body}</div></>}
<div className="heading-actions"><Button disabled={disabled} onClick={() => onEditDraft(task)}>编辑稿件</Button>
{group.id === 'review' && <Button variant="primary" disabled={disabled || !task.draft} onClick={() => void onAction('task:approve', {
                  id: task.id
                }, uiCopy.approved)}>{uiCopy.confirmArticle}</Button>}
{(group.id === 'manual_publish' || group.id === 'manual_write') && <><Button disabled={disabled} onClick={() => void onAction('task:open', {
                    id: task.id
                  })}>打开平台</Button>
<Button disabled={disabled} onClick={() => onSetUrl(task)}>填写地址</Button></>}
<Button onClick={() => onSite(task.siteId, task.id)}>查看网站</Button></div></div>}
      <details className="technical-details"><summary>{uiCopy.technical}</summary>
<p>{task.message || uiCopy.noTechnical}</p>
<p>{taskReasonForDisplay(task, now)}</p></details>
    </article>;
        })}</div></section>)}
  </div>;
}
