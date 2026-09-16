import { useState } from 'react';
import { Copy, KeyRound, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from './api';

interface Props {
  disabled: boolean;
  username: string;
  notify(message: string): void;
  reportError(message: string): void;
  logout(): Promise<void>;
}

export function AccountSecurity({ disabled, username, notify, reportError, logout }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [logoutPassword, setLogoutPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteUsername, setDeleteUsername] = useState('');

  const changePassword = async () => {
    if (newPassword.length < 12 || newPassword.length > 128) {
      reportError('新密码必须为 12-128 个字符。');
      return;
    }
    if (newPassword !== confirmation) {
      reportError('两次输入的新密码不一致。');
      return;
    }
    setWorking(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      notify('密码已修改，其他设备已退出');
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  return <div className="account-security">
    <section>
      <h3><KeyRound size={16} />修改密码</h3>
      <label>当前密码<input type="password" autoComplete="current-password" maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label>新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <label>确认新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <button className="primary" disabled={disabled || working || !currentPassword || !newPassword || !confirmation} onClick={() => void changePassword()}>
        <ShieldCheck size={16} />确认修改
      </button>
    </section>
    <section>
      <h3><LogOut size={16} />登出所有设备</h3>
      <label>当前密码<input type="password" autoComplete="current-password" maxLength={128} value={logoutPassword} onChange={(event) => setLogoutPassword(event.target.value)} /></label>
      <button className="danger" disabled={disabled || working || !logoutPassword} onClick={() => {
        setWorking(true);
        void api.logoutAll(logoutPassword).then(logout).catch((error: unknown) => reportError(String(error))).finally(() => setWorking(false));
      }}><LogOut size={16} />登出所有设备</button>
    </section>
    <section>
      <h3><KeyRound size={16} />恢复代码</h3>
      {recoveryCode && <div className="token-secret" role="status">
        <strong>恢复代码仅显示一次</strong>
        <code>{recoveryCode}</code>
        <button onClick={() => void navigator.clipboard.writeText(recoveryCode)
          .then(() => notify('恢复代码已复制')).catch((error) => reportError(String(error)))}>
          <Copy size={15} />复制
        </button>
      </div>}
      <label>当前密码<input type="password" autoComplete="current-password" maxLength={128}
        value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} /></label>
      <button disabled={disabled || working || !recoveryPassword} onClick={() => {
        setWorking(true);
        void api.createRecoveryCode(recoveryPassword).then((result) => {
          setRecoveryCode(result.recoveryCode);
          setRecoveryPassword('');
          notify('新的恢复代码已生成');
        }).catch((error: unknown) => reportError(String(error))).finally(() => setWorking(false));
      }}><KeyRound size={16} />生成新恢复代码</button>
    </section>
    <section>
      <h3><Trash2 size={16} />删除账户</h3>
      <label>确认用户名<input maxLength={32} value={deleteUsername}
        onChange={(event) => setDeleteUsername(event.target.value)} /></label>
      <label>当前密码<input type="password" autoComplete="current-password" maxLength={128}
        value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} /></label>
      <button className="danger" disabled={disabled || working || deleteUsername !== username || !deletePassword}
        onClick={() => {
          setWorking(true);
          void api.deleteAccount(deleteUsername, deletePassword).then(logout)
            .catch((error: unknown) => reportError(String(error))).finally(() => setWorking(false));
        }}><Trash2 size={16} />永久删除账户及全部数据</button>
    </section>
  </div>;
}
