import { useEffect, useState } from 'react';
import { Copy, Link2, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import type { NoteShare } from '../shared/types';
import { api } from './api';

interface Props {
  noteId: string;
  disabled: boolean;
  notify(message: string): void;
  reportError(message: string): void;
}

export function NoteSharing({ noteId, disabled, notify, reportError }: Props) {
  const [share, setShare] = useState<NoteShare | null>(null);
  const [expiresInHours, setExpiresInHours] = useState('168');
  const [url, setUrl] = useState('');
  const [working, setWorking] = useState(true);

  useEffect(() => {
    let active = true;
    setWorking(true);
    void api.noteShare(noteId).then((result) => {
      if (active) setShare(result.share);
    }).catch((error: unknown) => reportError(String(error)))
      .finally(() => { if (active) setWorking(false); });
    return () => { active = false; };
  }, [noteId, reportError]);

  const create = async () => {
    setWorking(true);
    try {
      const result = await api.createNoteShare(noteId, Number(expiresInHours));
      setShare(result.share);
      setUrl(result.url);
      notify('只读分享链接已创建');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  const revoke = async () => {
    setWorking(true);
    try {
      await api.revokeNoteShare(noteId);
      setShare(null);
      setUrl('');
      notify('分享链接已撤销');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  return <div className="note-sharing">
    {share && <div className="share-status">
      <Link2 size={17} />
      <div><strong>分享有效</strong><span>截止 {new Date(share.expiresAt).toLocaleString('zh-CN')}</span></div>
    </div>}
    {url && <div className="share-url" role="status">
      <input readOnly aria-label="只读分享链接" value={url} onFocus={(event) => event.currentTarget.select()} />
      <button onClick={() => void navigator.clipboard.writeText(url)
        .then(() => notify('分享链接已复制')).catch((error) => reportError(String(error)))}>
        <Copy size={15} />复制
      </button>
    </div>}
    <label className="single-field">有效期<select value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)}>
      <option value="1">1 小时</option>
      <option value="24">1 天</option>
      <option value="168">7 天</option>
      <option value="720">30 天</option>
    </select></label>
    <div className="dialog-actions">
      {share && <button className="danger" disabled={disabled || working} onClick={() => void revoke()}>
        <Trash2 size={15} />撤销
      </button>}
      <button className="primary" disabled={disabled || working} onClick={() => void create()}>
        {working ? <LoaderCircle className="spin" size={15} /> : share ? <RefreshCw size={15} /> : <Link2 size={15} />}
        {share ? '替换链接' : '创建链接'}
      </button>
    </div>
  </div>;
}
