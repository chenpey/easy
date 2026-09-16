import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, Save, Trash2, UserRoundCog } from 'lucide-react';
import type { UserAccount } from '../shared/types';
import { api } from './api';

interface Props {
  currentUserId: string;
  registrationEnabled: boolean;
  disabled: boolean;
  onRegistrationChange(enabled: boolean): void;
  notify(message: string): void;
  reportError(message: string): void;
}

export function UserManagement({
  currentUserId,
  registrationEnabled: initialRegistration,
  disabled,
  onRegistrationChange,
  notify,
  reportError,
}: Props) {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [registrationEnabled, setRegistrationEnabled] = useState(initialRegistration);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserAccount['role']>('user');
  const [edits, setEdits] = useState<Record<string, { username: string; role: UserAccount['role']; enabled: boolean; password: string }>>({});
  const [confirmDelete, setConfirmDelete] = useState('');

  useEffect(() => {
    let active = true;
    void api.users().then(({ users: result }) => {
      if (!active) return;
      setUsers(result);
      setEdits(Object.fromEntries(result.map((user) => [user.id, {
        username: user.username,
        role: user.role,
        enabled: user.enabled,
        password: '',
      }])));
    }).catch((error: unknown) => reportError(String(error)))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reportError]);

  const create = async () => {
    setWorking('create');
    try {
      const result = await api.createUser(username, password, role);
      setUsers((current) => [...current, result.user].sort((left, right) => left.username.localeCompare(right.username)));
      setEdits((current) => ({ ...current, [result.user.id]: {
        username: result.user.username,
        role: result.user.role,
        enabled: result.user.enabled,
        password: '',
      } }));
      setUsername('');
      setPassword('');
      setRole('user');
      notify('用户已创建');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking('');
    }
  };

  const save = async (id: string) => {
    const edit = edits[id];
    if (!edit) return;
    setWorking(id);
    try {
      const result = await api.updateUser(id, {
        username: edit.username,
        role: edit.role,
        enabled: edit.enabled,
        ...(edit.password ? { password: edit.password } : {}),
      });
      setUsers((current) => current.map((item) => item.id === id ? result.user : item));
      setEdits((current) => ({ ...current, [id]: { ...edit, password: '' } }));
      notify('用户设置已保存');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking('');
    }
  };

  const remove = async (id: string) => {
    setWorking(id);
    try {
      await api.deleteUser(id);
      setUsers((current) => current.filter((item) => item.id !== id));
      setConfirmDelete('');
      notify('用户已停用，数据正在安全清理');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking('');
    }
  };

  const patch = (id: string, value: Partial<(typeof edits)[string]>) =>
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...value } }));

  return <div className="user-management">
    <div className="setting-row">
      <span>允许自助注册</span>
      <button role="switch" aria-checked={registrationEnabled} aria-label="允许自助注册"
        className={`switch ${registrationEnabled ? 'on' : ''}`} disabled={disabled || !!working}
        onClick={() => {
          const enabled = !registrationEnabled;
          setWorking('registration');
          void api.setRegistration(enabled).then(() => {
            setRegistrationEnabled(enabled);
            onRegistrationChange(enabled);
            notify(enabled ? '已开启注册，新增账号需管理员批准' : '已关闭自助注册');
          }).catch((error: unknown) => reportError(String(error))).finally(() => setWorking(''));
        }}>{registrationEnabled ? <Check size={14} /> : <UserRoundCog size={14} />}</button>
    </div>
    <form className="user-create-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h3>创建用户</h3>
      <input required aria-label="新用户用户名" placeholder="用户名" minLength={3} maxLength={32}
        value={username} onChange={(event) => setUsername(event.target.value)} />
      <input required aria-label="新用户密码" placeholder="初始密码（至少 12 位）" type="password"
        minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
      <select aria-label="新用户角色" value={role} onChange={(event) => setRole(event.target.value as UserAccount['role'])}>
        <option value="user">用户</option><option value="admin">管理员</option>
      </select>
      <button className="primary" disabled={disabled || !!working || password.length < 12}>
        {working === 'create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建
      </button>
    </form>
    <div className="user-list" aria-label="用户列表">
      {loading ? <div className="panel-empty">正在读取用户…</div> : users.map((user) => {
        const edit = edits[user.id];
        if (!edit) return null;
        const current = user.id === currentUserId;
        return <section className="user-row" key={user.id}>
          <div className="user-row-heading">
            <strong>{user.username}{current ? '（当前）' : ''}</strong>
            <span>{user.pendingApproval ? '待批准' : user.enabled ? '已启用' : '已停用'}</span>
          </div>
          <div className="user-edit-grid">
            <input aria-label={`${user.username} 用户名`} maxLength={32} value={edit.username} disabled={current}
              onChange={(event) => patch(user.id, { username: event.target.value })} />
            <select aria-label={`${user.username} 角色`} value={edit.role} disabled={current}
              onChange={(event) => patch(user.id, { role: event.target.value as UserAccount['role'] })}>
              <option value="user">用户</option><option value="admin">管理员</option>
            </select>
            <label className="inline-check"><input type="checkbox" checked={edit.enabled} disabled={current}
              onChange={(event) => patch(user.id, { enabled: event.target.checked })} />启用</label>
            <input aria-label={`${user.username} 新密码`} placeholder="留空则不改密码" type="password" disabled={current}
              minLength={12} maxLength={128} value={edit.password}
              onChange={(event) => patch(user.id, { password: event.target.value })} />
          </div>
          <div className="user-actions">
            <button disabled={current || disabled || !!working || edit.password.length > 0 && edit.password.length < 12}
              onClick={() => void save(user.id)}>
              {working === user.id ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存
            </button>
            {!current && (confirmDelete === user.id
              ? <><button className="danger" disabled={disabled || !!working} onClick={() => void remove(user.id)}>
                <Trash2 size={14} />确认删除
              </button><button disabled={!!working} onClick={() => setConfirmDelete('')}>取消</button></>
              : <button className="icon-button danger-icon" title="删除用户" aria-label={`删除用户 ${user.username}`}
                disabled={disabled || !!working} onClick={() => setConfirmDelete(user.id)}><Trash2 size={15} /></button>)}
          </div>
        </section>;
      })}</div>
  </div>;
}
