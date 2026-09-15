import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import type { IntegrationToken } from '../shared/types';
import { api } from './api';

interface Props {
  disabled: boolean;
  reportError(error: string): void;
  notify(message: string): void;
}

const expiry = (value: number | null) => value === null ? '永久有效' : `有效至 ${new Date(value).toLocaleDateString('zh-CN', {
  year: 'numeric', month: 'short', day: 'numeric',
})}`;

export function AiAccess({ disabled, reportError, notify }: Props) {
  const [tokens, setTokens] = useState<IntegrationToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<IntegrationToken['access']>('read-write');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [secret, setSecret] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState('');

  useEffect(() => {
    let active = true;
    void api.integrationTokens()
      .then((result) => { if (active) setTokens(result.tokens); })
      .catch((error: unknown) => { if (active) reportError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reportError]);

  const create = async () => {
    setWorking(true);
    setSecret('');
    try {
      const result = await api.createIntegrationToken(name, access, expiresInDays === 'permanent' ? null : Number(expiresInDays));
      setTokens((current) => [result.token, ...current]);
      setSecret(result.secret);
      setName('');
      notify('AI 接入令牌已创建');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  const revoke = async (id: string) => {
    setWorking(true);
    try {
      await api.revokeIntegrationToken(id);
      setTokens((current) => current.filter((item) => item.id !== id));
      setConfirmRevoke('');
      notify('AI 接入令牌已撤销');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  return <section className="ai-access" aria-labelledby="ai-access-title">
    <div className="setting-row ai-access-heading">
      <span id="ai-access-title">AI 接入</span>
      <KeyRound size={17} />
    </div>
    {secret && <div className="token-secret" role="status">
      <div><Check size={15} /><strong>令牌仅显示一次</strong></div>
      <code>{secret}</code>
      <button onClick={() => void navigator.clipboard.writeText(secret).then(() => notify('令牌已复制')).catch((error) => reportError(String(error)))}>
        <Copy size={15} />复制令牌
      </button>
    </div>}
    <form className="token-form" onSubmit={(event) => {
      event.preventDefault();
      void create();
    }}>
      <label>名称<input required maxLength={40} placeholder="例如：本机 AI" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>权限<select value={access} onChange={(event) => setAccess(event.target.value as IntegrationToken['access'])}>
        <option value="read-write">读取和写入</option>
        <option value="read">只读</option>
      </select></label>
      <label>有效期<select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}>
        <option value={30}>30 天</option>
        <option value={90}>90 天</option>
        <option value={365}>365 天</option>
        <option value="permanent">永久</option>
      </select></label>
      <button className="primary" disabled={disabled || working || !name.trim()}>
        {working ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建令牌
      </button>
    </form>
    <div className="token-list" aria-label="AI 接入令牌">
      {loading ? <div className="token-empty">正在读取令牌…</div> :
        !tokens.length ? <div className="token-empty">暂无有效令牌</div> :
          tokens.map((item) => <div className="token-row" key={item.id}>
            <div><strong>{item.name}</strong><span>{item.access === 'read-write' ? '读取和写入' : '只读'} · {expiry(item.expiresAt)}</span></div>
            {confirmRevoke === item.id ? <div className="token-actions">
              <button className="danger" disabled={working} onClick={() => void revoke(item.id)}><Trash2 size={14} />确认撤销</button>
              <button aria-label="取消撤销" disabled={working} onClick={() => setConfirmRevoke('')}><X size={14} /></button>
            </div> :
              <button className="icon-button" title="撤销令牌" aria-label={`撤销令牌 ${item.name}`} disabled={disabled || working} onClick={() => setConfirmRevoke(item.id)}><Trash2 size={16} /></button>}
          </div>)}
    </div>
  </section>;
}
