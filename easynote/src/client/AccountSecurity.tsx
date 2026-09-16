import { useState } from 'react';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { api } from './api';

interface Props {
  disabled: boolean;
  notify(message: string): void;
  reportError(message: string): void;
  logout(): Promise<void>;
}

export function AccountSecurity({ disabled, notify, reportError, logout }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [logoutPassword, setLogoutPassword] = useState('');
  const [working, setWorking] = useState(false);

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
  </div>;
}
