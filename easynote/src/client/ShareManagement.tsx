import { useEffect, useState } from 'react';
import { CalendarPlus, FileText, Infinity as InfinityIcon, LoaderCircle, Trash2 } from 'lucide-react';
import type { ManagedNoteShare } from '../shared/types';
import { api } from './api';

interface Props {
  disabled: boolean;
  notify(message: string): void;
  openNote(share: ManagedNoteShare): void;
  reportError(message: string): void;
}

const dateTime = (value: number) => new Date(value).toLocaleString('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function ShareManagement({ disabled, notify, openNote, reportError }: Props) {
  const [shares, setShares] = useState<ManagedNoteShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState('');
  const [extensions, setExtensions] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void api.noteShares()
      .then((result) => { if (active) setShares(result.shares); })
      .catch((error: unknown) => reportError(String(error)))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reportError]);

  const extend = async (item: ManagedNoteShare) => {
    const selected = extensions[item.noteId] ?? '168';
    setWorkingId(item.noteId);
    try {
      const result = await api.extendNoteShare(
        item.noteId,
        selected === 'permanent' ? null : Number(selected),
      );
      setShares((current) => current.map((share) =>
        share.noteId === item.noteId ? { ...share, ...result.share } : share));
      notify(selected === 'permanent' ? '分享已设为永久有效' : '分享有效期已延长');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorkingId('');
    }
  };

  const revoke = async (item: ManagedNoteShare) => {
    setWorkingId(item.noteId);
    try {
      await api.revokeNoteShare(item.noteId);
      setShares((current) => current.filter((share) => share.noteId !== item.noteId));
      notify('分享已取消');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorkingId('');
    }
  };

  return <div className="share-management">
    {loading ? <div className="panel-empty"><LoaderCircle className="spin" size={16} />正在读取分享…</div>
      : !shares.length ? <div className="panel-empty">暂无正在分享的笔记</div>
        : <div className="share-management-list">
          {shares.map((item) => {
            const working = workingId === item.noteId;
            return <section className="share-management-row" key={item.noteId}>
              <div className="share-management-main">
                <button className="share-management-note" onClick={() => openNote(item)}>
                  <FileText size={16} />
                  <strong>{item.title || '未命名笔记'}</strong>
                </button>
                <span>
                  {item.archived ? '已归档 · ' : ''}分享于 {dateTime(item.createdAt)} · {item.expiresAt === null
                    ? '永久有效'
                    : `有效至 ${dateTime(item.expiresAt)}`}
                </span>
              </div>
              <div className="share-management-actions">
                {item.expiresAt === null
                  ? <span className="share-permanent"><InfinityIcon size={14} />永久</span>
                  : <>
                    <select aria-label={`${item.title || '未命名笔记'} 延期时长`}
                      value={extensions[item.noteId] ?? '168'}
                      disabled={disabled || working}
                      onChange={(event) => setExtensions((current) => ({
                        ...current,
                        [item.noteId]: event.target.value,
                      }))}>
                      <option value="24">延长 1 天</option>
                      <option value="168">延长 7 天</option>
                      <option value="720">延长 30 天</option>
                      <option value="permanent">设为永久</option>
                    </select>
                    <button aria-label={`延期 ${item.title || '未命名笔记'}`} disabled={disabled || working}
                      onClick={() => void extend(item)}>
                      {working ? <LoaderCircle className="spin" size={15} /> : <CalendarPlus size={15} />}延期
                    </button>
                  </>}
                <button className="danger" aria-label={`取消分享 ${item.title || '未命名笔记'}`}
                  disabled={disabled || working} onClick={() => void revoke(item)}>
                  {working ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}取消分享
                </button>
              </div>
            </section>;
          })}
        </div>}
  </div>;
}
