import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronDown, Download, FileText, History, ImagePlus, LogOut, Moon, MoreHorizontal, PanelLeftClose, Pin, Plus, RefreshCw, Save, Search, Settings, Sun, Tag, Trash2, Upload, X, RotateCcw, PenLine } from 'lucide-react';
import type { NoteInput, Session, Version } from '../shared/types';
import { api, setSession, uploadImage } from './api';
import { Editor, Preview } from './Editor';
import { useNotebook } from './useNotebook';
import { exportArchive, importArchive } from './transfer';

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button className="icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}

function Modal({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === ref.current) close(); }}>
    <header className="dialog-header"><h2>{title}</h2><IconButton label="关闭" onClick={close}><X size={18} /></IconButton></header>
    {children}
  </dialog>;
}

export default function App() {
  const [session, updateSession] = useState<Session | null>(null);
  const [bootError, setBootError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const applySession = (value: Session) => { setSession(value); updateSession(value); };
  const boot = () => {
    setBootError('');
    void api.session().then(applySession).catch((e: unknown) => setBootError(String(e)));
  };
  useEffect(boot, []);
  if (session?.user) return <AccountWorkspace key={session.user.id} session={session} logout={() => {
    setPassword(''); applySession({ ...session, user: null, csrf: null });
  }} />;
  return <main className="login">
    <form className="login-form" onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setBootError('');
      void api.login(username, password).then((value) => { applySession(value); setPassword(''); })
        .catch((error: unknown) => setBootError(String(error))).finally(() => setBusy(false));
    }}>
      <div className="brand login-brand"><span className="brand-mark"><PenLine size={22} /></span><h1>EasyNote</h1></div>
      <div className="login-heading">{session ? session.configured ? '登录笔记' : '等待初始化' : '正在连接'}</div>
      <label>用户名<input autoComplete="username" required maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label>密码<input autoComplete="current-password" type="password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="primary" disabled={busy || !session?.configured}>{busy ? '登录中…' : '登录'}</button>
      {bootError && <div role="alert" className="error-box"><pre>{bootError}</pre><button type="button" onClick={boot}>重新连接</button></div>}
    </form>
  </main>;
}

function AccountWorkspace({ session, logout }: { session: Session; logout(): void }) {
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
  if (ownsLock) return <Notebook session={session} logout={logout} />;
  return <main className="login"><div className="login-form">
    <div className="brand login-brand"><PenLine size={24} /><h1>EasyNote</h1></div>
    <div className="login-heading">{ownsLock === null ? '正在打开笔记' : navigator.locks ? '另一个标签页正在编辑' : '浏览器不支持安全编辑锁'}</div>
    {ownsLock === false && navigator.locks && <button onClick={() => setAttempt((n) => n + 1)}>重新打开</button>}
  </div></main>;
}

function Notebook({ session, logout }: { session: Session; logout(): void }) {
  const book = useNotebook(session);
  const [layout, setLayout] = useState<'edit' | 'preview'>('edit');
  const [mobileNote, setMobileNote] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [settings, setSettings] = useState(false);
  const [versionList, setVersionList] = useState<Version[] | null>(null);
  const [versionNoteId, setVersionNoteId] = useState('');
  const [chosenVersion, setChosenVersion] = useState<Version | null>(null);
  const [confirmAction, setConfirmAction] = useState<'trash' | 'purge' | null>(null);
  const [lightbox, setLightbox] = useState('');
  const [uploading, setUploading] = useState(false);
  const [transfer, setTransfer] = useState('');
  const [notice, setNotice] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('easynote-theme') === 'dark');
  const [tagText, setTagText] = useState('');
  const imageInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const note = book.note;
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('easynote-theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { setTagText(note?.tags.join(', ') ?? ''); }, [note?.id, JSON.stringify(note?.tags)]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (e) { book.setError(String(e)); }
  };
  const insertImages = async (files: File[]) => {
    if (!note || uploading) return;
    const target = note;
    setUploading(true);
    try {
      for (const file of files) {
        const image = await uploadImage(file, session.config.maxImageBytes, session.config.maxImagePixels);
        const alt = file.name.replace(/[\[\]\\\r\n]/g, '');
        book.append(target, `![${alt}](${image.url})`);
      }
      setNotice('图片已插入');
    } catch (e) { book.setError(String(e)); }
    finally { setUploading(false); if (imageInput.current) imageInput.current.value = ''; }
  };
  const chooseView = (view: string, tag = '') => { book.setView(view); book.setTag(tag); setMobileNote(false); };
  const setNoteFields = (patch: Partial<NoteInput>) => book.edit(patch);
  const transferAction = async (action: () => Promise<unknown>, success: string) => {
    if (book.pending.length || book.busy || uploading) { book.setError('还有未保存的内容，请先完成保存。'); return; }
    setTransfer('正在准备…');
    try { await action(); setNotice(success); await book.refresh(); }
    catch (e) { book.setError(String(e)); }
    finally { setTransfer(''); }
  };
  const activeView = book.view === 'trash' ? '回收站' : book.view === 'pinned' ? '置顶笔记' : book.tag || '全部笔记';
  const disabled = !!transfer || uploading || book.busy;
  return <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${mobileNote ? 'mobile-note' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><PenLine size={19} /></span><span>EasyNote</span>
        <IconButton label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={16} /></IconButton>
      </div>
      <button className="new-note" disabled={!!transfer || book.loading} onClick={() => void book.create().then(() => { setMobileNote(true); setLayout('edit'); })}><Plus size={17} />新建笔记</button>
      <nav aria-label="笔记分类">
        <button className={book.view === 'all' && !book.tag ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={17} />全部笔记</button>
        <button className={book.view === 'pinned' ? 'active' : ''} onClick={() => chooseView('pinned')}><Pin size={17} />置顶笔记</button>
        <button className={book.view === 'trash' ? 'active' : ''} onClick={() => chooseView('trash')}><Trash2 size={17} />回收站</button>
      </nav>
      <div className="section-label"><span>标签</span><Tag size={13} /></div>
      <nav className="tag-nav" aria-label="标签">{book.tags.map((tag) =>
        <button key={tag} className={book.tag === tag ? 'active' : ''} onClick={() => chooseView('all', tag)}><span className="tag-dot" />{tag}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="account" onClick={() => setSettings(true)}><span className="avatar">{session.user!.username[0].toUpperCase()}</span><span>{session.user!.username}</span><Settings size={16} /></button>
      </div>
    </aside>
    <section className="note-list">
      <header className="list-header">
        <div className="list-heading">
          {!sidebar && <IconButton label="展开侧栏" onClick={() => setSidebar(true)}><MoreHorizontal size={18} /></IconButton>}
          <h1>{activeView}</h1>
          <IconButton label="同步" onClick={() => void book.retry()} disabled={book.busy}><RefreshCw size={16} /></IconButton>
          <IconButton label="新建笔记" onClick={() => void book.create().then(() => { setMobileNote(true); setLayout('edit'); })} disabled={!!transfer || book.loading}><Plus size={18} /></IconButton>
        </div>
        <label className="search-field"><Search size={15} /><input aria-label="搜索笔记" placeholder="搜索笔记" value={book.query} onChange={(e) => book.setQuery(e.target.value)} /></label>
        <div className="mobile-filters"><select aria-label="笔记分类" value={book.view} onChange={(e) => chooseView(e.target.value)}><option value="all">全部笔记</option><option value="pinned">置顶笔记</option><option value="trash">回收站</option></select><IconButton label="设置" onClick={() => setSettings(true)}><Settings size={17} /></IconButton></div>
      </header>
      <div className="list-scroll">
        {book.loading ? <div className="empty-state">正在加载…</div> : !book.notes.length ? <div className="empty-state"><FileText size={28} /><span>{book.query ? '没有匹配的笔记' : '暂无笔记'}</span></div> : book.notes.map((item) =>
          <button className={`note-row ${item.id === note?.id ? 'selected' : ''}`} key={item.id} onClick={() => void book.select(item.id).then(() => { setMobileNote(true); setVersionList(null); })}>
            <div className="note-row-title"><span>{item.title || '未命名笔记'}</span>{item.pinned && <Pin size={12} />}</div>
            <div className="note-excerpt">{item.excerpt.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/[#*`]/g, '') || '空白笔记'}</div>
            <div className="note-row-meta"><time>{new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</time>{item.tags[0] && <span>#{item.tags[0]}</span>}{book.pending.some((n) => n.id === item.id) && <span className="local-dot" title="本机草稿" />}</div>
          </button>)}
        {book.nextOffset !== null && <button className="load-more" onClick={() => void run(book.loadMore)}>加载更多<ChevronDown size={14} /></button>}
      </div>
      <footer className="list-footer">{book.notes.length} 篇{book.nextOffset !== null ? '+' : ''}<span>EasyNote 0.1</span></footer>
    </section>
    <main className="workspace">
      <header className="workspace-toolbar">
        <IconButton label="返回笔记列表" className="icon-button mobile-back" onClick={() => setMobileNote(false)}><ArrowLeft size={18} /></IconButton>
        <span className={`save-status ${book.pending.length ? 'pending' : ''}`}><span className="status-dot" />{uploading ? '上传图片中' : note ? book.status : '笔记空间'}</span>
        <div className="toolbar-right">
          {note && <><div className="segmented" aria-label="显示模式"><button title="编辑" aria-label="编辑模式" aria-pressed={layout === 'edit'} onClick={() => setLayout('edit')}><PenLine size={16} /></button><button title="预览" aria-label="预览模式" aria-pressed={layout === 'preview'} onClick={() => setLayout('preview')}><BookOpen size={16} /></button></div>
            <IconButton label="保存" disabled={disabled} onClick={() => void book.retry()}><Save size={17} /></IconButton>
            <IconButton label={note.pinned ? '取消置顶' : '置顶'} disabled={!!note.deletedAt || !!transfer} onClick={() => setNoteFields({ pinned: !note.pinned })}><Pin size={17} fill={note.pinned ? 'currentColor' : 'none'} /></IconButton>
            <IconButton label="历史版本" disabled={disabled || note.revision === 0} onClick={() => void run(async () => { const result = await api.versions(note.id); setVersionNoteId(note.id); setVersionList(result.versions); setChosenVersion(null); })}><History size={17} /></IconButton>
            {!note.deletedAt ? <IconButton label="移入回收站" disabled={disabled} onClick={() => setConfirmAction('trash')}><Trash2 size={17} /></IconButton> :
              <IconButton label="恢复笔记" disabled={disabled} onClick={() => setNoteFields({ deletedAt: null })}><RotateCcw size={17} /></IconButton>}
          </>}
        </div>
      </header>
      {book.error && <div className="error-strip" role="alert"><details><summary>操作未完成</summary><pre>{book.error}</pre></details><button onClick={() => void book.retry()} disabled={book.busy}>重试</button><IconButton label="关闭错误" onClick={() => book.setError('')}><X size={15} /></IconButton></div>}
      {note ? <>
        {note.deletedAt && <div className="trash-banner"><span>已移入回收站</span><button onClick={() => setConfirmAction('purge')} disabled={disabled || book.pending.some((n) => n.id === note.id)}>永久删除</button></div>}
        <div className="document-scroll">
          <div className="document">
            <input className="note-title" aria-label="笔记标题" placeholder="未命名笔记" maxLength={256} value={note.title} readOnly={!!note.deletedAt || !!transfer} onChange={(e) => setNoteFields({ title: e.target.value })} />
            <div className="document-meta"><time>{new Date(note.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</time><span>修订 {note.revision}</span></div>
            {layout === 'preview' || note.deletedAt || transfer ? <Preview content={note.content} onImage={setLightbox} /> :
              <Editor key={note.id} value={note.content} onChange={(content) => setNoteFields({ content })} onImages={(files) => void insertImages(files)} />}
          </div>
        </div>
        <footer className="document-footer">
          <label className="tags-input"><Tag size={15} /><input aria-label="笔记标签" placeholder="标签" value={tagText} disabled={!!note.deletedAt || !!transfer} onChange={(e) => setTagText(e.target.value)} onBlur={() => {
            const tags = [...new Set(tagText.split(/[,，]/).map((v) => v.trim()).filter(Boolean))];
            if (tags.length > 20 || tags.some((t) => t.length > 40)) { book.setError('最多 20 个标签，每个不超过 40 字符。'); setTagText(note.tags.join(', ')); return; }
            if (JSON.stringify(tags) !== JSON.stringify(note.tags)) setNoteFields({ tags });
          }} /></label>
          <span className="word-count">{note.content.length.toLocaleString()} 字符</span>
          <IconButton label="插入图片" disabled={uploading || !!note.deletedAt || !!transfer} onClick={() => imageInput.current?.click()}><ImagePlus size={19} /></IconButton>
          <input hidden ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void insertImages(Array.from(e.target.files ?? []))} />
        </footer>
      </> : <div className="workspace-empty"><PenLine size={36} /><h2>你的笔记</h2><button className="primary" disabled={book.loading || !!transfer} onClick={() => void book.create().then(() => setMobileNote(true))}><Plus size={16} />新建笔记</button></div>}
    </main>
    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    {settings && <Modal title="设置" close={() => { if (!transfer) setSettings(false); }}>
      <div className="setting-row"><span>深色外观</span><button role="switch" aria-checked={dark} aria-label="深色外观" className={`switch ${dark ? 'on' : ''}`} onClick={() => setDark(!dark)}>{dark ? <Moon size={14} /> : <Sun size={14} />}</button></div>
      <div className="setting-row"><span>数据</span><div className="button-group"><button disabled={!!transfer} onClick={() => void transferAction(() => exportArchive(setTransfer), '备份已下载')}><Download size={16} />导出 ZIP</button><button disabled={!!transfer} onClick={() => importInput.current?.click()}><Upload size={16} />导入</button></div></div>
      <input hidden ref={importInput} type="file" accept=".zip,.md,.txt" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void transferAction(() => importArchive(file, session.config, setTransfer), '导入完成');
        e.target.value = '';
      }} />
      {transfer && <div className="transfer-progress" role="status">{transfer}</div>}
      <div className="setting-row"><span>{session.user!.username}</span><button disabled={disabled} onClick={() => void run(async () => {
        if (book.pending.length) throw new Error('本机还有未上传草稿，请先完成保存。');
        await api.logout(); logout();
      })}><LogOut size={16} />退出登录</button></div>
    </Modal>}
    {book.conflict && <Modal title="检测到版本冲突" close={() => book.setConflict(null)}>
      <div className="conflict-summary"><strong>{book.conflict.local.title || '未命名笔记'}</strong><span>本机修订 {book.conflict.local.revision} / 云端修订 {book.conflict.remote?.revision ?? '不可用'}</span></div>
      <div className="dialog-actions"><button onClick={() => book.setConflict(null)}>稍后处理</button><button className="primary" onClick={() => void run(book.conflictCopy)}>另存冲突副本</button></div>
    </Modal>}
    {versionList && versionNoteId === note?.id && <Modal title="历史版本" close={() => { setVersionList(null); setChosenVersion(null); }}>
      <div className="version-list">{versionList.map((version) => <button key={version.revision} className={chosenVersion?.revision === version.revision ? 'selected' : ''} onClick={() => setChosenVersion(version)}><span>修订 {version.revision}</span><time>{new Date(version.savedAt).toLocaleString('zh-CN')}</time></button>)}</div>
      {chosenVersion && <><div className="version-preview"><h3>{chosenVersion.title}</h3><Preview content={chosenVersion.content} onImage={setLightbox} /></div><div className="dialog-actions"><button className="primary" disabled={disabled || !!note?.deletedAt} onClick={() => {
        setNoteFields({ title: chosenVersion.title, content: chosenVersion.content, tags: chosenVersion.tags, pinned: chosenVersion.pinned });
        setVersionList(null); setChosenVersion(null); setLayout('edit');
      }}><RotateCcw size={15} />恢复此版本</button></div></>}
    </Modal>}
    {confirmAction && <Modal title={confirmAction === 'purge' ? '永久删除这篇笔记？' : '移入回收站？'} close={() => setConfirmAction(null)}>
      <div className="confirm-title">{note?.title || '未命名笔记'}</div>
      <div className="dialog-actions"><button onClick={() => setConfirmAction(null)}>取消</button><button className={confirmAction === 'purge' ? 'danger' : 'primary'} onClick={() => void run(async () => {
        if (confirmAction === 'purge') await book.purge();
        else setNoteFields({ deletedAt: Date.now() });
        setConfirmAction(null);
      })}>{confirmAction === 'purge' ? '永久删除' : '移入回收站'}</button></div>
    </Modal>}
    {lightbox && <Modal title="图片" close={() => setLightbox('')}><img className="lightbox-image" src={lightbox} alt="笔记图片" /></Modal>}
  </div>;
}
