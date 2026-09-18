import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, BookOpen, Check, CheckSquare, ChevronDown, ChevronRight, ClipboardList, Command, Download, FileText, FolderOpen, History, ImagePlus, Keyboard, Link2, ListTree, LoaderCircle, LogOut, Maximize2, Menu, Minimize2, Moon, MoreHorizontal, Paperclip, PanelLeftClose, Pin, Plus, Printer, RefreshCw, Save, Search, Settings, Share2, ShieldCheck, Square, Sun, Tag, Tags, Trash2, Upload, Users, WifiOff, X, RotateCcw, PenLine } from 'lucide-react';
import type { Note, NoteInput, NoteSummary, NoteTask, Session, SharedNote, Version } from '../shared/types';
import { api, setSession, setUnauthorizedHandler, uploadAttachment, uploadImage } from './api';
import { AccountSecurity } from './AccountSecurity';
import { AiAccess } from './AiAccess';
import { Editor, Preview, toggleMarkdownTask, type EditorHandle } from './Editor';
import { NoteSharing } from './NoteSharing';
import { UserManagement } from './UserManagement';
import { clearAccountStorage, forgetCachedSession, loadOfflineSession, cacheSession } from './drafts';
import { headings, noteLink } from './knowledge';
import {
  createPdfFile,
  defaultPdfOptions,
  downloadPdfFile,
  isMobilePdfTarget,
  pdfFilename,
  renderPdfPreviewPages,
  type PdfExportOptions,
} from './pdf';
import { useNotebook } from './useNotebook';
import { exportArchive, exportLocalDrafts, importExternalFiles } from './transfer';
import type { NoteConflictField } from './merge';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button className="icon-button" data-tooltip={label} aria-label={label} {...props}>{children}</button>;
}

function BrandIcon({ size }: { size: number }) {
  return <img className="brand-icon" src="/easynote-icon.svg" width={size} height={size} alt="" aria-hidden="true" />;
}

function Modal({ title, children, close, className }: { title: string; children: ReactNode; close(): void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className={className} ref={ref}
    onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === ref.current) close(); }}>
    <header className="dialog-header"><h2>{title}</h2><IconButton label="关闭" onClick={close}><X size={18} /></IconButton></header>
    {children}
  </dialog>;
}

function PdfPagePreview({ pages, progress, error }: { pages: Blob[]; progress: string; error: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = pages.map((page) => URL.createObjectURL(page));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [pages]);
  return <section className="pdf-preview-panel" aria-label="PDF 分页预览" aria-busy={!!progress}>
    <header><strong>分页预览</strong><span>{pages.length ? `${pages.length} 页` : ''}</span></header>
    <div className="pdf-preview-pages">
      {progress || pages.length > 0 && !urls.length
        ? <div className="pdf-preview-status"><LoaderCircle className="spin" size={18} />{progress || '正在打开分页预览'}</div>
        : error
          ? <div className="pdf-preview-error" role="alert">{error}</div>
          : urls.map((url, index) => <figure key={url}>
            <img src={url} alt={`PDF 第 ${index + 1} 页`} />
            <figcaption>{index + 1} / {urls.length}</figcaption>
          </figure>)}
    </div>
  </section>;
}

function moveButtonFocus(event: ReactKeyboardEvent<HTMLElement>, selector: string) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)]
    .filter((button) => !button.disabled);
  if (!buttons.length) return;
  const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(selector) : null;
  const index = current ? buttons.indexOf(current) : -1;
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
        : Math.max(index < 0 ? buttons.length - 1 : index - 1, 0);
  event.preventDefault();
  buttons[next].focus();
}

function highlightMatches(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const haystack = text.toLocaleLowerCase();
  const normalizedNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let offset = 0;
  let match = haystack.indexOf(normalizedNeedle);
  while (match >= 0) {
    if (match > offset) parts.push(text.slice(offset, match));
    parts.push(<mark className="search-highlight" key={`${match}-${parts.length}`}>{text.slice(match, match + needle.length)}</mark>);
    offset = match + needle.length;
    match = haystack.indexOf(normalizedNeedle, offset);
  }
  if (!parts.length) return text;
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

function noteExcerptText(markdown: string, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return markdown
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (source, alt: string, href: string) => {
      const label = alt ? `[图片：${alt}]` : '[图片]';
      return needle && !label.toLocaleLowerCase().includes(needle) && href.toLocaleLowerCase().includes(needle)
        ? `${label} ${source}`
        : label;
    })
    .replace(/[#*`]/g, '');
}

const conflictFieldName: Record<NoteConflictField, string> = {
  title: '标题',
  content: '正文',
  tags: '标签',
  pinned: '置顶状态',
  archived: '归档状态',
  deletedAt: '删除状态',
};

function conflictFieldValue(note: Note, field: NoteConflictField): string {
  if (field === 'tags') return note.tags.join('、') || '无标签';
  if (field === 'pinned') return note.pinned ? '已置顶' : '未置顶';
  if (field === 'archived') return note.archived ? '已归档' : '未归档';
  if (field === 'deletedAt') return note.deletedAt ? '已移入回收站' : '正常笔记';
  return note[field] || '（空）';
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function sourceLineOffset(content: string, line: number) {
  let offset = 0;
  for (let index = 0; index < line; index++) {
    const newline = content.indexOf('\n', offset);
    if (newline < 0) return content.length;
    offset = newline + 1;
  }
  return offset;
}

async function waitForPrintReady() {
  const deadline = Date.now() + 15_000;
  await nextFrame();
  await nextFrame();
  while (Date.now() < deadline) {
    const root = document.querySelector<HTMLElement>('.print-document[data-printing="true"]');
    const images = [...(root?.querySelectorAll<HTMLImageElement>('img') ?? [])];
    const diagramsReady = !root?.querySelector('[data-mermaid-source]');
    const imagesReady = images.every((image) => image.complete && image.naturalWidth > 0);
    const fontsReady = !document.fonts || document.fonts.status === 'loaded';
    if (root && diagramsReady && imagesReady && fontsReady) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('PDF 内容准备超时，请检查笔记中的图片或图表后重试。');
}

function canSharePdf(file: File) {
  try {
    return typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function SharedPage({ token }: { token: string }) {
  const [note, setNote] = useState<SharedNote | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api.sharedNote(token).then(({ note: value }) => {
      setNote(value);
      document.title = `${value.title || '未命名笔记'} · EasyNote`;
    }).catch((reason: unknown) => setError(String(reason)));
  }, [token]);
  return <main className="shared-page">
    <header><div className="brand"><BrandIcon size={25} /><span>EasyNote</span></div><span>只读分享</span></header>
    {error ? <div className="shared-error"><h1>链接不可用</h1><p>分享链接不存在、已撤销或已经过期。</p></div> :
      !note ? <div className="shared-loading"><LoaderCircle className="spin" size={22} />正在读取笔记…</div> :
        <article className="shared-document">
          <h1>{note.title || '未命名笔记'}</h1>
          <div className="document-meta">
            <time>更新于 {new Date(note.updatedAt).toLocaleString('zh-CN')}</time>
            <span>有效至 {new Date(note.expiresAt).toLocaleString('zh-CN')}</span>
          </div>
          <Preview content={note.content} onImage={(src) => window.open(src, '_blank', 'noopener,noreferrer')} />
        </article>}
  </main>;
}

export default function App() {
  const shared = /^\/shared\/([a-f0-9]{64})$/.exec(window.location.pathname);
  return shared ? <SharedPage token={shared[1]} /> : <PrivateApp />;
}

function PrivateApp() {
  const [session, updateSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login');
  const [confirmation, setConfirmation] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const applySession = (value: Session) => {
    setSession(value);
    updateSession(value);
    if (value.user && !value.offline) void cacheSession(value);
  };
  const boot = () => {
    setBooting(true);
    setBootError('');
    void api.session().then(applySession).catch(async (error: unknown) => {
      try {
        const cached = await loadOfflineSession();
        if (cached?.user) applySession(cached);
        else setBootError(String(error));
      } catch (cacheError) {
        setBootError(`${String(error)}\n${String(cacheError)}`);
      }
    }).finally(() => setBooting(false));
  };
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setPassword('');
      setBootError('登录已过期，请重新登录。');
      updateSession((current) => {
        if (current?.user) void forgetCachedSession(current.user.id);
        return current ? { ...current, user: null, csrf: null, expiresAt: null, offline: false } : current;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);
  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const installed = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', capturePrompt);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', capturePrompt);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);
  useEffect(boot, []);
  useEffect(() => {
    if (!session?.offline) return;
    let running = false;
    const reconnect = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        const value = await api.session();
        if (value.user?.id === session.user?.id) {
          applySession(value);
        } else {
          let storageError = '';
          try { await clearAccountStorage(session.user!.id); }
          catch (error) { storageError = `\n${String(error)}`; }
          setPassword('');
          setBootError(value.user ? storageError.trim() : `登录已过期，请重新登录。${storageError}`);
          applySession(value);
        }
      } catch { /* Keep the cached library available until the server returns. */ }
      finally { running = false; }
    };
    const timer = setInterval(() => void reconnect(), 5_000);
    window.addEventListener('online', reconnect);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [session?.offline, session?.user?.id]);
  if (booting && !session) return <main className="login">
    <div className="login-form" role="status" aria-live="polite">
      <div className="brand login-brand"><BrandIcon size={32} /><h1>EasyNote</h1></div>
      <div className="login-heading">正在连接</div>
      <LoaderCircle className="spin" size={22} aria-label="正在连接" />
    </div>
  </main>;
  if (session?.user) return <AccountWorkspace
    key={session.user.id}
    session={session}
    installApp={installPrompt ? async () => {
      const prompt = installPrompt;
      setInstallPrompt(null);
      await prompt.prompt();
      await prompt.userChoice;
    } : undefined}
    logout={async () => {
      let storageError = '';
      try { await clearAccountStorage(session.user!.id); }
      catch (error) { storageError = `本机离线数据清理失败：${String(error)}`; }
      setPassword('');
      setBootError(storageError);
      applySession({ ...session, user: null, csrf: null, expiresAt: null, offline: false });
    }}
  />;
  return <main className="login">
    <form className="login-form" onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setBootError('');
      const action = authMode === 'login'
        ? api.login(username, password).then((value) => { applySession(value); setPassword(''); })
        : authMode === 'register'
          ? password !== confirmation
            ? Promise.reject(new Error('两次输入的密码不一致。'))
            : api.register(username, password).then((value) => {
              setIssuedRecoveryCode(value.recoveryCode);
              setPassword('');
              setConfirmation('');
            })
          : password !== confirmation
            ? Promise.reject(new Error('两次输入的新密码不一致。'))
            : api.resetPassword(username, recoveryCode, password).then(() => {
              setAuthMode('login');
              setPassword('');
              setConfirmation('');
              setRecoveryCode('');
              setBootError('密码已重置，请登录。');
            });
      void action.catch((error: unknown) => setBootError(String(error))).finally(() => setBusy(false));
    }}>
      <div className="brand login-brand"><BrandIcon size={32} /><h1>EasyNote</h1></div>
      <div className="login-heading">{authMode === 'register' ? '创建账户' : authMode === 'reset' ? '恢复账户' :
        session ? session.configured ? '登录笔记' : '等待初始化' : '登录笔记'}</div>
      {issuedRecoveryCode && <div className="recovery-result" role="status">
        <strong>保存恢复代码</strong>
        <code>{issuedRecoveryCode}</code>
        <p>账号需要管理员批准后才能登录，此代码仅显示一次。</p>
        <button type="button" onClick={() => void navigator.clipboard.writeText(issuedRecoveryCode)}>复制恢复代码</button>
      </div>}
      <label>用户名<input autoComplete="username" required maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      {authMode === 'reset' && <label>恢复代码<input autoComplete="off" required value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} /></label>}
      <label>{authMode === 'reset' ? '新密码' : '密码'}<input autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
        type="password" required minLength={authMode === 'login' ? undefined : 12} maxLength={128}
        value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {authMode !== 'login' && <label>确认密码<input autoComplete="new-password" type="password" required minLength={12}
        maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
      <button className="primary" disabled={busy || !session?.configured || authMode === 'register' && !session.registrationEnabled}>
        {busy ? '处理中…' : authMode === 'register' ? '提交注册' : authMode === 'reset' ? '重置密码' : '登录'}
      </button>
      <div className="login-actions">
        {authMode !== 'login' ? <button type="button" onClick={() => { setAuthMode('login'); setBootError(''); }}>返回登录</button> :
          <>{session?.registrationEnabled && <button type="button" onClick={() => { setAuthMode('register'); setIssuedRecoveryCode(''); }}>注册</button>}
            <button type="button" onClick={() => setAuthMode('reset')}>使用恢复代码</button></>}
      </div>
      {bootError && <div role="alert" className="error-box"><pre>{bootError}</pre><button type="button" onClick={boot}>重新连接</button></div>}
    </form>
  </main>;
}

function AccountWorkspace({ session, installApp, logout }: { session: Session; installApp?(): Promise<void>; logout(): Promise<void> }) {
  const [ownsLock, setOwnsLock] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    if (!navigator.locks) { setOwnsLock(false); return; }
    void navigator.locks.request(`easynote-editor:${session.user!.id}`, { ifAvailable: true }, async (lock) => {
      if (cancelled) return;
      setOwnsLock(!!lock);
      if (lock) await new Promise<void>((resolve) => { release = resolve; });
    }).catch(() => { if (!cancelled) setOwnsLock(false); });
    return () => { cancelled = true; release?.(); };
  }, [session.user!.id, attempt]);
  if (ownsLock) return <Notebook session={session} installApp={installApp} logout={logout} />;
  return <main className="login"><div className="login-form">
    <div className="brand login-brand"><BrandIcon size={32} /><h1>EasyNote</h1></div>
    <div className="login-heading">{ownsLock === null ? '正在打开笔记' : navigator.locks ? '另一个标签页正在编辑' : '浏览器不支持安全编辑锁'}</div>
    {ownsLock === false && navigator.locks && <button onClick={() => setAttempt((n) => n + 1)}>重新打开</button>}
  </div></main>;
}

function Notebook({ session, installApp, logout }: { session: Session; installApp?(): Promise<void>; logout(): Promise<void> }) {
  const book = useNotebook(session);
  const [layout, setLayout] = useState<'edit' | 'preview'>('edit');
  const [mobileNote, setMobileNote] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [mobileNoteActions, setMobileNoteActions] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [resizingList, setResizingList] = useState(false);
  const [noteListWidth, setNoteListWidth] = useState(() => {
    const stored = localStorage.getItem('easynote-note-list-width');
    if (stored === null) return 300;
    const saved = Number(stored);
    return Number.isFinite(saved) ? Math.min(440, Math.max(220, saved)) : 300;
  });
  const noteListWidthRef = useRef(noteListWidth);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const [accountSecurity, setAccountSecurity] = useState(false);
  const [userManagement, setUserManagement] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(session.registrationEnabled);
  const [taskCenter, setTaskCenter] = useState(false);
  const [tasks, setTasks] = useState<NoteTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandNotes, setCommandNotes] = useState<NoteSummary[]>([]);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [pdfProgress, setPdfProgress] = useState('');
  const [pdfExport, setPdfExport] = useState(false);
  const [pdfName, setPdfName] = useState('');
  const [pdfOptions, setPdfOptions] = useState<PdfExportOptions>(defaultPdfOptions);
  const [pdfPreviewFile, setPdfPreviewFile] = useState<File | null>(null);
  const [pdfPreviewPages, setPdfPreviewPages] = useState<Blob[]>([]);
  const [pdfPreviewError, setPdfPreviewError] = useState('');
  const [printNote, setPrintNote] = useState<Note | null>(null);
  const [inspector, setInspector] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([]);
  const [linkPicker, setLinkPicker] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkNotes, setLinkNotes] = useState<NoteSummary[]>([]);
  const [tagManager, setTagManager] = useState(false);
  const [tagSource, setTagSource] = useState('');
  const [tagTarget, setTagTarget] = useState('');
  const [tagAction, setTagAction] = useState<'rename' | 'merge' | 'delete'>('rename');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTag, setBulkTag] = useState('');
  const [versionList, setVersionList] = useState<Version[] | null>(null);
  const [versionNoteId, setVersionNoteId] = useState('');
  const [chosenVersion, setChosenVersion] = useState<Version | null>(null);
  const [confirmAction, setConfirmAction] = useState<'trash' | 'bulk-trash' | 'purge' | 'purge-all' | null>(null);
  const [lightbox, setLightbox] = useState('');
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const pdfGeneration = useRef(0);
  const [transfer, setTransfer] = useState('');
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem('easynote-theme') === 'dark');
  const [wideDocument, setWideDocument] = useState(() => localStorage.getItem('easynote-document-width') === 'wide');
  const [tagText, setTagText] = useState('');
  const editor = useRef<EditorHandle>(null);
  const editorCursor = useRef(0);
  const pendingEditorOffset = useRef<{ noteId: string; offset: number } | null>(null);
  const pendingInsertion = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const commandList = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importFolderInput = useRef<HTMLInputElement>(null);
  const note = book.note;
  const outline = useMemo(() => headings(note?.content ?? ''), [note?.content]);
  const updateNoteListWidth = (value: number) => {
    const next = Math.min(440, Math.max(220, Math.round(value)));
    noteListWidthRef.current = next;
    setNoteListWidth(next);
  };
  const beginNoteListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeStart.current = { pointerId: event.pointerId, x: event.clientX, width: noteListWidthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingList(true);
  };
  const moveNoteListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    updateNoteListWidth(start.width + event.clientX - start.x);
  };
  const finishNoteListResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeStart.current?.pointerId !== event.pointerId) return;
    resizeStart.current = null;
    setResizingList(false);
    localStorage.setItem('easynote-note-list-width', String(noteListWidthRef.current));
  };
  const resizeNoteListWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const widths: Record<string, number> = {
      ArrowLeft: noteListWidthRef.current - 12,
      ArrowRight: noteListWidthRef.current + 12,
      Home: 220,
      End: 440,
    };
    if (!(event.key in widths)) return;
    event.preventDefault();
    updateNoteListWidth(widths[event.key]);
    localStorage.setItem('easynote-note-list-width', String(Math.min(440, Math.max(220, widths[event.key]))));
  };
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('easynote-theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { setTagText(note?.tags.join(', ') ?? ''); }, [note?.id, JSON.stringify(note?.tags)]);
  useEffect(() => {
    const pending = pendingEditorOffset.current;
    editorCursor.current = pending && pending.noteId === note?.id
      ? pending.offset
      : 0;
  }, [note?.id]);
  useEffect(() => {
    const pending = pendingEditorOffset.current;
    if (!pending || layout !== 'edit' || pending.noteId !== note?.id) return;
    const offset = pending.offset;
    pendingEditorOffset.current = null;
    const frame = requestAnimationFrame(() => editor.current?.goTo(offset));
    return () => cancelAnimationFrame(frame);
  }, [layout, note?.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const showNotice = (text: string) => setNotice({ id: Date.now(), text });
  useEffect(() => {
    if (!pdfExport || !printNote) return;
    const generation = ++pdfGeneration.current;
    const timer = window.setTimeout(() => {
      setPrinting(true);
      setPdfProgress('正在生成分页预览');
      setPdfPreviewError('');
      setPdfPreviewFile(null);
      setPdfPreviewPages([]);
      void (async () => {
        await waitForPrintReady();
        const source = document.querySelector<HTMLElement>('.print-document[data-printing="true"]');
        if (!source) throw new Error('PDF 内容尚未准备完成。');
        const file = await createPdfFile(source, printNote.title, printNote.title, pdfOptions);
        if (pdfGeneration.current !== generation) return;
        setPdfProgress('正在渲染分页预览');
        const pages = await renderPdfPreviewPages(file);
        if (pdfGeneration.current !== generation) return;
        setPdfPreviewFile(file);
        setPdfPreviewPages(pages);
      })().catch((error: unknown) => {
        if (pdfGeneration.current === generation) {
          setPdfPreviewError(String(error).replace(/^Error:\s*/, ''));
        }
      }).finally(() => {
        if (pdfGeneration.current === generation) {
          setPdfProgress('');
          setPrinting(false);
        }
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [pdfExport, printNote, pdfOptions]);
  const showShortcutHelp = () => {
    setCommandPalette(false);
    setShortcutHelp(true);
  };
  const editAt = (offset: number) => {
    editorCursor.current = offset;
    if (layout === 'edit') {
      editor.current?.goTo(offset);
      return;
    }
    if (note) pendingEditorOffset.current = { noteId: note.id, offset };
    setLayout('edit');
  };
  const showPreview = () => {
    if (!note || note.deletedAt) return;
    editorCursor.current = editor.current?.cursor() ?? editorCursor.current;
    setLayout('preview');
  };
  const toggleLayout = () => {
    if (!note || note.deletedAt) return;
    if (layout === 'edit') showPreview();
    else editAt(Math.min(editorCursor.current, note.content.length));
  };
  const toggleDocumentWidth = () => setWideDocument((current) => {
    const next = !current;
    localStorage.setItem('easynote-document-width', next ? 'wide' : 'readable');
    return next;
  });
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (e) { book.setError(String(e)); }
  };
  const createNote = () => run(async () => {
    await book.create();
    setMobileNavigation(false);
    setMobileNoteActions(false);
    setMobileNote(true);
    setLayout('edit');
  });
  const insertFiles = async (files: File[], insertion?: string) => {
    if (!note || uploading) return;
    if (!book.online || session.offline) { book.setError('附件需要联网上传。'); return; }
    const target = note;
    const marker = insertion ?? pendingInsertion.current ?? editor.current?.markInsertion();
    pendingInsertion.current = null;
    setUploading(true);
    try {
      for (const file of files) {
        const label = file.name.replace(/[\[\]\\\r\n]/g, '');
        const stored = file.type.startsWith('image/')
          ? await uploadImage(file, session.config.maxImageBytes, session.config.maxImagePixels)
          : await uploadAttachment(file, session.config.maxAttachmentBytes);
        const markdown = file.type.startsWith('image/') ? `![${label}](${stored.url})` : `[${label}](${stored.url})`;
        if (!marker || !editor.current?.insertAt(marker, markdown)) book.append(target, markdown);
      }
      const onlyImages = files.every((file) => file.type.startsWith('image/'));
      showNotice(onlyImages ? '图片已插入' : files.length === 1 ? '附件已插入' : `已插入 ${files.length} 个文件`);
    } catch (e) { book.setError(String(e)); }
    finally {
      if (marker) editor.current?.releaseInsertion(marker);
      setUploading(false);
      if (imageInput.current) imageInput.current.value = '';
      if (attachmentInput.current) attachmentInput.current.value = '';
    }
  };
  const chooseView = (view: string, tag = '') => {
    book.setView(view);
    book.setTag(tag);
    setMobileNavigation(false);
    setMobileNote(false);
    setSelectionMode(false);
    setSelected(new Set());
  };
  const toggleMobileSearch = () => {
    if (mobileSearch || book.query) {
      book.setQuery('');
      setMobileSearch(false);
      searchInput.current?.blur();
      return;
    }
    setMobileSearch(true);
    requestAnimationFrame(() => searchInput.current?.focus());
  };
  const setNoteFields = (patch: Partial<NoteInput>) => book.edit(patch);
  const syncNow = async (createVersion = true) => {
    if (syncing) return;
    const hadPending = book.pending.length > 0;
    const checkpointId = createVersion ? note?.id : undefined;
    setSyncing(true);
    try {
      if (await book.retry(checkpointId)) {
        showNotice(checkpointId ? '已保存并记录历史版本' :
          hadPending ? '草稿已保存并同步' : '已同步，内容为最新');
      }
    } finally {
      setSyncing(false);
    }
  };
  const openNote = async (id: string) => {
    await book.select(id);
    setMobileNavigation(false);
    setMobileNoteActions(false);
    setMobileNote(true);
    setVersionList(null);
    setCommandPalette(false);
    setLinkPicker(false);
  };
  const openTaskCenter = async () => {
    setTaskCenter(true);
    setTasksLoading(true);
    try { setTasks(await book.tasks()); }
    catch (error) { book.setError(String(error)); }
    finally { setTasksLoading(false); }
  };
  const openTask = async (task: NoteTask) => {
    if (note?.id === task.noteId && layout === 'edit') {
      setTaskCenter(false);
      setMobileNote(true);
      requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.goTo(task.offset)));
      return;
    }
    pendingEditorOffset.current = { noteId: task.noteId, offset: task.offset };
    setLayout('edit');
    setTaskCenter(false);
    await openNote(task.noteId);
  };
  const openHistory = () => {
    if (!note || note.revision === 0) return;
    void run(async () => {
      const result = await api.versions(note.id);
      setVersionNoteId(note.id);
      setVersionList(result.versions);
      setChosenVersion(null);
    });
  };
  const restoreVersion = async () => {
    if (!note || !chosenVersion || syncing) return;
    const targetId = note.id;
    const version = chosenVersion;
    setSyncing(true);
    try {
      if (!await book.retry(targetId)) return;
      book.edit({
        title: version.title,
        content: version.content,
        tags: version.tags,
        archived: version.archived,
      });
      if (!await book.retry()) return;
      setVersionList(null);
      setChosenVersion(null);
      setLayout('edit');
      showNotice('已恢复版本，恢复前内容已保留');
    } finally {
      setSyncing(false);
    }
  };
  const exportCurrentNote = () => {
    if (!note || printing) return;
    setPdfName(note.title);
    setPdfOptions(defaultPdfOptions);
    setPdfPreviewFile(null);
    setPdfPreviewPages([]);
    setPdfPreviewError('');
    setPrintNote({ ...note, tags: [...note.tags] });
    setPdfProgress('正在准备分页预览');
    setPdfExport(true);
  };
  const closePdfExport = () => {
    if (printing) return;
    pdfGeneration.current += 1;
    setPdfExport(false);
    setPrintNote(null);
    setPdfPreviewFile(null);
    setPdfPreviewPages([]);
    setPdfPreviewError('');
    setPdfProgress('');
  };
  const confirmPdfExport = async () => {
    if (!pdfPreviewFile || printing) return;
    const file = new File([pdfPreviewFile], pdfFilename(pdfName.replace(/\.pdf$/i, '')), {
      type: pdfPreviewFile.type,
      lastModified: pdfPreviewFile.lastModified,
    });
    if (isMobilePdfTarget() && canSharePdf(file)) {
      try {
        await navigator.share({ files: [file], title: file.name });
        closePdfExport();
        showNotice('PDF 已交给系统保存');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    downloadPdfFile(file);
    closePdfExport();
    showNotice('PDF 已下载');
  };
  const beginLinkInsertion = () => {
    pendingInsertion.current = editor.current?.markInsertion() ?? null;
    setLinkQuery('');
    setLinkPicker(true);
  };
  const insertNoteLink = (target: NoteSummary) => {
    const marker = pendingInsertion.current;
    if (marker && editor.current?.insertAt(marker, noteLink(target.id, target.title))) {
      editor.current.releaseInsertion(marker);
    } else if (note) {
      book.append(note, noteLink(target.id, target.title));
    }
    pendingInsertion.current = null;
    setLinkPicker(false);
  };
  const downloadPrivateFile = async (id: string, href: string) => {
    let url = href;
    if (!book.online || session.offline) {
      const cached = await book.cachedFile(id);
      if (!cached) throw new Error('这个附件尚未保存到本机。');
      url = cached;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    anchor.click();
    if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  useEffect(() => {
    if (!commandPalette) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void book.searchAll(commandQuery).then((results) => { if (!cancelled) setCommandNotes(results); })
        .catch((error: unknown) => { if (!cancelled) book.setError(String(error)); });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [commandPalette, commandQuery]);
  useEffect(() => {
    if (!linkPicker) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void book.searchAll(linkQuery).then((results) => {
        if (!cancelled) setLinkNotes(results.filter((item) => item.id !== note?.id));
      }).catch((error: unknown) => { if (!cancelled) book.setError(String(error)); });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linkPicker, linkQuery, note?.id]);
  useEffect(() => {
    if (!inspector || !note) { setBacklinks([]); return; }
    let cancelled = false;
    void book.backlinks(note.id).then((results) => { if (!cancelled) setBacklinks(results); })
      .catch((error: unknown) => { if (!cancelled) book.setError(String(error)); });
    return () => { cancelled = true; };
  }, [inspector, note?.id, note?.revision, book.offlineLibrary]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || document.querySelector('dialog[open]')) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setCommandPalette(true);
        setCommandQuery('');
      } else if (key === 's' && (note || book.pending.length)) {
        event.preventDefault();
        void syncNow();
      } else if (key === 'p' && note) {
        event.preventDefault();
        exportCurrentNote();
      } else if (key === 'e' && note && !note.deletedAt) {
        event.preventDefault();
        toggleLayout();
      } else if (key === 'enter' && note && !note.deletedAt) {
        event.preventDefault();
        toggleLayout();
      } else if (key === '/') {
        event.preventDefault();
        showShortcutHelp();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  const toggleSelected = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const allVisibleSelected = book.notes.length > 0 &&
    selected.size === book.notes.length &&
    book.notes.every((item) => selected.has(item.id));
  const toggleSelectAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(book.notes.map((item) => item.id)));
  };
  const exitSelectionMode = () => {
    setSelected(new Set());
    setSelectionMode(false);
    setBulkTag('');
    setBulkTagOpen(false);
  };
  const finishBulk = (message: string) => {
    exitSelectionMode();
    showNotice(message);
  };
  const applyBulkArchive = () => void run(async () => {
    const ids = [...selected];
    const archived = book.view !== 'archive';
    const count = await book.bulkUpdate(ids, () => ({ archived, deletedAt: null }));
    finishBulk(`${archived ? '已归档' : '已取消归档'} ${count} 篇笔记`);
  });
  const applyBulkTag = () => void run(async () => {
    const value = bulkTag.trim();
    if (!value || value.length > 40) throw new Error('标签必须为 1-40 个字符。');
    const count = await book.bulkUpdate([...selected], (item) => ({ tags: [...new Set([...item.tags, value])] }));
    finishBulk(`已为 ${count} 篇笔记添加标签`);
  });
  const moveToTrash = (ids: string[]) => {
    const deletedAt = Date.now();
    return book.bulkUpdate(ids, () => ({ deletedAt, archived: false }));
  };
  const moveCurrentToTrash = async () => {
    if (!note) throw new Error('当前笔记不可用，请刷新后重试。');
    const index = book.notes.findIndex((item) => item.id === note.id);
    const next = index >= 0 ? book.notes[index + 1] : undefined;
    await moveToTrash([note.id]);
    if (next) {
      await openNote(next.id);
    } else {
      book.clearSelection();
      book.setQuery('');
      setMobileSearch(false);
      chooseView('all');
    }
    showNotice('已移入回收站');
  };
  const applyBulkTrash = async () => {
    const count = await moveToTrash([...selected]);
    finishBulk(`已将 ${count} 篇笔记移入回收站`);
  };
  const applyTagManagement = () => void run(async () => {
    const source = tagSource.trim();
    const target = tagAction === 'delete' ? null : tagTarget.trim();
    if (!source || target !== null && (!target || target.length > 40)) throw new Error('请选择来源标签并填写 1-40 个字符的目标标签。');
    const count = await book.manageTag(source, target);
    setTagManager(false);
    setTagSource('');
    setTagTarget('');
    showNotice(`已更新 ${count} 篇笔记`);
  });
  const goToHeading = (offset: number) => {
    editAt(offset);
  };
  const transferAction = async <T,>(action: () => Promise<T>, success: string | ((result: T) => string)) => {
    if (book.pending.length || book.busy || uploading) { book.setError('还有未保存的内容，请先完成保存。'); return; }
    setTransfer('正在准备…');
    try {
      const result = await action();
      showNotice(typeof success === 'function' ? success(result) : success);
      await book.refresh();
    }
    catch (e) { book.setError(String(e)); }
    finally { setTransfer(''); }
  };
  const viewName = book.view === 'trash' ? '回收站' : book.view === 'archive' ? '归档笔记' : '全部笔记';
  const activeView = book.tag ? `${viewName} · #${book.tag}` : viewName;
  const disabled = !!transfer || uploading || book.busy || syncing;
  const commandMatch = (...labels: string[]) => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return !query || labels.some((label) => label.toLocaleLowerCase().includes(query));
  };
  const commandActions = [
    {
      id: 'new', label: '新建笔记', aliases: ['新建'], icon: <Plus size={16} />, shortcut: '',
      disabled: !!transfer || book.loading,
      action: () => { setCommandPalette(false); void createNote(); },
    },
    {
      id: 'save', label: '同步并更新历史版本', aliases: ['保存', '同步', '保存并同步'], icon: <Save size={16} />, shortcut: 'Cmd/Ctrl+S',
      disabled: disabled || (!note && !book.pending.length),
      action: () => { setCommandPalette(false); void syncNow(); },
    },
    {
      id: 'search', label: '搜索笔记', aliases: ['搜索'], icon: <Search size={16} />, shortcut: '',
      disabled: false,
      action: () => {
        book.setQuery(commandQuery);
        setCommandPalette(false);
        requestAnimationFrame(() => searchInput.current?.focus());
      },
    },
    {
      id: 'layout', label: layout === 'edit' ? '切换到预览模式' : '切换到编辑模式',
      aliases: ['编辑', '预览', '切换'], icon: layout === 'edit' ? <BookOpen size={16} /> : <PenLine size={16} />,
      shortcut: 'Ctrl+E / Cmd+Enter', disabled: !note || !!note.deletedAt,
      action: () => { setCommandPalette(false); toggleLayout(); },
    },
    {
      id: 'pin', label: note?.pinned ? '取消置顶' : '置顶笔记', aliases: ['置顶'],
      icon: <Pin size={16} />, shortcut: '', disabled: !note || !!note.deletedAt || !!transfer,
      action: () => { setCommandPalette(false); if (note) setNoteFields({ pinned: !note.pinned }); },
    },
    {
      id: 'archive', label: note?.archived ? '取消归档' : '归档笔记', aliases: ['归档'],
      icon: note?.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />, shortcut: '',
      disabled: !note || !!note.deletedAt || !!transfer,
      action: () => { setCommandPalette(false); if (note) setNoteFields({ archived: !note.archived }); },
    },
    {
      id: 'history', label: '查看历史版本', aliases: ['历史', '版本'], icon: <History size={16} />,
      shortcut: '', disabled: disabled || !note || note.revision === 0,
      action: () => { setCommandPalette(false); openHistory(); },
    },
    {
      id: 'outline', label: '打开大纲与反向链接', aliases: ['大纲', '反向链接'], icon: <ListTree size={16} />,
      shortcut: '', disabled: !note,
      action: () => { setCommandPalette(false); setInspector(true); },
    },
    {
      id: 'tasks', label: '打开任务中心', aliases: ['任务', '待办', 'TODO'], icon: <ClipboardList size={16} />,
      shortcut: '', disabled: false,
      action: () => { setCommandPalette(false); void openTaskCenter(); },
    },
    {
      id: 'link', label: '插入内部链接', aliases: ['链接'], icon: <Link2 size={16} />,
      shortcut: '', disabled: !note || !!note.deletedAt || !!transfer,
      action: () => {
        setCommandPalette(false);
        setLayout('edit');
        requestAnimationFrame(beginLinkInsertion);
      },
    },
    {
      id: 'pdf', label: '导出当前笔记为 PDF', aliases: ['PDF', '打印', '导出'], icon: <Printer size={16} />,
      shortcut: 'Cmd/Ctrl+P', disabled: !note || printing,
      action: () => { setCommandPalette(false); exportCurrentNote(); },
    },
    {
      id: 'share', label: '创建只读分享链接', aliases: ['分享', '只读链接'], icon: <Share2 size={16} />,
      shortcut: '', disabled: !note || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id),
      action: () => { setCommandPalette(false); setSharing(true); },
    },
    {
      id: 'settings', label: '打开设置', aliases: ['设置'], icon: <Settings size={16} />,
      shortcut: '', disabled: false,
      action: () => { setCommandPalette(false); setSettings(true); },
    },
    {
      id: 'shortcuts', label: '查看快捷键', aliases: ['快捷键', '帮助'], icon: <Keyboard size={16} />,
      shortcut: 'Cmd/Ctrl+/', disabled: false, action: showShortcutHelp,
    },
  ].filter((command) => commandMatch(command.label, ...command.aliases));
  const focusCommand = (edge: 'first' | 'last' = 'first') => {
    const buttons = [...(commandList.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    buttons[edge === 'first' ? 0 : buttons.length - 1]?.focus();
  };
  return <div
    className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${mobileNote ? 'mobile-note' : ''} ${resizingList ? 'resizing-list' : ''} ${inspector ? 'inspector-open' : ''}`}
    style={{ '--note-list-width': `${noteListWidth}px` } as CSSProperties}
  >
    <aside className="sidebar">
      <div className="brand"><BrandIcon size={25} /><span>EasyNote</span>
        <IconButton label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={16} /></IconButton>
      </div>
      <button className="new-note" disabled={!!transfer || book.loading} onClick={() => void createNote()}><Plus size={17} />新建笔记</button>
      <nav aria-label="笔记分类">
        <button className={book.view === 'all' && !book.tag ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={17} />全部笔记</button>
        <button onClick={() => void openTaskCenter()}><ClipboardList size={17} />任务中心</button>
        <button className={book.view === 'archive' ? 'active' : ''} onClick={() => chooseView('archive')}><Archive size={17} />归档笔记</button>
        <button className={book.view === 'trash' ? 'active' : ''} onClick={() => chooseView('trash')}><Trash2 size={17} />回收站</button>
      </nav>
      <div className="section-label"><span>标签</span><IconButton label="管理标签" onClick={() => setTagManager(true)}><Tags size={14} /></IconButton></div>
      <nav className="tag-nav" aria-label="标签">{book.tags.map((tag) =>
        <button key={tag} className={book.tag === tag ? 'active' : ''} onClick={() => chooseView(book.view, tag)}><span className="tag-dot" />{tag}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="account" onClick={() => setSettings(true)}><span className="avatar">{session.user!.username[0].toUpperCase()}</span><span>{session.user!.username}</span><Settings size={16} /></button>
      </div>
    </aside>
    <section className="note-list">
      <header className="list-header">
        <div className="list-heading">
          <IconButton label="打开导航菜单" className="icon-button mobile-menu-trigger" onClick={() => setMobileNavigation(true)}><Menu size={21} /></IconButton>
          {!sidebar && <IconButton label="展开侧栏" onClick={() => setSidebar(true)}><MoreHorizontal size={18} /></IconButton>}
          <h1>{activeView}</h1>
          <IconButton label={mobileSearch || book.query ? '关闭搜索' : '搜索笔记'} className="icon-button mobile-search-trigger"
            aria-pressed={mobileSearch || !!book.query} onClick={toggleMobileSearch}>
            {mobileSearch || book.query ? <X size={20} /> : <Search size={20} />}
          </IconButton>
          <IconButton label="快速跳转" className="icon-button list-command-action" onClick={() => { setCommandQuery(''); setCommandPalette(true); }}><Command size={16} /></IconButton>
          {book.view !== 'trash' && <IconButton label={selectionMode ? '退出批量选择' : '批量选择'} className="icon-button list-bulk-action" aria-pressed={selectionMode} onClick={() => {
            if (selectionMode) exitSelectionMode();
            else setSelectionMode(true);
          }}>{selectionMode ? <CheckSquare size={16} /> : <Square size={16} />}</IconButton>}
          <IconButton label={syncing ? '正在同步全部' : '同步全部'} className="icon-button list-sync-action" onClick={() => void syncNow(false)} disabled={book.busy || syncing}>{syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</IconButton>
          {book.view === 'trash' && (book.notes.length > 0 || !!book.query || !!book.tag) &&
            <IconButton label="全部永久删除" className="icon-button danger-icon list-purge-action" onClick={() => setConfirmAction('purge-all')} disabled={disabled || book.pending.length > 0}><Trash2 size={17} /></IconButton>}
          <IconButton label="新建笔记" className="icon-button list-create-action" onClick={() => void createNote()} disabled={!!transfer || book.loading}><Plus size={18} /></IconButton>
        </div>
        {selectionMode && <div className="bulk-toolbar">
          <div className="bulk-toolbar-header">
            <span>已选 {selected.size} 篇</span>
            <button aria-label={allVisibleSelected ? '取消全选' : '全部选中'} disabled={!book.notes.length} onClick={toggleSelectAll}>
              {allVisibleSelected ? <Square size={14} /> : <CheckSquare size={14} />}{allVisibleSelected ? '取消全选' : '全选'}
            </button>
            <button aria-label="退出批量选择" onClick={exitSelectionMode}><X size={14} />退出</button>
          </div>
          <div className="bulk-toolbar-actions">
            <button disabled={!selected.size || disabled} onClick={applyBulkArchive}>{book.view === 'archive' ? <ArchiveRestore size={14} /> : <Archive size={14} />}{book.view === 'archive' ? '取消归档' : '归档'}</button>
            <button disabled={!selected.size || disabled} onClick={() => setBulkTagOpen(true)}><Tag size={14} />加标签</button>
            <button className="danger" disabled={!selected.size || disabled} onClick={() => setConfirmAction('bulk-trash')}><Trash2 size={14} />删除</button>
          </div>
        </div>}
        <label className={`search-field ${mobileSearch || book.query ? 'mobile-open' : ''}`}><Search size={15} /><input ref={searchInput} aria-label="搜索笔记" placeholder="搜索笔记" value={book.query}
          onChange={(e) => {
            const value = e.target.value;
            book.setQuery(value);
            setMobileSearch(!!value);
          }}
          onBlur={() => { if (!searchInput.current?.value) setMobileSearch(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { book.setQuery(''); setMobileSearch(false); } }} /></label>
      </header>
      <div className="list-scroll" onKeyDown={(event) => moveButtonFocus(event, '.note-row')}>
        {book.loading ? <div className="empty-state">正在加载…</div> : !book.notes.length ? <div className="empty-state"><FileText size={28} /><span>{book.query ? '没有匹配的笔记' : '暂无笔记'}</span></div> : book.notes.map((item) =>
          <button className={`note-row ${item.id === note?.id ? 'selected' : ''} ${selected.has(item.id) ? 'checked' : ''}`} data-note-row key={item.id}
            aria-pressed={selectionMode ? selected.has(item.id) : undefined}
            onClick={() => selectionMode ? toggleSelected(item.id) : void openNote(item.id)}>
            <div className="note-row-title">{selectionMode && (selected.has(item.id) ? <CheckSquare size={14} /> : <Square size={14} />)}<span>{highlightMatches(item.title || '未命名笔记', book.query)}</span>{item.pinned && <Pin size={12} />}</div>
            <div className="note-excerpt">{highlightMatches(noteExcerptText(item.excerpt, book.query) || '空白笔记', book.query)}</div>
            <div className="note-row-meta"><time>{new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</time>{item.tags[0] && <span>#{item.tags[0]}</span>}{book.pending.some((n) => n.id === item.id) && <span className="local-dot" title="本机草稿" />}</div>
          </button>)}
        {book.nextOffset !== null && <button className="load-more" onClick={() => void run(book.loadMore)}>加载更多<ChevronDown size={14} /></button>}
      </div>
      <footer className="list-footer">{book.notes.length} 篇{book.nextOffset !== null ? '+' : ''}
        {(!book.online || session.offline) && <span><WifiOff size={11} />离线</span>}
      </footer>
      <button className="mobile-compose" aria-label="新建笔记" disabled={!!transfer || book.loading} onClick={() => void createNote()}><PenLine size={23} /></button>
    </section>
    <div
      className="note-list-resizer"
      role="separator"
      aria-label="调整笔记列表宽度"
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={440}
      aria-valuenow={noteListWidth}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={beginNoteListResize}
      onPointerMove={moveNoteListResize}
      onPointerUp={finishNoteListResize}
      onPointerCancel={finishNoteListResize}
      onDoubleClick={() => {
        updateNoteListWidth(300);
        localStorage.setItem('easynote-note-list-width', '300');
      }}
      onKeyDown={resizeNoteListWithKeyboard}
    />
    <main className="workspace">
      <header className="workspace-toolbar">
        <IconButton label="返回笔记列表" className="icon-button mobile-back" onClick={() => setMobileNote(false)}><ArrowLeft size={18} /></IconButton>
        <span className={`save-status ${book.pending.length ? 'pending' : ''}`}><span className="status-dot" />{uploading ? '上传文件中' : syncing ? '正在同步' : note ? book.status : '笔记空间'}</span>
        <div className="toolbar-right">
          {note && <><div className="segmented" aria-label="显示模式"><button title="编辑" aria-label="编辑模式" aria-pressed={layout === 'edit'} onClick={() => editAt(Math.min(editorCursor.current, note.content.length))}><PenLine size={16} /></button><button title="预览" aria-label="预览模式" aria-pressed={layout === 'preview'} onClick={showPreview}><BookOpen size={16} /></button></div>
            <IconButton label="插入内部链接" className="icon-button toolbar-link-action" disabled={!!note.deletedAt || !!transfer} onClick={beginLinkInsertion}><Link2 size={17} /></IconButton>
            <IconButton label="大纲与反向链接" className="icon-button toolbar-outline-action" aria-pressed={inspector} onClick={() => setInspector((value) => !value)}><ListTree size={17} /></IconButton>
            <IconButton label={wideDocument ? '使用阅读宽度' : '使用宽屏'} className="icon-button document-width-toggle" aria-pressed={wideDocument} onClick={toggleDocumentWidth}>{wideDocument ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
            <IconButton label={syncing ? '正在同步并更新历史版本' : '同步并更新历史版本'} disabled={disabled} onClick={() => void syncNow()}>{syncing ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}</IconButton>
            <IconButton label={note.pinned ? '取消置顶' : '置顶'} disabled={!!note.deletedAt || !!transfer} onClick={() => setNoteFields({ pinned: !note.pinned })}><Pin size={17} fill={note.pinned ? 'currentColor' : 'none'} /></IconButton>
            <IconButton label={note.archived ? '取消归档' : '归档'} disabled={!!note.deletedAt || !!transfer} onClick={() => setNoteFields({ archived: !note.archived })}>{note.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}</IconButton>
            <IconButton label="只读分享" className="icon-button toolbar-share-action" disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
              onClick={() => setSharing(true)}><Share2 size={17} /></IconButton>
            <IconButton label={pdfProgress || '导出当前笔记为 PDF'} className="icon-button print-action" disabled={printing} onClick={exportCurrentNote}>{printing ? <LoaderCircle className="spin" size={17} /> : <Printer size={17} />}</IconButton>
            <IconButton label="历史版本" className="icon-button toolbar-history-action" disabled={disabled || note.revision === 0} onClick={openHistory}><History size={17} /></IconButton>
            {!note.deletedAt ? <IconButton label="移入回收站" disabled={disabled} onClick={() => setConfirmAction('trash')}><Trash2 size={17} /></IconButton> :
              <IconButton label="恢复笔记" disabled={disabled} onClick={() => setNoteFields({ deletedAt: null })}><RotateCcw size={17} /></IconButton>}
            <IconButton label="更多笔记操作" className="icon-button mobile-note-menu-trigger" onClick={() => setMobileNoteActions(true)}><MoreHorizontal size={20} /></IconButton>
          </>}
        </div>
      </header>
      {book.error && <div className="error-strip" role="alert"><details><summary>操作未完成</summary><pre>{book.error}</pre></details><button onClick={() => void syncNow()} disabled={book.busy || syncing}>{syncing ? '正在重试…' : '重试'}</button><IconButton label="关闭错误" onClick={() => book.setError('')}><X size={15} /></IconButton></div>}
      {note ? <>
        {note.deletedAt && <div className="trash-banner"><span>已移入回收站</span><button onClick={() => setConfirmAction('purge')} disabled={disabled || book.pending.some((n) => n.id === note.id)}>永久删除</button></div>}
        <div className="workspace-body">
          <div className="document-scroll">
            <div className={`document ${wideDocument ? 'wide' : ''}`}>
              <input className="note-title" aria-label="笔记标题" placeholder="未命名笔记" maxLength={256} value={note.title} readOnly={!!note.deletedAt || !!transfer} onChange={(e) => setNoteFields({ title: e.target.value })} />
              <div className="document-meta"><time>{new Date(note.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</time><span>修订 {note.revision}</span></div>
              {layout === 'preview' || note.deletedAt || transfer
                ? <Preview content={note.content} onImage={setLightbox} onNote={(id) => void openNote(id)}
                    onFile={(id, href) => void run(() => downloadPrivateFile(id, href))}
                    onTask={!note.deletedAt && !transfer ? (index, checked) =>
                      setNoteFields({ content: toggleMarkdownTask(note.content, index, checked) }) : undefined}
                    resolveFile={book.offlineLibrary ? book.cachedFile : undefined} dark={dark}
                    searchQuery={book.query}
                    onEditLine={!note.deletedAt && !transfer ? (line) => editAt(sourceLineOffset(note.content, line)) : undefined} />
                : <Editor ref={editor} key={note.id} value={note.content} onChange={(content) => setNoteFields({ content })}
                    onImages={(files, insertion) => void insertFiles(files, insertion)}
                    onTogglePreview={toggleLayout} onShowShortcuts={showShortcutHelp} searchQuery={book.query} />}
            </div>
          </div>
          {inspector && <aside className="knowledge-panel" aria-label="笔记导航">
            <header><span>大纲与链接</span><IconButton label="关闭笔记导航" onClick={() => setInspector(false)}><X size={15} /></IconButton></header>
            <section><h3>大纲</h3>{outline.length ? <nav>{outline.map((heading, index) =>
              <button key={`${heading.offset}-${index}`} style={{ paddingLeft: `${8 + Math.max(0, heading.level - 1) * 10}px` }} onClick={() => goToHeading(heading.offset)}>{heading.text}</button>)}</nav>
              : <div className="panel-empty">没有标题</div>}</section>
            <section><h3>反向链接</h3>{backlinks.length ? <nav>{backlinks.map((item) =>
              <button key={item.id} onClick={() => void openNote(item.id)}><Link2 size={13} />{item.title || '未命名笔记'}</button>)}</nav>
              : <div className="panel-empty">没有反向链接</div>}</section>
          </aside>}
        </div>
        <footer className="document-footer">
          <label className="tags-input"><Tag size={15} /><input aria-label="笔记标签" placeholder="标签" value={tagText} disabled={!!note.deletedAt || !!transfer} onChange={(e) => setTagText(e.target.value)} onBlur={() => {
            const tags = [...new Set(tagText.split(/[,，]/).map((v) => v.trim()).filter(Boolean))];
            if (tags.length > 20 || tags.some((t) => t.length > 40)) { book.setError('最多 20 个标签，每个不超过 40 字符。'); setTagText(note.tags.join(', ')); return; }
            if (JSON.stringify(tags) !== JSON.stringify(note.tags)) setNoteFields({ tags });
          }} /></label>
          <span className="word-count">{note.content.length.toLocaleString()} 字符</span>
          <IconButton label={pdfProgress || '导出当前笔记为 PDF'} className="icon-button mobile-pdf-action" disabled={printing}
            onClick={exportCurrentNote}>{printing ? <LoaderCircle className="spin" size={17} /> : <Printer size={17} />}</IconButton>
          <IconButton label="只读分享" className="icon-button mobile-share-action"
            disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
            onClick={() => setSharing(true)}><Share2 size={17} /></IconButton>
          <IconButton label="插入附件" disabled={uploading || !!note.deletedAt || !!transfer || !book.online} onClick={() => {
            pendingInsertion.current = editor.current?.markInsertion() ?? null;
            attachmentInput.current?.click();
          }}><Paperclip size={18} /></IconButton>
          <IconButton label="插入图片" disabled={uploading || !!note.deletedAt || !!transfer || !book.online} onClick={() => {
            pendingInsertion.current = editor.current?.markInsertion() ?? null;
            imageInput.current?.click();
          }}><ImagePlus size={19} /></IconButton>
          <input hidden ref={attachmentInput} type="file" accept=".pdf,.md,.txt,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json" multiple onChange={(e) => void insertFiles(Array.from(e.target.files ?? []))} />
          <input hidden ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void insertFiles(Array.from(e.target.files ?? []))} />
        </footer>
      </> : <div className="workspace-empty"><PenLine size={36} /><h2>你的笔记</h2><button className="primary" disabled={book.loading || !!transfer} onClick={() => void createNote()}><Plus size={16} />新建笔记</button></div>}
    </main>
    {notice && <div className="toast" role="status"><Check size={16} />{notice.text}</div>}
    <input hidden ref={importInput} type="file" accept=".zip,.md,.markdown,.txt" multiple onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) void transferAction(() =>
        importExternalFiles(files, session.config, setTransfer, book.findDuplicates), ({ imported, skipped }) =>
        imported ? `已导入 ${imported} 篇${skipped ? `，跳过 ${skipped} 篇重复笔记` : '笔记'}` : `未导入：${skipped} 篇笔记已存在`);
      e.target.value = '';
    }} />
    <input hidden ref={importFolderInput} type="file" multiple {...{ webkitdirectory: '' }} onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) void transferAction(() =>
        importExternalFiles(files, session.config, setTransfer, book.findDuplicates), ({ imported, skipped }) =>
        imported ? `已导入 ${imported} 篇${skipped ? `，跳过 ${skipped} 篇重复笔记` : '笔记'}` : `未导入：${skipped} 篇笔记已存在`);
      e.target.value = '';
    }} />
    {mobileNavigation && <Modal title="EasyNote" className="mobile-navigation-dialog" close={() => setMobileNavigation(false)}>
      <nav className="mobile-navigation-list" aria-label="移动端笔记分类">
        <button className={book.view === 'all' && !book.tag ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={18} />全部笔记</button>
        <button onClick={() => { setMobileNavigation(false); void openTaskCenter(); }}><ClipboardList size={18} />任务中心</button>
        <button className={book.view === 'archive' ? 'active' : ''} onClick={() => chooseView('archive')}><Archive size={18} />归档笔记</button>
        <button className={book.view === 'trash' ? 'active' : ''} onClick={() => chooseView('trash')}><Trash2 size={18} />回收站</button>
      </nav>
      {book.tags.length > 0 && <>
        <div className="mobile-navigation-label">标签</div>
        <nav className="mobile-navigation-list" aria-label="移动端标签">{book.tags.map((tag) =>
          <button key={tag} className={book.tag === tag ? 'active' : ''} onClick={() => chooseView(book.view, tag)}><span className="tag-dot" />{tag}</button>)}
        </nav>
      </>}
      <div className="mobile-navigation-actions">
        <button onClick={() => { setMobileNavigation(false); setCommandQuery(''); setCommandPalette(true); }}><Command size={18} />快速跳转</button>
        {book.view !== 'trash' && <button onClick={() => {
          setMobileNavigation(false);
          setSelectionMode(true);
          setSelected(new Set());
        }}><CheckSquare size={18} />批量选择</button>}
        <button disabled={book.busy || syncing} onClick={() => { setMobileNavigation(false); void syncNow(false); }}><RefreshCw size={18} />同步全部</button>
        {book.view === 'trash' && (book.notes.length > 0 || !!book.query || !!book.tag) &&
          <button className="danger" disabled={disabled || book.pending.length > 0} onClick={() => { setMobileNavigation(false); setConfirmAction('purge-all'); }}><Trash2 size={18} />全部永久删除</button>}
        <button onClick={() => { setMobileNavigation(false); setSettings(true); }}><Settings size={18} />设置</button>
      </div>
    </Modal>}
    {mobileNoteActions && note && <Modal title="笔记操作" className="mobile-actions-dialog" close={() => setMobileNoteActions(false)}>
      <div className="mobile-action-list">
        <button disabled={disabled} onClick={() => { setMobileNoteActions(false); void syncNow(); }}><Save size={18} />同步并保存版本</button>
        <button disabled={!!note.deletedAt || !!transfer} onClick={() => { setMobileNoteActions(false); beginLinkInsertion(); }}><Link2 size={18} />插入内部链接</button>
        <button onClick={() => { setMobileNoteActions(false); setInspector((value) => !value); }}><ListTree size={18} />大纲与反向链接</button>
        <button disabled={!!note.deletedAt || !!transfer} onClick={() => { setMobileNoteActions(false); setNoteFields({ pinned: !note.pinned }); }}><Pin size={18} fill={note.pinned ? 'currentColor' : 'none'} />{note.pinned ? '取消置顶' : '置顶'}</button>
        <button disabled={!!note.deletedAt || !!transfer} onClick={() => { setMobileNoteActions(false); setNoteFields({ archived: !note.archived }); }}>{note.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}{note.archived ? '取消归档' : '归档'}</button>
        <button className="mobile-share-action" disabled={disabled || note.revision === 0 || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
          onClick={() => { setMobileNoteActions(false); setSharing(true); }}><Share2 size={18} />只读分享</button>
        <button className="mobile-pdf-action" disabled={printing} onClick={() => { setMobileNoteActions(false); exportCurrentNote(); }}><Printer size={18} />导出为 PDF</button>
        <button disabled={disabled || note.revision === 0} onClick={() => { setMobileNoteActions(false); openHistory(); }}><History size={18} />历史版本</button>
        {!note.deletedAt
          ? <button className="danger" disabled={disabled} onClick={() => { setMobileNoteActions(false); setConfirmAction('trash'); }}><Trash2 size={18} />移入回收站</button>
          : <button onClick={() => { setMobileNoteActions(false); setNoteFields({ deletedAt: null }); }}><RotateCcw size={18} />恢复笔记</button>}
      </div>
    </Modal>}
    {settings && <Modal title="设置" close={() => { if (!transfer) setSettings(false); }}>
      <div className="setting-row"><span>深色外观</span><button role="switch" aria-checked={dark} aria-label="深色外观" className={`switch ${dark ? 'on' : ''}`} onClick={() => setDark(!dark)}>{dark ? <Moon size={14} /> : <Sun size={14} />}</button></div>
      <div className="setting-row"><span>离线笔记库{book.offlineLibrary ? ` · ${book.offlineCount} 篇` : ''}</span><button role="switch" aria-checked={book.offlineLibrary} aria-label="离线笔记库" className={`switch ${book.offlineLibrary ? 'on' : ''}`} disabled={disabled || session.offline} onClick={() => void run(() => book.configureOffline(!book.offlineLibrary))}>{book.offlineLibrary ? <Check size={14} /> : <WifiOff size={14} />}</button></div>
      {installApp && <div className="setting-row"><span>应用</span><button disabled={disabled} onClick={() => void run(installApp)}><Download size={16} />安装 EasyNote</button></div>}
      <div className="setting-row"><span>数据</span><div className="button-group">
        <button disabled={!!transfer || !book.online} onClick={() => void transferAction(() => exportArchive(setTransfer), '备份已下载')}><Download size={16} />导出 ZIP</button>
        <button disabled={!!transfer || !book.online} onClick={() => importInput.current?.click()}><Upload size={16} />导入文件</button>
        <button disabled={!!transfer || !book.online} onClick={() => importFolderInput.current?.click()}><FolderOpen size={16} />导入目录</button>
        <button disabled={!!transfer || !book.pending.length} onClick={() => {
          setTransfer('正在准备草稿…');
          void exportLocalDrafts(session.user!.id, setTransfer).then((count) => showNotice(`已导出 ${count} 篇本机草稿`))
            .catch((error: unknown) => book.setError(String(error))).finally(() => setTransfer(''));
        }}><Download size={16} />导出草稿</button>
      </div></div>
      <div className="setting-row"><span>账户安全</span><button disabled={disabled || session.offline} onClick={() => { setSettings(false); setAccountSecurity(true); }}><ShieldCheck size={16} />管理</button></div>
      {session.user!.role === 'admin' && <div className="setting-row"><span>用户与注册</span><button disabled={disabled || session.offline}
        onClick={() => { setSettings(false); setUserManagement(true); }}><Users size={16} />管理用户</button></div>}
      <AiAccess disabled={disabled || !book.online || !!session.offline} reportError={book.setError} notify={showNotice} />
      <details className="import-guide">
        <summary>查看导入格式示例</summary>
        <p>请选择 EasyNote 导出的完整 ZIP，不要解压后逐个选择笔记文件。</p>
        <p>也可导入 Obsidian 目录、通用 Markdown/TXT ZIP 或多个 Markdown/TXT 文件；本地 Wiki 链接、相对链接和受支持附件会自动转换。</p>
        <pre>{`easynote-YYYY-MM-DD.zip
  manifest.json
  notes/
    示例笔记.md
    未命名.md
  files/
    <file-id>-附件名`}</pre>
        <p><code>manifest.json</code> 示例：</p>
        <pre>{`{
  "format": "easynote",
  "version": 2,
  "notes": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "path": "notes/示例笔记.md",
      "title": "示例笔记",
      "tags": ["示例"],
      "pinned": false,
      "archived": false,
      "deletedAt": null
    }
  ],
  "files": []
}`}</pre>
        <p>笔记文件优先使用标题命名，重名时自动编号；ZIP 根据清单恢复原标题。单独导入 Markdown 或 TXT 时，正文首个非空行作为标题。正文完全一致或完全空白的重复笔记会自动跳过。</p>
      </details>
      {transfer && <div className="transfer-progress" role="status">{transfer}</div>}
      <div className="setting-row"><span>{session.user!.username}</span><button disabled={disabled} onClick={() => void run(async () => {
        if (book.pending.length) throw new Error('本机还有未上传草稿，请先完成保存。');
        if (book.online && !session.offline) await api.logout();
        await logout();
      })}><LogOut size={16} />退出登录</button></div>
      <div className="setting-row"><span>版本</span><span className="setting-value">EasyNote {__EASYNOTE_VERSION__}</span></div>
    </Modal>}
    {accountSecurity && <Modal title="账户安全" close={() => setAccountSecurity(false)}>
      <AccountSecurity username={session.user!.username} disabled={disabled || !!book.pending.length || !book.online || !!session.offline}
        notify={showNotice} reportError={book.setError} logout={logout} />
    </Modal>}
    {userManagement && <Modal title="用户与注册" close={() => setUserManagement(false)}>
      <UserManagement currentUserId={session.user!.id} registrationEnabled={registrationEnabled}
        onRegistrationChange={setRegistrationEnabled}
        disabled={disabled || !book.online || !!session.offline} notify={showNotice} reportError={book.setError} />
    </Modal>}
    {taskCenter && <Modal title="任务中心" close={() => setTaskCenter(false)}>
      <div className="task-center">
        {tasksLoading ? <div className="panel-empty">正在汇总待办…</div> : !tasks.length
          ? <div className="panel-empty">没有未完成的待办事项</div>
          : tasks.map((task) => <button key={`${task.noteId}:${task.offset}`} onClick={() => void openTask(task)}>
            <span className="task-center-copy">
              <span>{task.text}</span>
              <small>{task.noteTitle || '未命名笔记'} · 第 {task.line} 行{task.archived ? ' · 已归档' : ''}</small>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>)}
      </div>
    </Modal>}
    {sharing && note && <Modal title="只读分享" close={() => setSharing(false)}>
      <NoteSharing noteId={note.id} disabled={disabled || !!note.deletedAt || book.pending.some((item) => item.id === note.id)}
        notify={showNotice} reportError={book.setError} />
    </Modal>}
    {commandPalette && <Modal title="快速跳转" close={() => setCommandPalette(false)}>
      <label className="command-search"><Search size={16} /><input autoFocus aria-label="快速跳转搜索" value={commandQuery}
        onChange={(event) => setCommandQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusCommand(event.key === 'ArrowDown' ? 'first' : 'last');
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            focusCommand();
            commandList.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click();
          }
        }} /></label>
      <div ref={commandList} className="command-list" onKeyDown={(event) => moveButtonFocus(event, 'button')}>
        {commandActions.map((command) => <button key={command.id} disabled={command.disabled} onClick={command.action}>
          {command.icon}<span>{command.label}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
        </button>)}
        {commandNotes.map((item) => <button key={item.id} onClick={() => void openNote(item.id)}><FileText size={16} /><span>{item.title || '未命名笔记'}</span></button>)}
      </div>
    </Modal>}
    {shortcutHelp && <Modal title="快捷键" close={() => setShortcutHelp(false)}>
      <div className="shortcut-list">
        <div><span>打开快速跳转</span><kbd>Cmd/Ctrl+K</kbd></div>
        <div><span>同步并更新历史版本</span><kbd>Cmd/Ctrl+S</kbd></div>
        <div><span>编辑 / 预览</span><kbd>Ctrl+E / Cmd+Enter</kbd></div>
        <div><span>导出当前笔记为 PDF</span><kbd>Cmd/Ctrl+P</kbd></div>
        <div><span>粗体</span><kbd>Cmd/Ctrl+B</kbd></div>
        <div><span>斜体</span><kbd>Cmd/Ctrl+I</kbd></div>
        <div><span>快捷键帮助</span><kbd>Cmd/Ctrl+/</kbd></div>
        <div><span>关闭弹窗</span><kbd>Esc</kbd></div>
        <div><span>命令或笔记列表导航</span><kbd>↑ / ↓</kbd></div>
      </div>
    </Modal>}
    {linkPicker && <Modal title="插入内部链接" close={() => {
      if (pendingInsertion.current) editor.current?.releaseInsertion(pendingInsertion.current);
      pendingInsertion.current = null;
      setLinkPicker(false);
    }}>
      <label className="command-search"><Search size={16} /><input autoFocus aria-label="搜索链接目标" value={linkQuery} onChange={(event) => setLinkQuery(event.target.value)} /></label>
      <div className="command-list">{linkNotes.map((item) =>
        <button key={item.id} onClick={() => insertNoteLink(item)}><Link2 size={16} /><span>{item.title || '未命名笔记'}</span></button>)}</div>
    </Modal>}
    {tagManager && <Modal title="管理标签" close={() => setTagManager(false)}>
      <div className="form-grid">
        <label>来源标签<input list="known-tags" value={tagSource} onChange={(event) => setTagSource(event.target.value)} /></label>
        <datalist id="known-tags">{book.tags.map((value) => <option value={value} key={value} />)}</datalist>
        <label>操作<select value={tagAction} onChange={(event) => setTagAction(event.target.value as typeof tagAction)}>
          <option value="rename">重命名</option><option value="merge">合并</option><option value="delete">删除</option>
        </select></label>
        {tagAction !== 'delete' && <label>目标标签<input maxLength={40} value={tagTarget} onChange={(event) => setTagTarget(event.target.value)} /></label>}
      </div>
      <div className="dialog-actions"><button onClick={() => setTagManager(false)}>取消</button><button className={tagAction === 'delete' ? 'danger' : 'primary'} disabled={disabled || !tagSource.trim()} onClick={applyTagManagement}>应用</button></div>
    </Modal>}
    {bulkTagOpen && <Modal title="批量添加标签" close={() => setBulkTagOpen(false)}>
      <label className="single-field">标签<input autoFocus maxLength={40} value={bulkTag} onChange={(event) => setBulkTag(event.target.value)} /></label>
      <div className="dialog-actions"><button onClick={() => setBulkTagOpen(false)}>取消</button><button className="primary" disabled={!bulkTag.trim() || disabled} onClick={applyBulkTag}>添加</button></div>
    </Modal>}
    {book.conflict && <Modal title="检测到版本冲突" className="conflict-dialog" close={() => book.setConflict(null)}>
      <div className="conflict-summary">
        <strong>{book.conflict.local.title || '未命名笔记'}</strong>
        <span>{book.conflict.remote
          ? `本机基于修订 ${book.conflict.base?.revision ?? book.conflict.local.revision}，云端已到修订 ${book.conflict.remote.revision}`
          : '云端笔记已永久删除，本机草稿仍然安全保留。'}</span>
      </div>
      {book.conflict.remote && <div className="conflict-fields">
        {book.conflict.fields.map((field) => <section key={field}>
          <h3>{conflictFieldName[field]}</h3>
          <div className="conflict-versions">
            <div><span>本机修改</span><pre>{conflictFieldValue(book.conflict!.local, field)}</pre></div>
            <div><span>云端修改</span><pre>{conflictFieldValue(book.conflict!.remote!, field)}</pre></div>
          </div>
        </section>)}
      </div>}
      <div className="dialog-actions conflict-actions">
        <button onClick={() => book.setConflict(null)}>稍后处理</button>
        {book.conflict.remote
          ? <>
            <button onClick={() => void run(book.conflictCopy)}>另存副本</button>
            <button onClick={() => void run(() => book.resolveConflict('remote'))}>采用云端</button>
            <button className="primary" onClick={() => void run(() => book.resolveConflict('local'))}>采用本机</button>
          </>
          : <>
            <button onClick={() => void run(book.discardConflict)}>放弃草稿</button>
            <button className="primary" onClick={() => void run(book.conflictCopy)}>另存为新笔记</button>
          </>}
      </div>
    </Modal>}
    {versionList && versionNoteId === note?.id && <Modal title="历史版本" close={() => { setVersionList(null); setChosenVersion(null); }}>
      <div className="version-list">{versionList.map((version) => <button key={version.revision} className={chosenVersion?.revision === version.revision ? 'selected' : ''} onClick={() => setChosenVersion(version)}><span>修订 {version.revision} · {version.actorType === 'ai' ? `AI：${version.actorName}` : version.actorName}</span><time>{new Date(version.savedAt).toLocaleString('zh-CN')}</time></button>)}</div>
      {chosenVersion && <><div className="version-preview"><h3>{chosenVersion.title}</h3><Preview content={chosenVersion.content} onImage={setLightbox} onFile={(id, href) => void run(() => downloadPrivateFile(id, href))} resolveFile={book.offlineLibrary ? book.cachedFile : undefined} dark={dark} /></div><div className="dialog-actions"><button className="primary" disabled={disabled || !!note?.deletedAt} onClick={() => void restoreVersion()}>
        <RotateCcw size={15} />恢复此版本
      </button></div></>}
    </Modal>}
    {confirmAction && <Modal title={confirmAction === 'purge-all' ? '永久删除全部笔记？' : confirmAction === 'purge' ? '永久删除这篇笔记？' :
      confirmAction === 'bulk-trash' ? `将 ${selected.size} 篇笔记移入回收站？` : '移入回收站？'} close={() => setConfirmAction(null)}>
      <div className="confirm-title">{confirmAction === 'purge-all' ? '将永久删除回收站中的全部笔记，此操作无法撤销。' :
        confirmAction === 'bulk-trash' ? `选中的 ${selected.size} 篇笔记将移入回收站，可稍后恢复。` : note?.title || '未命名笔记'}</div>
      <div className="dialog-actions"><button onClick={() => setConfirmAction(null)}>取消</button><button className={confirmAction === 'trash' ? 'primary' : 'danger'} onClick={() => void run(async () => {
        if (confirmAction === 'purge-all') {
          const deleted = await book.purgeTrash();
          showNotice(`已永久删除 ${deleted} 篇笔记`);
        } else if (confirmAction === 'purge') await book.purge();
        else if (confirmAction === 'bulk-trash') await applyBulkTrash();
        else await moveCurrentToTrash();
        setConfirmAction(null);
      })}>{confirmAction === 'purge-all' ? '全部永久删除' : confirmAction === 'purge' ? '永久删除' :
        confirmAction === 'bulk-trash' ? '删除' : '移入回收站'}</button></div>
    </Modal>}
    {pdfExport && <Modal title="导出为 PDF" className="pdf-export-dialog" close={closePdfExport}>
      <div className="pdf-export-layout">
        <PdfPagePreview pages={pdfPreviewPages} progress={pdfProgress} error={pdfPreviewError} />
        <div className="pdf-export-sidebar">
          <div className="pdf-export-form">
            <label className="single-field"><span>文件名</span><span className="pdf-name-input">
              <input aria-label="PDF 文件名" maxLength={120} value={pdfName}
                onChange={(event) => setPdfName(event.target.value)} /><span>.pdf</span>
            </span></label>
            <div className="pdf-export-options">
              <label><span>纸张</span><select aria-label="PDF 纸张" value={pdfOptions.pageSize} disabled={printing}
                onChange={(event) => setPdfOptions((value) => ({ ...value, pageSize: event.target.value as PdfExportOptions['pageSize'] }))}>
                <option value="A4">A4</option>
                <option value="LETTER">Letter</option>
              </select></label>
              <label><span>缩放</span><select aria-label="PDF 缩放" value={pdfOptions.scale} disabled={printing}
                onChange={(event) => setPdfOptions((value) => ({ ...value, scale: Number(event.target.value) }))}>
                <option value="85">85%</option>
                <option value="100">100%</option>
                <option value="115">115%</option>
              </select></label>
            </div>
            <fieldset className="pdf-orientation" disabled={printing}>
              <legend>方向</legend>
              <div className="segmented" aria-label="PDF 方向">
                <button type="button" aria-pressed={pdfOptions.orientation === 'portrait'}
                  onClick={() => setPdfOptions((value) => ({ ...value, orientation: 'portrait' }))}>纵向</button>
                <button type="button" aria-pressed={pdfOptions.orientation === 'landscape'}
                  onClick={() => setPdfOptions((value) => ({ ...value, orientation: 'landscape' }))}>横向</button>
              </div>
            </fieldset>
          </div>
          <div className="dialog-actions">
            <button disabled={printing} onClick={closePdfExport}>取消</button>
            <button className="primary" disabled={printing || !pdfPreviewFile || !pdfName.trim()}
              onClick={() => void confirmPdfExport()}>
              {printing ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
              导出 PDF
            </button>
          </div>
        </div>
      </div>
    </Modal>}
    {lightbox && <Modal title="图片" close={() => setLightbox('')}><img className="lightbox-image" src={lightbox} alt="笔记图片" /></Modal>}
    {printNote && <section className={`print-document ${pdfExport ? 'pdf-rendering' : ''}`} data-printing={pdfExport ? 'true' : 'false'} aria-hidden="true">
      <Preview content={printNote.content} onImage={() => undefined}
        resolveFile={book.offlineLibrary ? book.cachedFile : undefined} dark={false} eagerImages />
    </section>}
  </div>;
}
