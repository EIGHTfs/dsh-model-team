// tim.tsx —— 竖版即时通讯风主题：**一个文件就是一套完整界面**（结构 + 视觉 + styles）。
//
// 默认主题：移动端 IM 风格（控件/尺寸/样式/内部动作用见 docs/03 §7）。
// 演示外壳部分不做：手机边框、顶部状态栏（时间/信号/电池）、
// 硬编码假数据（固定时间 / 未读数 / 「已连接 3 个网关」）、外部 CDN 与框架指令。
// 数据全部来自 ui/theme-sdk 的 hooks；样式是本文件里的纯 CSS 字符串。
//
// 与 classic 的差异必须在 5 处以上肉眼可辨（docs/25 §十一 对照表）：
//   ① 主色 #12B7F5（比 classic 的 #12a7f5 更亮）② 群聊顶栏蓝底白字 ③ 聊天区点阵背景
//   ④ 气泡带三角尾巴 ⑤ 列表头像 52px ⑥ 底栏 56px ⑦ 面板标题条深色。
//
// 行为逻辑（拖动、夹取、象限、列表三态、summary 判空、tab 映射）全在 ui/theme-sdk —— 这里只画。

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  actions,
  buildListItemView,
  buildPanelFields,
  clampDockPosition,
  computeOpenDir,
  computePanelPosition,
  defaultAnchor,
  defineTheme,
  filterGroups,
  formatSessionLine,
  formatTargetLabel,
  measureSize,
  readViewSize,
  resolveCountText,
  resolveListStatus,
  shouldStartDrag,
  tabKeyOf,
  targetSourceHint,
  TAB_ITEMS,
  useChat,
  useDockState,
  useDrivers,
  useGroupOptions,
  useAddForm,
  useFriendGroups,
  buildAvatarView,
  nextAvatarView,
  credentialFieldsOf,
  driverDisplayName,
  isAccountAuthDriver,
  useGroups,
  useGroupsError,
  useSession,
  useStats,
  useTarget,
  useView,
  BALL_FALLBACK_SIZE_PX,
  PANEL_FALLBACK_SIZE,
  type Point,
  type Size,
} from '../theme-sdk/index';

// ---------------------------------------------------------------- 小件

// 头像：四级回退（图片 → 下一个图片 → 文本 → 首字符），与宿主的 avatar-chain.js 同一份规则。
// 失败换候选靠 React 的 onError 就地更新（不整页重建，也不留裂图）。
function Avatar({ avatar, fallbackName, size = 'sm' }: { avatar: unknown; fallbackName: unknown; size?: 'sm' | 'lg' }) {
  const className = size === 'lg' ? 'tim-avatar tim-avatar-lg' : 'tim-avatar';
  const [view, setView] = useState(() => buildAvatarView(avatar, fallbackName));
  if (view.kind === 'image') {
    return (
      <span className={className}>
        <img
          src={view.src}
          alt=""
          loading="lazy"
          onError={() => setView(nextAvatarView(view.rest, view.fallbackText))}
        />
      </span>
    );
  }
  return <span className={className}>{view.text || view.fallbackText}</span>;
}

/** 请求卡片的指标行：允许折行（docs/25 要求「指标允许折两行」），用 | 分隔 */
function MetricsLine({ row }: { row: Record<string, unknown> }) {
  const text = (value: unknown) => (value == null || value === '' ? '—' : String(value));
  const metrics = [
    { key: 'latency', text: `⏱️ ${text(row.latency)}` },
    { key: 'tokens', text: `🔤 ${text(row.tokens)}` },
    { key: 'credit', text: `💳 ${text(row.credit)}` },
    { key: 'cacheHit', text: `🎯 ${text(row.cacheHit)}` },
  ];
  return (
    <div className="tim-metrics">
      <span className={Number(row.status) >= 200 && Number(row.status) < 300 ? 'tim-status-ok' : 'tim-status-bad'}>{text(row.statusText)}</span>
      {metrics.map((metric) => (
        <span key={metric.key} className="tim-metric"><span className="tim-sep">|</span>{metric.text}</span>
      ))}
    </div>
  );
}

// 底栏三个图标：同一套内联 SVG（同 viewBox、同尺寸、同描边粗细），选中态由 currentColor 决定
const TAB_ICON_PROPS = { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true } as const;

const ChatIcon = () => (
  <svg {...TAB_ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
);
const ContactsIcon = () => (
  <svg {...TAB_ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16.5 3.13a4 4 0 0 1 0 7.75" /></svg>
);
const ProfileIcon = () => (
  <svg {...TAB_ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /></svg>
);

// ---------------------------------------------------------------- 群聊页

function ChatPage({ groupId, onHide }: { groupId: string; onHide: () => void }) {
  const groups = useGroups() as Array<{ id: string; name: string; avatar?: unknown }>;
  const chat = useChat(groupId) as { messages?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>>; modelsStatus?: string };
  const friendGroups = useFriendGroups() as Array<{ id?: unknown; name?: unknown }>;
  const [draft, setDraft] = useState('');
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [mentionOpen, setMentionOpen] = useState(false);

  const group = groups.find((item) => item.id === groupId);
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const models = Array.isArray(chat.models) ? chat.models : [];
  // 群友数三态：未知 —、已加载 N、失败「加载失败」（D-3）
  const memberCountText = chat.modelsStatus === 'error' ? '加载失败' : chat.modelsStatus === 'undefined' || chat.modelsStatus === undefined || chat.modelsStatus === 'loading' ? '—' : String(models.length);

  return (
    <section className="tim-view tim-chat" data-view="chat">
      <header className="tim-chat-head">
        <button type="button" className="tim-back" onClick={() => actions.openView('list')} aria-label="返回">&lt;</button>
        <span className="tim-chat-title">{group ? group.name : ''}</span>
        <span className="tim-badge">群友: {memberCountText}</span>
        <WindowHideButton onHide={onHide} />
      </header>

      <div className="tim-stream tim-chat-bg">
        {messages.length === 0 ? <div className="tim-empty-inline">还没有请求记录</div> : null}
        {messages.map((message, index) => {
          const type = String(message.type || '');
          if (type === 'sys') {
            return <div key={index} className="tim-row-center"><span className="tim-sys">{String(message.text || '')}</span></div>;
          }
          if (type === 'row') {
            const row = (message.row || {}) as Record<string, unknown>;
            const rowIndex = Number(message.rowIndex ?? index);
            const expanded = Boolean(expandedRows[rowIndex]);
            return (
              <div key={index} className="tim-row-left">
                <div className="tim-card tim-bubble-left" onClick={() => setExpandedRows((previous) => ({ ...previous, [rowIndex]: !previous[rowIndex] }))}>
                  <div className="tim-card-head">
                    <Avatar avatar={null} fallbackName={String(row.model || '?')} />
                    <span className="tim-card-model">{String(row.model || '—')}</span>
                    <span className="tim-card-time">{String(row.time || '')}</span>
                  </div>
                  <MetricsLine row={row} />
                  {expanded ? (
                    <div className="tim-card-detail">
                      {row.claimedReason ? <div><span className="tim-k">模型</span><span>{String(row.claimedReason)}</span></div> : null}
                      {row.targetSource ? <div><span className="tim-k">来源</span><span>{String(row.targetSource)}{targetSourceHint(row.targetSource)}</span></div> : null}
                      <div><span className="tim-k">账号</span><span>{String((row.account as { name?: string })?.name || '—')}</span></div>
                      <div><span className="tim-k">req-id</span><span>{String(row.requestId || '—')}</span></div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          }
          return (
            <div key={index} className="tim-row-right">
              <div className="tim-bubble tim-bubble-right">{String(message.text || '')}</div>
            </div>
          );
        })}
      </div>

      {mentionOpen ? (
        <div className="tim-mention">
          <div className="tim-mention-head">
            <span>选择切换目标</span>
            <button type="button" className="tim-mention-close" onClick={() => setMentionOpen(false)}>关闭</button>
          </div>
          <div className="tim-mention-body">
            <div className="tim-mention-section">本群群友（单模型）</div>
            {models.length === 0 ? <div className="tim-mention-empty">没有群友</div> : null}
            {models.map((model) => (
              <button key={String(model.id)} type="button" className="tim-mention-item" onClick={() => { actions.switchTarget({ type: 'model', id: String(model.id), platformId: groupId }); setMentionOpen(false); }}>
                <Avatar avatar={model.avatar} fallbackName={model.name || model.id} />
                <span>{String(model.name || model.id)}</span>
              </button>
            ))}
            <div className="tim-mention-section">我的好友分组（轮换）</div>
            {friendGroups.length === 0 ? <div className="tim-mention-empty">还没有分组</div> : null}
            {friendGroups.map((friendGroup) => (
              <button key={String(friendGroup.id)} type="button" className="tim-mention-item" onClick={() => { actions.switchTarget({ type: 'group', id: String(friendGroup.id) }); setMentionOpen(false); }}>
                <span className="tim-avatar tim-avatar-group">👥</span>
                <span>{String(friendGroup.name || friendGroup.id)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <footer className="tim-input-bar">
        <button type="button" className="tim-at" onClick={() => setMentionOpen((open) => !open)} aria-label="选择群友">@</button>
        <input
          className="tim-input"
          type="text"
          value={draft}
          placeholder="输入 @ 选择群友或分组…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim()) {
              actions.sendMessage(draft.trim());
              setDraft('');
            }
          }}
        />
        <button type="button" className="tim-send" onClick={() => { if (draft.trim()) { actions.sendMessage(draft.trim()); setDraft(''); } }}>发送</button>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------- 消息列表

/** 顶部「—」：只收起主窗口（回到悬浮球），不销毁、不退订；再点球展开 */
function WindowHideButton({ onHide }: { onHide: () => void }) {
  return (
    <button type="button" className="tim-window-hide" data-window-hide onClick={onHide} aria-label="收起窗口" title="收起窗口">—</button>
  );
}

function ListPage({ onHide }: { onHide: () => void }) {
  const groups = useGroups() as Array<{ id?: unknown; name?: unknown; avatar?: unknown; summary?: unknown; driver?: unknown; lastUpdated?: unknown }>;
  const loadError = useGroupsError();
  const view = useView();
  const [keyword, setKeyword] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const visibleGroups = filterGroups(groups, keyword);
  const status = resolveListStatus(groups, loadError);

  return (
    <section className="tim-view tim-list" data-view="list">
      <div className="tim-list-head">
        <h1 className="tim-page-title">消息</h1>
        <WindowHideButton onHide={onHide} />
        <div className="tim-add-wrap">
          <button type="button" className="tim-add" onClick={() => setAddMenuOpen((open) => !open)} aria-label="加群">+</button>
          {addMenuOpen ? (
            <div className="tim-add-menu">
              <button type="button" onClick={() => { setAddMenuOpen(false); actions.openView('add'); }}>👤+ 登录平台账号</button>
              <button type="button" onClick={() => { setAddMenuOpen(false); actions.openView('contacts'); }}>💬 创建轮换分组</button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="tim-search-wrap">
        <input className="tim-search" type="search" value={keyword} placeholder="🔍 搜索" onChange={(event) => setKeyword(event.target.value)} />
      </div>

      {/* 「已连接 N 个网关」：句式保留，数字取真实条数（契约 03 §九） */}
      <div className="tim-list-meta-line">💻 {status === 'load-failed' ? '加载失败' : `已连接 ${groups.length} 个网关`}</div>

      {status === 'load-failed' ? (
        <div className="tim-list-error" role="alert">
          <div className="tim-list-error-title">群列表加载失败</div>
          <div className="tim-list-error-detail">{loadError}</div>
          <button type="button" className="tim-retry" onClick={() => actions.loadGroups()}>点此重试</button>
        </div>
      ) : null}

      {status === 'empty' ? <div className="tim-empty-inline">还没有群，点右上角「+」接入一个平台</div> : null}

      <div className="tim-list-body">
        {status === 'loaded' ? visibleGroups.map((group) => {
          const groupId = group.id == null ? '' : String(group.id);
          const item = buildListItemView(group, view.currentGroupId, () => actions.openView('chat', groupId));
          return (
            <button key={groupId} type="button" className="tim-list-item" onClick={item.onClick}>
              <Avatar avatar={item.avatar} fallbackName={item.title} size="lg" />
              <span className="tim-list-main">
                <span className="tim-list-line">
                  <span className="tim-list-name">{item.title}</span>
                  {item.meta ? <span className="tim-list-time">{item.meta}</span> : null}
                </span>
                {item.subtitle ? <span className="tim-list-summary">{item.subtitle}</span> : null}
              </span>
            </button>
          );
        }) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 加群（P4）

/** 登录轮询间隔：设备码协议**只能轮询**（上游没有推送通道），这不是"等状态变化"的偷懒写法 */
const LOGIN_POLL_INTERVAL_MS = 1000;
// 登录状态查询连续失败上限：到上限就明确失败（事件驱动纪律：不许用无限重试掩盖"事件不来"）
const LOGIN_POLL_MAX_CONSECUTIVE_FAILURES = 3;

interface DriverLike {
  id?: unknown;
  name?: unknown;
  platformId?: unknown;
}

interface AccountLike { accountId?: unknown; nickname?: unknown }


/** 通用下拉（自绘）：触发器 + 浮层列表。
 * 为什么不用浏览器原生下拉控件：浮层由系统绘制，样式与 tokens 不一致；选中态/键盘焦点不可控，
 * 也无法给每一项加 data-* 标记供门禁与真机验收定位。
 * 数据面完全不变：选项是 {id,label} 投影，选中只调一个回调（值仍由宿主持有）。
 * 控件留在主题里（不进 theme-sdk）：SDK 只放数据与动作，绘制属于主题。 */
function Picker({ triggerId, pickerName, labelId, options, selectedId, onPick, placeholder, disabled }: {
  triggerId?: string;
  pickerName: string;
  labelId?: string;
  options: Array<{ id: string; label: string }>;
  selectedId: string;
  onPick: (optionId: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listboxId = 'timPickerListbox-' + pickerName;
  const selectedOption = options.find((option) => option.id === selectedId) || null;

  // 点击外部 / Esc 关闭：只在打开时挂监听，关闭即摘（不留常驻全局监听）
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // 打开时把高亮落在当前选中项（没有则第一项），并把焦点交给列表
  useEffect(() => {
    if (!open) return;
    const currentIndex = options.findIndex((option) => option.id === selectedId);
    setActiveIndex(currentIndex >= 0 ? currentIndex : (options.length > 0 ? 0 : -1));
    if (listRef.current) listRef.current.focus();
  }, [open, options, selectedId]);

  const commit = (optionId: string) => {
    setOpen(false);
    onPick(optionId);
    if (triggerRef.current) triggerRef.current.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar' || event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); if (triggerRef.current) triggerRef.current.focus(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((previous) => Math.min(previous + 1, options.length - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((previous) => Math.max(previous - 1, 0)); return; }
    if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0); return; }
    if (event.key === 'End') { event.preventDefault(); setActiveIndex(options.length - 1); return; }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      const activeOption = options[activeIndex];
      if (activeOption) commit(activeOption.id);
    }
  };

  return (
    <div className="tim-picker" ref={rootRef} data-picker={pickerName}>
      <button
        type="button"
        ref={triggerRef}
        id={triggerId || ('timPickerTrigger-' + pickerName)}
        className="tim-form-input tim-picker-trigger"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={labelId ? labelId + ' ' + (triggerId || ('timPickerTrigger-' + pickerName)) : undefined}
        data-picker-trigger
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={selectedOption ? 'tim-picker-value' : 'tim-picker-placeholder'}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <span className="tim-picker-arrow" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          className="tim-picker-list"
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId || undefined}
          tabIndex={-1}
          ref={listRef}
          onKeyDown={onListKeyDown}
          data-picker-list
        >
          {options.map((option, index) => (
            <li
              key={option.id || '__empty__'}
              role="option"
              aria-selected={option.id === selectedId}
              data-option-id={option.id}
              data-active={index === activeIndex ? 'true' : 'false'}
              className={option.id === selectedId ? 'tim-picker-option is-selected' : 'tim-picker-option'}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(option.id)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AddPage({ onHide }: { onHide: () => void }) {
  const drivers = useDrivers() as DriverLike[];
  // 下拉选项与表单值都来自宿主：选项是纯投影（只有 id/label），值是 state.addForm。
  // 主题不认识"接口地址 / 模型目录路径 / 驱动标识"这些字段——它们只在 store/add-form.js 里出现。
  const groupOptions = useGroupOptions();
  const addForm = useAddForm();
  const driverKey = addForm.driverKey;
  const values = addForm.values;
  const [groupName, setGroupName] = useState('');
  const [accounts, setAccounts] = useState<AccountLike[]>([]);
  const [accountId, setAccountId] = useState('');
  const [loginState, setLoginState] = useState<'idle' | 'starting' | 'waiting' | 'failed'>('idle');
  const [loginNote, setLoginNote] = useState('');
  const [models, setModels] = useState<Array<{ id?: unknown; name?: unknown }>>([]);
  const [probeError, setProbeError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const driver = drivers.find((candidate) => String(candidate.id || '') === driverKey) || null;
  const driverName = driverDisplayName(driver);
  const platformId = driver && driver.platformId ? String(driver.platformId) : '';
  const accountDriver = isAccountAuthDriver(driver);
  const credentialFields = credentialFieldsOf(driver);

  // 切平台：账号区与模型目录都要重置（上一家的账号/模型不能带过来）；
  // 表单值由宿主按选项展开（预置项带平台默认值，驱动项为空）
  const selectDriver = (nextOptionId: string) => {
    actions.selectGroupOption(nextOptionId);
    setAccounts([]);
    setAccountId('');
    setLoginState('idle');
    setLoginNote('');
    setModels([]);
    setProbeError('');
    setSubmitError('');
  };

  const refreshAccounts = (nextPlatformId: string) => Promise.resolve(actions.loadReverseAccounts(nextPlatformId) as Promise<AccountLike[]>)
    .then((list) => {
      const safeList = Array.isArray(list) ? list : [];
      setAccounts(safeList);
      setAccountId(safeList.length > 0 ? String(safeList[0].accountId || '') : '');
      return safeList;
    })
    .catch(() => { setAccounts([]); return []; });

  // 登录：一次点击 → 立刻开授权页 → 轮询；**只更新账号区**，表单其余字段（名称/凭证）不动
  const startLogin = () => {
    if (!platformId || loginState === 'starting' || loginState === 'waiting') return;
    setLoginState('starting');
    setLoginNote('正在打开授权页…');
    Promise.resolve(actions.startReverseLogin(platformId) as Promise<{ loginUrl?: string }>)
      .then((started) => {
        const loginUrl = started && started.loginUrl ? String(started.loginUrl) : '';
        if (!loginUrl) {
          setLoginState('failed');
          const serverMessage = started && (started as { error?: { message?: string } }).error
            ? String((started as { error?: { message?: string } }).error?.message || '')
            : '';
          setLoginNote(serverMessage
            ? `无法发起登录：${serverMessage}`
            : `无法发起登录：服务端没有返回授权地址（平台 id=${platformId || '(空)'}）`);
          return;
        }
        // 同一段异步续体里开窗：离用户手势还近，浏览器才允许弹窗
        let opened: Window | null = null;
        try { opened = window.open(loginUrl, '_blank', 'width=800,height=620'); } catch { opened = null; }
        setLoginState('waiting');
        setLoginNote(opened && !opened.closed ? '等待授权…（浏览器里完成登录后会自动刷新）' : '浏览器拦截了弹窗，请允许弹窗后重试');
      })
      .catch((error: Error) => { setLoginState('failed'); setLoginNote('无法发起登录：' + (error && error.message ? error.message : '未知原因')); });
  };

  // 等待授权：按平台轮询（协议只能轮询）。成功即刷新账号并自动选中，失败给具体原因
  useEffect(() => {
    if (loginState !== 'waiting' || !platformId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    const pollOnce = () => {
      Promise.resolve(actions.pollReverseLogin(platformId) as Promise<{ ok?: boolean; status?: number; body?: { status?: string; account?: AccountLike } }>)
        .then((result) => {
          if (cancelled) return;
          const body = result && result.body ? result.body : null;
          if (result && result.ok && body && body.status === 'pending') { timer = setTimeout(pollOnce, LOGIN_POLL_INTERVAL_MS); return; }
          if (result && result.ok && body && body.status === 'granted') {
            const granted = body.account || {};
            setLoginState('idle');
            setLoginNote('已登录：' + String(granted.nickname || granted.accountId || '账号已保存'));
            refreshAccounts(platformId).then((list) => {
              if (granted.accountId) setAccountId(String(granted.accountId));
              if (list.length === 0) setLoginNote('登录成功但账号列表为空，请重试');
            });
            return;
          }
          if (result && result.ok && body && body.status === 'expired') { setLoginState('failed'); setLoginNote('授权已超时，请重新登录'); return; }
          if (result && result.status === 404) { setLoginState('failed'); setLoginNote('登录会话已失效，请重新登录'); return; }
          if (result && typeof result.status === 'number' && result.status >= 500) { setLoginState('failed'); setLoginNote('登录服务异常（HTTP ' + result.status + '）'); return; }
          setLoginState('failed');
          setLoginNote('登录服务异常，请稍后重试');
        })
        .catch((error: Error) => {
          if (cancelled) return;
          // 网络/服务错误**不能**静默无限重试（那是把"事件永远不来"掩盖成"慢一点"）：
          // 连续 3 次失败就明确失败并把原因显示出来，用户可重试。
          consecutiveFailures += 1;
          if (consecutiveFailures >= LOGIN_POLL_MAX_CONSECUTIVE_FAILURES) {
            setLoginState('failed');
            setLoginNote('登录状态查询连续失败：' + (error && error.message ? error.message : '未知原因'));
            return;
          }
          timer = setTimeout(pollOnce, LOGIN_POLL_INTERVAL_MS);
        });
    };
    pollOnce();
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
  }, [loginState, platformId]);

  const runProbe = () => {
    setProbeError('');
    if (accountDriver && (!platformId || !accountId)) { setProbeError('尚未登录 ' + driverName); return; }
    // 请求体（地址 / 密钥 / 账号引用 / 目录路径）由宿主组装，主题只表达"探测"这个意图
    Promise.resolve(actions.probeAddForm({ accountId }) as Promise<{ models?: Array<{ id?: unknown; name?: unknown }>; error?: { message?: string } }>)
      .then((result) => {
        if (result && Array.isArray(result.models)) { setModels(result.models); return; }
        // 失败文案只用服务端给的 message，不自己编
        setModels([]);
        setProbeError(result && result.error && result.error.message ? String(result.error.message) : '获取失败，请稍后重试');
      })
      .catch((error: Error) => setProbeError(error && error.message ? error.message : '获取失败，请稍后重试'));
  };

  const canSubmit = Boolean(driver) && groupName.trim().length > 0 && !submitting && (!accountDriver || Boolean(accountId));

  const submit = () => {
    if (!canSubmit || !driver) return;
    setSubmitting(true);
    setSubmitError('');
    // 加群 payload（驱动 / 地址 / 鉴权 / 目录入口）由宿主组装，主题只给名称与已探测的模型
    Promise.resolve(actions.submitAddGroup({ name: groupName.trim(), models, accountId }) as Promise<unknown>)
      .then(() => { setSubmitting(false); actions.loadGroups(); actions.openView('list'); })
      .catch((error: Error) => { setSubmitting(false); setSubmitError(error && error.message ? error.message : '添加失败，请稍后重试'); });
  };

  return (
    <section className="tim-view tim-addpage" data-view="add" data-add-state={driver ? 'ready' : 'no-platform'}>
      <div className="tim-list-head tim-list-head-inline">
        <button type="button" className="tim-back" onClick={() => actions.openView('list')} aria-label="返回">‹</button>
        <h1 className="tim-page-title">加群</h1>
        <WindowHideButton onHide={onHide} />
      </div>

      <div className="tim-form-body">
        <label className="tim-form-label" id="timPlatformLabel">选平台</label>
        {/* 自绘下拉（原生控件的浮层由系统绘制，样式/键盘/选中态都不可控） */}
        <Picker
          pickerName="platform"
          triggerId="timDriverSelect"
          labelId="timPlatformLabel"
          options={groupOptions}
          selectedId={addForm.optionId}
          onPick={selectDriver}
          placeholder="请选择"
        />

        {!driver ? <div className="tim-empty-inline" data-add-hint="no-platform">先选平台</div> : null}

        {driver ? (
          <>
            <label className="tim-form-label" htmlFor="timGroupName">群名称</label>
            <input
              id="timGroupName"
              className="tim-form-input"
              type="text"
              value={groupName}
              placeholder="例如：我的账号"
              onChange={(event) => setGroupName(event.target.value)}
            />

            {accountDriver ? (
              <div className="tim-form-section" data-account-state={accounts.length > 0 ? 'ready' : 'none'}>
                <label className="tim-form-label" id="timAccountLabel">账号</label>
                <Picker
                  pickerName="account"
                  triggerId="timAccountSelect"
                  labelId="timAccountLabel"
                  options={accounts.length === 0
                    ? [{ id: '', label: '（尚无账号）' }]
                    : accounts.map((account) => ({
                      id: String(account.accountId || ''),
                      label: String(account.nickname || account.accountId || ''),
                    }))}
                  selectedId={accountId}
                  onPick={setAccountId}
                  placeholder="（尚无账号）"
                />
                <button type="button" className="tim-form-primary" onClick={startLogin} disabled={loginState === 'starting' || loginState === 'waiting'}>
                  {loginState === 'starting' ? '正在打开授权页…' : loginState === 'waiting' ? '等待授权…' : '登录 ' + driverName}
                </button>
                {loginNote ? <div className="tim-form-note" data-login-note>{loginNote}</div> : null}
                {accounts.length === 0 && loginState === 'idle' ? (
                  <div className="tim-empty-inline" data-add-hint="not-logged-in">尚未登录 {driverName}</div>
                ) : null}
              </div>
            ) : (
              <div className="tim-form-section">
                {credentialFields.map((field) => {
                  const fieldKey = String(field.key || '');
                  const fieldType = String(field.type || 'text');
                  const fieldValue = values[fieldKey] || '';
                  const setFieldValue = (nextValue: string) => actions.setAddFormValue(fieldKey, nextValue);
                  // 条件字段（如「手动填写」才出现的模型名）：条件不满足就不渲染
                  const condition = field.showWhen as { key?: unknown; value?: unknown } | undefined;
                  if (condition && String(values[String(condition.key || '')] || '') !== String(condition.value || '')) return null;
                  const label = String(field.label || fieldKey);
                  if (fieldType === 'select') {
                    const options = Array.isArray(field.options) ? field.options as Array<{ value?: unknown; label?: unknown }> : [];
                    return (
                      <div key={fieldKey} className="tim-form-field">
                        <label className="tim-form-label" id={'timFieldLabel-' + fieldKey}>{label}</label>
                        <Picker
                          pickerName={'field-' + fieldKey}
                          triggerId={'timField-' + fieldKey}
                          labelId={'timFieldLabel-' + fieldKey}
                          options={options.map((option) => ({
                            id: String(option.value || ''),
                            label: String(option.label || option.value || ''),
                          }))}
                          selectedId={fieldValue}
                          onPick={setFieldValue}
                          placeholder="请选择"
                        />
                      </div>
                    );
                  }
                  if (fieldType === 'textarea') {
                    return (
                      <div key={fieldKey} className="tim-form-field">
                        <label className="tim-form-label" id={'timFieldLabel-' + fieldKey}>{label}</label>
                        <textarea
                          id={'timField-' + fieldKey}
                          className="tim-form-textarea"
                          placeholder={field.placeholder ? String(field.placeholder) : ''}
                          value={fieldValue}
                          onChange={(event) => setFieldValue(event.target.value)}
                        />
                      </div>
                    );
                  }
                  return (
                    <div key={fieldKey} className="tim-form-field">
                      <label className="tim-form-label" id={'timFieldLabel-' + fieldKey}>{label}</label>
                      <input
                        id={'timField-' + fieldKey}
                        className="tim-form-input"
                        type={fieldType === 'password' ? 'password' : 'text'}
                        placeholder={field.placeholder ? String(field.placeholder) : ''}
                        value={fieldValue}
                        onChange={(event) => setFieldValue(event.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* 高级字段由宿主决定是否出现（账号型平台没有这一项）：主题只按 key/label/placeholder 渲染 */}
            {addForm.advancedField ? (
              <div className="tim-form-field">
                <label className="tim-form-label" htmlFor={'timAdvanced-' + addForm.advancedField.key}>
                  {addForm.advancedField.label}
                </label>
                <input
                  id={'timAdvanced-' + addForm.advancedField.key}
                  className="tim-form-input"
                  type="text"
                  placeholder={addForm.advancedField.placeholder}
                  value={values[addForm.advancedField.key] || ''}
                  onChange={(event) => actions.setAddFormValue(addForm.advancedField!.key, event.target.value)}
                />
              </div>
            ) : null}

            <div className="tim-form-row">
              <button type="button" className="tim-form-ghost" onClick={runProbe}>获取可用模型</button>
              {models.length > 0 ? <span className="tim-form-note" data-model-count>{models.length} 个模型</span> : null}
            </div>
            {probeError ? <div className="tim-form-error" data-probe-error>{probeError}</div> : null}
            {models.length > 0 ? (
              <ul className="tim-form-models">
                {models.map((model, index) => (
                  <li key={String(model.id || index)} className="tim-form-model">{String(model.name || model.id || '')}</li>
                ))}
              </ul>
            ) : null}

            <button type="button" className="tim-form-primary" onClick={submit} disabled={!canSubmit}>
              {submitting ? '提交中…' : '校验并添加群'}
            </button>
            {submitError ? <div className="tim-form-error" data-submit-error>{submitError}</div> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 通讯录（好友 / 分组）

const STRATEGY_LABELS: Record<string, string> = { 'round-robin': '轮询', fallback: '故障转移' };
const STRATEGY_OPTIONS = [
  { value: 'round-robin', label: '轮询（依次轮换）' },
  { value: 'fallback', label: '故障转移（前面的失败再用下一个）' },
];

interface FriendGroupLike {
  id?: unknown;
  name?: unknown;
  strategy?: unknown;
  members?: Array<{ platformId?: unknown; modelId?: unknown }>;
}

interface GroupLike {
  id?: unknown;
  name?: unknown;
}

interface MemberDraft { platformId: string; modelId: string }

// 分组编辑面板：名称 / 策略 / 成员（平台 → 模型 两级选择）。
// 校验只做「非空 + 至少一个成员」——与 legacy 的必填口径一致，其余交给服务端。
function FriendGroupEditor({ group, groups, onClose, onSaved }: {
  group: FriendGroupLike | null;
  groups: GroupLike[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group ? String(group.name || '') : '');
  const [strategy, setStrategy] = useState(group ? String(group.strategy || 'round-robin') : 'round-robin');
  const [members, setMembers] = useState<MemberDraft[]>(() => (
    group && Array.isArray(group.members)
      ? group.members.map((member) => ({ platformId: String(member.platformId || ''), modelId: String(member.modelId || '') }))
      : []
  ));
  const [pickedPlatformId, setPickedPlatformId] = useState('');
  const [pickedModelId, setPickedModelId] = useState('');
  const [models, setModels] = useState<Array<{ id?: unknown; name?: unknown }>>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 选平台 → 拉该群的模型清单（两级选择的第二级数据来源）
  useEffect(() => {
    if (!pickedPlatformId) { setModels([]); setPickedModelId(''); return undefined; }
    let cancelled = false;
    Promise.resolve(actions.loadGroupModels(pickedPlatformId) as Promise<Array<{ id?: unknown; name?: unknown }>>)
      .then((list) => {
        if (cancelled) return;
        const safeList = Array.isArray(list) ? list : [];
        setModels(safeList);
        setPickedModelId(safeList.length > 0 ? String(safeList[0].id || '') : '');
      })
      .catch(() => { if (!cancelled) { setModels([]); setPickedModelId(''); } });
    return () => { cancelled = true; };
  }, [pickedPlatformId]);

  const addMember = () => {
    if (!pickedPlatformId || !pickedModelId) { setError('请先选择平台与模型'); return; }
    const duplicated = members.some((member) => member.platformId === pickedPlatformId && member.modelId === pickedModelId);
    if (duplicated) { setError('该成员已在列表里'); return; }
    setError('');
    setMembers((previous) => [...previous, { platformId: pickedPlatformId, modelId: pickedModelId }]);
  };

  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('请填写分组名称'); return; }
    if (members.length === 0) { setError('至少要有一个成员'); return; }
    setSaving(true);
    setError('');
    const payload: Record<string, unknown> = {
      name: trimmedName,
      strategy,
      members,
      ...(group && group.id ? { id: String(group.id) } : {}),
    };
    Promise.resolve(actions.saveFriendGroup(payload) as Promise<unknown>)
      .then(() => { setSaving(false); onSaved(); })
      .catch((saveError: Error) => { setSaving(false); setError(saveError && saveError.message ? saveError.message : '保存失败'); });
  };

  const groupNameOf = (platformId: string): string => {
    const matched = groups.find((candidate) => String(candidate.id || '') === platformId);
    return matched ? String(matched.name || platformId) : platformId;
  };

  return (
    <div className="tim-sheet" data-friend-editor={group && group.id ? 'edit' : 'create'}>
      <div className="tim-sheet-head">
        <span>{group ? '编辑分组' : '新建分组'}</span>
        <button type="button" className="tim-sheet-close" onClick={onClose}>关闭</button>
      </div>
      <div className="tim-sheet-body">
        <label className="tim-form-label" htmlFor="timFriendName">分组名称</label>
        <input id="timFriendName" className="tim-form-input" type="text" value={name} placeholder="例如：主力轮换" onChange={(event) => setName(event.target.value)} />

        <label className="tim-form-label" id="timFriendStrategyLabel">成员轮换策略</label>
        <Picker
          pickerName="friend-strategy"
          triggerId="timFriendStrategy"
          labelId="timFriendStrategyLabel"
          options={STRATEGY_OPTIONS.map((option) => ({ id: String(option.value), label: String(option.label) }))}
          selectedId={strategy}
          onPick={setStrategy}
          placeholder="请选择策略"
        />

        <label className="tim-form-label" id="timFriendPlatformLabel">成员（平台 → 模型）</label>
        <Picker
          pickerName="friend-platform"
          triggerId="timFriendPlatform"
          labelId="timFriendPlatformLabel"
          options={[{ id: '', label: '选择平台账号' }].concat(groups.map((candidate) => ({
            id: String(candidate.id || ''),
            label: String(candidate.name || candidate.id || ''),
          })))}
          selectedId={pickedPlatformId}
          onPick={setPickedPlatformId}
          placeholder="选择平台账号"
        />
        <Picker
          pickerName="friend-model"
          triggerId="timFriendModel"
          labelId="timFriendModelLabel"
          options={models.length === 0
            ? [{ id: '', label: '（先选平台账号）' }]
            : models.map((model) => ({ id: String(model.id || ''), label: String(model.name || model.id || '') }))}
          selectedId={pickedModelId}
          onPick={setPickedModelId}
          placeholder="选择模型"
          disabled={models.length === 0}
        />
        <span id="timFriendModelLabel" hidden>选择模型</span>
        <button type="button" className="tim-form-ghost" onClick={addMember}>添加到成员列表</button>

        <ul className="tim-member-list">
          {members.map((member, index) => (
            <li key={member.platformId + '::' + member.modelId} className="tim-member-item" data-member-row={index}>
              <span className="tim-member-name">{groupNameOf(member.platformId)} · {member.modelId}</span>
              <button
                type="button"
                className="tim-member-remove"
                onClick={() => setMembers((previous) => previous.filter((_candidate, candidateIndex) => candidateIndex !== index))}
              >
                移除
              </button>
            </li>
          ))}
          {members.length === 0 ? <li className="tim-member-empty">还没有成员</li> : null}
        </ul>

        {error ? <div className="tim-form-error" data-friend-error>{error}</div> : null}
        <button type="button" className="tim-form-primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存分组'}</button>
      </div>
    </div>
  );
}

function ContactsPage({ onHide }: { onHide: () => void }) {
  const groups = useGroups() as GroupLike[];
  const friendGroups = useFriendGroups() as FriendGroupLike[];
  const [activeTab, setActiveTab] = useState<'friends' | 'groups'>('friends');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<{ group: FriendGroupLike | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FriendGroupLike | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const reload = () => { setEditor(null); setPendingDelete(null); actions.loadGroups(); };

  return (
    <section className="tim-view tim-contacts" data-view="contacts" data-contacts-tab={activeTab}>
      <div className="tim-list-head"><h1 className="tim-page-title">联系人</h1><WindowHideButton onHide={onHide} /></div>
      {/* 只有两个分类：好友（按平台账号聚合）与分组（轮换分组）——其它分类我们没有对应概念，不放死标签 */}
      <div className="tim-contact-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'friends'} className={activeTab === 'friends' ? 'tim-contact-tab tim-contact-tab-active' : 'tim-contact-tab'} onClick={() => setActiveTab('friends')}>
          好友
          {activeTab === 'friends' ? <span className="tim-contact-underline" aria-hidden="true" /> : null}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'groups'} className={activeTab === 'groups' ? 'tim-contact-tab tim-contact-tab-active' : 'tim-contact-tab'} onClick={() => setActiveTab('groups')}>
          分组
          {activeTab === 'groups' ? <span className="tim-contact-underline" aria-hidden="true" /> : null}
        </button>
      </div>

      {activeTab === 'friends' ? (
        <div className="tim-contacts-body" data-friends-state={groups.length > 0 ? 'ready' : 'empty'}>
          {groups.length === 0 ? <div className="tim-empty-inline" data-friends-empty>还没有接入的平台账号</div> : null}
          {groups.map((group) => (
            <div key={String(group.id)} className="tim-contact-group">
              <button type="button" className="tim-contact-head" onClick={() => actions.openView('chat', String(group.id))}>
                <Avatar avatar={null} fallbackName={group.name} size="lg" />
                <span className="tim-contact-name">{String(group.name || group.id || '')}</span>
                <span className="tim-contact-count">进入群聊</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="tim-contacts-body" data-groups-state={friendGroups.length > 0 ? 'ready' : 'empty'}>
          {friendGroups.length === 0 ? (
            <div className="tim-empty-inline" data-groups-empty>
              还没有分组
              <button type="button" className="tim-form-ghost tim-empty-action" onClick={() => setEditor({ group: null })}>新建分组</button>
            </div>
          ) : null}
          {friendGroups.map((friendGroup) => {
            const groupId = String(friendGroup.id || '');
            const isExpanded = Boolean(expanded[groupId]);
            const members = Array.isArray(friendGroup.members) ? friendGroup.members : [];
            return (
              <div key={groupId} className="tim-contact-group" data-friend-group={groupId}>
                <div className="tim-contact-row">
                  <button type="button" className="tim-contact-head" onClick={() => setExpanded((previous) => ({ ...previous, [groupId]: !previous[groupId] }))}>
                    <span className={isExpanded ? 'tim-arrow tim-arrow-expanded' : 'tim-arrow'}>›</span>
                    <span className="tim-contact-name">{String(friendGroup.name || groupId)}</span>
                    <span className="tim-contact-strategy">（{STRATEGY_LABELS[String(friendGroup.strategy || '')] || '轮询'}）</span>
                    <span className="tim-contact-count" data-member-count={members.length}>{members.length} 个成员</span>
                  </button>
                  <button type="button" className="tim-contact-edit" data-contact-edit={groupId} onClick={() => setEditor({ group: friendGroup })}>编辑</button>
                  <button type="button" className="tim-contact-edit" data-contact-delete={groupId} onClick={() => { setDeleteError(''); setPendingDelete(friendGroup); }}>删除</button>
                </div>
                {isExpanded ? (
                  <div className="tim-contact-items">
                    {members.length === 0 ? <div className="tim-contact-empty">暂无成员</div> : null}
                    {members.map((member, index) => (
                      <div key={index} className="tim-contact-item">
                        <Avatar avatar={null} fallbackName={String(member.modelId || '?')} />
                        <span>{String(member.modelId || '')}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {friendGroups.length > 0 ? (
            <button type="button" className="tim-form-ghost tim-groups-new" onClick={() => setEditor({ group: null })}>＋ 新建分组</button>
          ) : null}
        </div>
      )}

      {editor ? <FriendGroupEditor group={editor.group} groups={groups} onClose={() => setEditor(null)} onSaved={reload} /> : null}

      {pendingDelete ? (
        <div className="tim-confirm" data-delete-confirm={String(pendingDelete.id || '')}>
          <div className="tim-confirm-box">
            <div className="tim-confirm-title">删除分组「{String(pendingDelete.name || pendingDelete.id || '')}」？</div>
            <div className="tim-confirm-note">删除后不可恢复；被会话引用的分组会被服务端拒绝。</div>
            {deleteError ? <div className="tim-form-error" data-delete-error>{deleteError}</div> : null}
            <div className="tim-confirm-actions">
              <button type="button" className="tim-form-ghost" onClick={() => setPendingDelete(null)}>取消</button>
              <button
                type="button"
                className="tim-form-primary tim-confirm-danger"
                data-delete-confirm-ok
                onClick={() => {
                  Promise.resolve(actions.deleteFriendGroup(String(pendingDelete.id || '')) as Promise<unknown>)
                    .then(reload)
                    .catch((deleteFailure: Error) => setDeleteError(deleteFailure && deleteFailure.message ? deleteFailure.message : '删除失败'));
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 我 / 数据库页

function ProfilePage({ onHide }: { onHide: () => void }) {
  const groups = useGroups() as Array<{ id?: unknown; name?: unknown; driver?: unknown }>;
  const drivers = useDrivers() as DriverLike[];
  const [receipt, setReceipt] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  const driverNameOf = (driverKey: unknown): string => {
    const matched = drivers.find((candidate) => String(candidate.id || '') === String(driverKey || ''));
    return matched ? String(matched.name || matched.id || '') : '未登记驱动';
  };

  // 按平台（驱动展示名）分组：同一驱动的多个账号归到一组
  const platformSections = groups.reduce<Array<{ name: string; items: typeof groups }>>((sections, group) => {
    const name = driverNameOf(group.driver);
    const existing = sections.find((section) => section.name === name);
    if (existing) { existing.items.push(group); return sections; }
    sections.push({ name, items: [group] });
    return sections;
  }, []);

  // 导出：拿服务端备份对象 → 触发浏览器下载（文件名带时间戳，便于区分多次导出）
  const runExport = () => {
    setActionError('');
    setReceipt('');
    setBusy(true);
    Promise.resolve(actions.exportConfig() as Promise<unknown>)
      .then((backup) => {
        setBusy(false);
        if (!backup) { setActionError('导出失败：服务端没有返回内容'); return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = 'model-team-backup-' + stamp + '.json';
        anchor.click();
        URL.revokeObjectURL(objectUrl);
        setReceipt('已导出备份文件');
      })
      .catch((error: Error) => { setBusy(false); setActionError(error && error.message ? error.message : '导出失败'); });
  };

  // 导入（文本）：交服务端 → 只显示服务端回执里的数字（不自己算）；导入成功即视为该平台已登录
  const runImportText = (rawText: string) => {
    setActionError('');
    setReceipt('');
    let parsed: unknown;
    try { parsed = JSON.parse(rawText); } catch { setActionError('内容不是合法 JSON'); return; }
    setBusy(true);
    Promise.resolve(actions.importConfig(parsed as Record<string, unknown>) as Promise<{ imported?: number; updated?: number; rejected?: unknown[] }>)
      .then((result) => {
        setBusy(false);
        const imported = result && typeof result.imported === 'number' ? result.imported : 0;
        const updated = result && typeof result.updated === 'number' ? result.updated : 0;
        const rejected = result && Array.isArray(result.rejected) ? result.rejected.length : 0;
        setReceipt('导入完成：新增 ' + imported + ' 条，更新 ' + updated + ' 条，拒绝 ' + rejected + ' 条');
        setPasted('');
        actions.loadGroups();
      })
      .catch((error: Error) => { setBusy(false); setActionError(error && error.message ? error.message : '导入失败'); });
  };

  // 导入（文件）：读文本后走同一条路径
  const runImport = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => setActionError('读取文件失败');
    reader.onload = () => runImportText(String(reader.result || ''));
    reader.readAsText(file);
  };

  return (
    <section className="tim-view tim-profile" data-view="profile">
      <div className="tim-profile-head">
        <WindowHideButton onHide={onHide} />
        <span className="tim-profile-avatar">我</span>
        <div>
          <div className="tim-profile-title">我的模型团队</div>
          <div className="tim-profile-sub">当前已连接 {groups.length} 个平台</div>
        </div>
      </div>
      <div className="tim-profile-body">
        {/* 登录与导入是同一件事（导入即登录）：合成一个入口，点开再选"选文件"还是"粘贴" */}
        <button type="button" className="tim-profile-row" data-action="login-import" onClick={() => setImportOpen((open) => !open)} aria-expanded={importOpen}>
          <span>🔐 登录 / 导入账号配置（JSON）</span><span className="tim-chevron">{importOpen ? '⌄' : '>'}</span>
        </button>
        {importOpen ? (
          <div className="tim-import-panel" data-import-panel>
            <label className="tim-import-pick">
              <span>选择 JSON 文件</span>
              <input
                className="tim-profile-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => runImport(event.target.files && event.target.files[0] ? event.target.files[0] : null)}
              />
            </label>
            <textarea
              className="tim-form-textarea"
              placeholder="或把配置内容粘贴到这里"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
            />
            <button type="button" className="tim-form-primary" disabled={busy || !pasted.trim()} onClick={() => runImportText(pasted)}>导入粘贴的内容</button>
            <button type="button" className="tim-form-ghost" onClick={() => actions.openView('add')}>还没有配置？去登录页新增平台账号</button>
          </div>
        ) : null}
        <button type="button" className="tim-profile-row" data-action="export" onClick={runExport} disabled={busy}>
          <span>📤 导出当前配置</span><span className="tim-chevron">&gt;</span>
        </button>
        {receipt ? <div className="tim-form-note" data-import-receipt>{receipt}</div> : null}
        {actionError ? <div className="tim-form-error" data-profile-error>{actionError}</div> : null}

        <div className="tim-platform-title">已接入平台</div>
        <div className="tim-platform-list" data-platform-state={groups.length > 0 ? 'ready' : 'empty'}>
          {platformSections.map((section) => (
            <div key={section.name} className="tim-platform-section">
              <div className="tim-platform-group-name">{section.name}</div>
              {section.items.map((group) => (
                <div key={String(group.id)} className="tim-platform-item">
                  <Avatar avatar={null} fallbackName={group.name} />
                  <span className="tim-platform-name">{String(group.name || group.id)}</span>
                  <span className="tim-platform-badge">正常</span>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 ? <div className="tim-empty-inline" data-platform-empty>还没有接入任何平台</div> : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 底栏 + 主窗口

function TabBar() {
  const view = useView();
  const activeTab = tabKeyOf(view.view);
  const labels: Record<string, string> = { messages: '消息', contacts: '联系人', profile: '我的' };
  return (
    <nav className="tim-tabbar team-tabbar" role="tablist">
      {TAB_ITEMS.map((tab) => {
        const selected = tab.key === activeTab;
        return (
          <button key={tab.key} type="button" role="tab" className="tim-tab team-tab" data-view={tab.view} aria-selected={selected} onClick={() => actions.openView(tab.view as never)}>
            {tab.key === 'messages' ? <ChatIcon /> : tab.key === 'contacts' ? <ContactsIcon /> : <ProfileIcon />}
            <span className="tim-tab-label">{labels[tab.key] || tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// 主窗口根同时带 `team-app`：契约钩子（docs/03 §2.2），主题自有类名之外的稳定别名，供门禁/外部定位。
function MainWindow({ onHide, windowStyle, dragHandlers }: {
  onHide: () => void;
  windowStyle: { left?: number; top?: number; transform?: string };
  dragHandlers: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  };
}) {
  const view = useView();
  return (
    <div className="tim-app team-app tim-app-draggable" style={windowStyle} {...dragHandlers}>
      <div className="tim-app-body">
        {view.view === 'list' ? <ListPage onHide={onHide} /> : null}
        {view.view === 'chat' ? <ChatPage groupId={view.currentGroupId} onHide={onHide} /> : null}
        {view.view === 'contacts' ? <ContactsPage onHide={onHide} /> : null}
        {view.view === 'profile' ? <ProfilePage onHide={onHide} /> : null}
        {view.view === 'add' ? <AddPage onHide={onHide} /> : null}
        {view.view === 'db' ? <div className="tim-empty-inline">该页面将在下一阶段迁移</div> : null}
      </div>
      <TabBar />
    </div>
  );
}

// ---------------------------------------------------------------- L0 球 + L1 面板

function DockLayer({ windowHidden, onExpand }: { windowHidden: boolean; onExpand: () => void }) {
  const { snapshot, bridge } = useDockState();
  const [panelOpen, setPanelOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<Point | null>(null);
  const [ballElement, setBallElement] = useState<HTMLDivElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  // 拖动上下文用 ref 而不是 state：pointerdown 与 pointerup 可能在同一帧内到达，
  // 用 state 时 pointerup 读到的还是旧值（null），点击会被吞掉——这是真实可复现的「点不开」缺陷。
  const dragContextRef = useRef<{ startX: number; startY: number; left: number; top: number; panelWasOpen: boolean; moved: boolean } | null>(null);

  const groups = useGroups() as Array<{ id: string; name: string; avatar?: unknown }>;
  const friendGroups = useFriendGroups() as Array<{ id?: unknown; name?: unknown }>;
  const session = useSession();
  const target = useTarget();
  const stats = useStats() as { rate?: string; global?: { text?: string } };
  const view = useView();

  const activeGroup = groups.find((group) => group.id === view.currentGroupId);
  const sessionLine = formatSessionLine(session.sessionId, session.sessionTitle);
  const targetLabel = formatTargetLabel(target.effectiveTarget, friendGroups);
  const fields = useMemo(() => buildPanelFields({
    groupName: activeGroup ? activeGroup.name : '',
    sessionText: sessionLine.text,
    sessionTitle: sessionLine.title,
    targetLabel,
    targetSourceHintText: target.target ? '' : targetSourceHint(target.targetSource),
    rate: stats.rate,
    globalText: stats.global && stats.global.text,
  }), [activeGroup, sessionLine.text, sessionLine.title, targetLabel, target.target, target.targetSource, stats.rate, stats.global]);

  const ballSize = measureSize(ballElement, { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX });
  const viewSize = readViewSize();
  const anchor = snapshot && snapshot.anchor ? snapshot.anchor : defaultAnchor(ballSize, viewSize);
  const ballPosition = dragOffset || clampDockPosition(anchor.left, anchor.top, ballSize, viewSize);
  const openDir = snapshot ? snapshot.openDir : computeOpenDir({ ...ballPosition, ...ballSize }, viewSize);
  const panelPosition = computePanelPosition({ ...ballPosition, ...ballSize }, measureSize(panelElement, PANEL_FALLBACK_SIZE as Size), openDir, viewSize);

  // 球的显隐**只看判定**：当前会话选中的模型是我们的虚拟模型 → 必须显示；否则不显示。
  // 与"窗口是否收起""是否正在看面板"无关 —— 那两者是界面自身状态，不该改变准入判定。
  if (!snapshot || !snapshot.visible) return null;

  const platformName = activeGroup && typeof activeGroup.name === 'string' ? activeGroup.name : '';
  const accessibleLabel = platformName ? `${targetLabel} · ${platformName}` : targetLabel;

  const finishDrag = () => {
    const context = dragContextRef.current;
    dragContextRef.current = null;
    setDragging(false);
    if (!context) return;
    if (!context.moved) {
      // 窗口收起时，点球 = 重新展开主窗口（不再只是开面板）
      if (windowHidden) { onExpand(); return; }
      setPanelOpen(!context.panelWasOpen);
      return;
    }
    const rawPosition = dragOffset || { left: context.left, top: context.top };
    const committed = clampDockPosition(rawPosition.left, rawPosition.top, ballSize, readViewSize());
    setDragOffset(null);
    if (!bridge) return;
    bridge.setDockAnchor({ left: Math.round(committed.left), top: Math.round(committed.top) });
    bridge.setDockOpenDir(computeOpenDir({ ...committed, ...ballSize }, readViewSize()));
  };

  return (
    <>
      {/* 悬浮球：品牌蓝渐变圆球（深灰胶囊属演示外壳，不采用） */}
      <div
        ref={setBallElement}
        className="tim-ball-anchor"
        data-open-dir={openDir}
        style={{ position: 'fixed', zIndex: 1, left: `${ballPosition.left}px`, top: `${ballPosition.top}px`, transition: dragging ? 'none' : 'transform 220ms cubic-bezier(.16,1,.3,1)' }}
        onPointerDown={(event) => {
          event.preventDefault();
          dragContextRef.current = { startX: event.clientX, startY: event.clientY, left: ballPosition.left, top: ballPosition.top, panelWasOpen: panelOpen, moved: false };
          try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* 捕获失败不影响拖动 */ }
        }}
        onPointerMove={(event) => {
          const context = dragContextRef.current;
          if (!context) return;
          const deltaX = event.clientX - context.startX;
          const deltaY = event.clientY - context.startY;
          if (!context.moved) {
            if (!shouldStartDrag(deltaX, deltaY)) return;
            context.moved = true;
            setDragging(true);
            if (context.panelWasOpen) setPanelOpen(false);
          }
          setDragOffset(clampDockPosition(context.left + deltaX, context.top + deltaY, ballSize, readViewSize()));
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div className="tim-ball" role="button" tabIndex={0} id="floatBall" data-fb-target="" title={accessibleLabel} aria-label={accessibleLabel}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPanelOpen(true); } }}>
          <span className="tim-ball-target"><Avatar avatar={activeGroup ? activeGroup.avatar : null} fallbackName={platformName} /></span>
        </div>
      </div>

      {panelOpen ? (
        <section ref={setPanelElement} className="tim-panel" id="floatPanel" role="dialog" aria-label="我的模型团队"
          style={{ position: 'fixed', left: `${panelPosition.left}px`, top: `${panelPosition.top}px` }}>
          <header className="tim-panel-head" id="fpHead">
            <button type="button" className="tim-panel-title" id="fpTitle" onClick={() => { actions.openView('db'); setPanelOpen(false); }}>我的模型团队</button>
            <span className="tim-panel-model">{`模型 ${targetLabel}`}</span>
            <button type="button" className="tim-panel-min" onClick={() => setPanelOpen(false)} aria-label="收起面板" title="收起面板">—</button>
          </header>
          <div className="tim-panel-body">
            <div className="tim-panel-sep" />
            {fields.map((field) => (
              <div key={field.key} className="tim-panel-row">
                <span className="tim-panel-k">{field.label}</span>
                <span className="tim-panel-v" title={field.title && field.title.length > 0 ? field.title : undefined}>
                  {field.value}
                  {field.hint ? <span className="tim-panel-hint">{field.hint}</span> : null}
                </span>
              </div>
            ))}
          </div>
          <div className="tim-panel-sep" />
          <button type="button" className="tim-panel-enter" id="fpEnter" onClick={() => { actions.openView('list'); setPanelOpen(false); }}>进入群聊界面 &gt;</button>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- styles（受 [data-theme-root="tim"] 约束的纯 CSS）

const THEME_STYLES = `/* ===== 主题令牌（docs/25 §二）===== */
[data-theme-root="tim"] {
  --tim-primary: #12B7F5;
  --tim-primary-deep: #0E9FD8;
  --tim-primary-soft: #E7F7FE;
  --tim-bg-app: #f7f7f7;
  --tim-bg-chat: #F3F4F6;
  --tim-bg-card: #FFFFFF;
  --tim-bg-input: #EEF0F2;
  --tim-text-1: #111827;
  --tim-text-2: #6B7280;
  --tim-text-3: #9CA3AF;
  --tim-line: #E5E7EB;
  --tim-radius: 8px;
  --tim-title: 26px;          /* 页面大标题 */
  --tim-bubble-tail: 6px;     /* 气泡三角尖边长 */
  --tim-avatar: 52px;
  --tim-tabbar: 60px;
  /* 窄长比例：竖版 400×760（不是桌面横版 760×540） */
  --tim-window-width: min(400px, 92vw);
  --tim-window-height: min(760px, 86vh);
}

/* 主窗口（桌面浮窗，不含演示用的手机外壳）。
   跨宿主层级由宿主容器统一持有（theme-epilogue 把容器放进 app 层）；
   这里的 2 只是容器内部顺序，主题不持任何跨宿主层级数值。 */
[data-theme-root="tim"] .tim-app {
  position: fixed;
  z-index: 2;   /* 容器内部顺序（跨宿主的层级由宿主容器统一给，见 theme-epilogue.js） */
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: var(--tim-window-width);
  height: var(--tim-window-height);
  display: flex;
  flex-direction: column;
  background: var(--tim-bg-app);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(17, 24, 39, 0.24), 0 0 0 1px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--tim-text-1);
  user-select: none;
}

[data-theme-root="tim"] .tim-app-body { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
[data-theme-root="tim"] .tim-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ===== 群聊页：顶栏蓝底白字（与 classic 的浅蓝渐变截然不同）===== */
[data-theme-root="tim"] .tim-chat-head {
  flex: none;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  background: var(--tim-primary);
  color: #fff;
}

[data-theme-root="tim"] .tim-back { border: none; background: transparent; color: #fff; font-size: 20px; cursor: pointer; padding: 0 4px; }
[data-theme-root="tim"] .tim-chat-title { font-size: 18px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-badge { font-size: 12px; background: rgba(255, 255, 255, 0.2); padding: 1px 8px; border-radius: 999px; }

/* 聊天区点阵背景 */
[data-theme-root="tim"] .tim-chat-bg {
  background-color: var(--tim-bg-chat);
  background-image: radial-gradient(#D1D5DB 1px, transparent 1px);
  background-size: 20px 20px;
}

[data-theme-root="tim"] .tim-stream { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
[data-theme-root="tim"] .tim-row-left { display: flex; justify-content: flex-start; }
[data-theme-root="tim"] .tim-row-right { display: flex; justify-content: flex-end; }
[data-theme-root="tim"] .tim-row-center { display: flex; justify-content: center; }

[data-theme-root="tim"] .tim-sys { background: rgba(156, 163, 175, 0.28); color: var(--tim-text-2); font-size: 11.5px; padding: 3px 10px; border-radius: var(--tim-radius); }

/* 气泡：带三角尾巴（classic 无尾巴 —— 第二处肉眼可辨的差异） */
[data-theme-root="tim"] .tim-bubble,
[data-theme-root="tim"] .tim-card { position: relative; max-width: 85%; border-radius: var(--tim-radius); font-size: 13.5px; }

[data-theme-root="tim"] .tim-bubble { padding: 9px 12px; }
[data-theme-root="tim"] .tim-bubble-right { background: var(--tim-primary); color: #fff; max-width: 75%; box-shadow: 0 2px 6px rgba(18, 183, 245, 0.28); }
[data-theme-root="tim"] .tim-bubble-right::before {
  content: ""; position: absolute; right: -6px; top: 14px;
  border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 6px solid var(--tim-primary);
}

[data-theme-root="tim"] .tim-card {
  background: var(--tim-bg-card);
  border: 1px solid #F3F4F6;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  padding: 10px 12px;
  cursor: pointer;
}

[data-theme-root="tim"] .tim-bubble-left::before {
  content: ""; position: absolute; left: -6px; top: 14px;
  border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-right: 6px solid var(--tim-bg-card);
}

[data-theme-root="tim"] .tim-card:hover { background: #FAFAFA; }
[data-theme-root="tim"] .tim-card-head { display: flex; align-items: center; gap: 8px; }
[data-theme-root="tim"] .tim-card-model { font-weight: 600; color: var(--tim-text-1); font-family: "JetBrains Mono", Consolas, monospace; font-size: 12.5px; }
[data-theme-root="tim"] .tim-card-time { margin-left: auto; font-size: 11px; color: var(--tim-text-3); }

/* 指标行：允许折两行（25 §十一 的硬要求） */
[data-theme-root="tim"] .tim-metrics { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 8px; font-size: 11.5px; color: var(--tim-text-2); }
[data-theme-root="tim"] .tim-status-ok { color: #10B981; font-weight: 600; }
[data-theme-root="tim"] .tim-status-bad { color: #EF4444; font-weight: 600; }
[data-theme-root="tim"] .tim-sep { color: #CBD5E1; margin-right: 6px; }

[data-theme-root="tim"] .tim-card-detail { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--tim-line); display: grid; grid-template-columns: 64px 1fr; gap: 4px 10px; font-size: 12px; }
[data-theme-root="tim"] .tim-card-detail .tim-k { color: var(--tim-text-3); }

[data-theme-root="tim"] .tim-avatar {
  flex: none; width: 32px; height: 32px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  background: var(--tim-primary-soft); color: var(--tim-primary-deep);
  font-size: 12px; font-weight: 700; overflow: hidden;
}
[data-theme-root="tim"] .tim-avatar img { width: 100%; height: 100%; object-fit: cover; }
[data-theme-root="tim"] .tim-avatar-lg { width: var(--tim-avatar); height: var(--tim-avatar); border-radius: 12px; font-size: 17px; background: #fff; color: var(--tim-text-2); border: 1px solid var(--tim-line); box-shadow: 0 1px 3px rgba(17, 24, 39, 0.06); }
[data-theme-root="tim"] .tim-avatar-group { background: #DCFCE7; color: #15803D; }

/* 输入区 */
[data-theme-root="tim"] .tim-input-bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #fff; border-top: 1px solid var(--tim-line); }
[data-theme-root="tim"] .tim-at { width: 30px; height: 30px; border: none; border-radius: 8px; background: var(--tim-bg-input); color: var(--tim-text-2); font-weight: 700; cursor: pointer; }
[data-theme-root="tim"] .tim-input { flex: 1; min-width: 0; height: 34px; padding: 0 12px; border: none; border-radius: 8px; background: var(--tim-bg-input); font-size: 13px; color: var(--tim-text-1); outline: none; }
[data-theme-root="tim"] .tim-send { height: 34px; padding: 0 16px; border: none; border-radius: 8px; background: var(--tim-primary); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }

/* INV-14 显隐落点（0.4.0）：宿主在主题根上写 data-dock-visible，主题据此隐藏悬浮件。
   球是常驻节点（不销毁，避免丢监听），只切显示。 */
[data-dmt-theme-host][data-dock-visible="false"] .tim-ball-anchor { display: none; }

/* 主窗口可拖：拖过之后用 left/top 定位（覆盖居中 transform）；顶栏空白处给出抓取光标 */
[data-theme-root="tim"] .tim-app.tim-app-draggable { touch-action: none; }
[data-theme-root="tim"] .tim-app-draggable .tim-list-head,
[data-theme-root="tim"] .tim-app-draggable .tim-chat-head,
[data-theme-root="tim"] .tim-app-draggable .tim-profile-head { cursor: grab; }
[data-theme-root="tim"] .tim-app-draggable .tim-list-head button,
[data-theme-root="tim"] .tim-app-draggable .tim-chat-head button,
[data-theme-root="tim"] .tim-app-draggable .tim-profile-head button { cursor: pointer; }

/* 顶部「—」收起键：触屏友好（32×32 命中区），不抢标题视觉 */
[data-theme-root="tim"] .tim-window-hide { flex: none; width: 32px; height: 32px; margin-left: auto; border: none; border-radius: 8px; background: transparent; color: inherit; font-size: 18px; line-height: 1; cursor: pointer; opacity: 0.72; }
[data-theme-root="tim"] .tim-window-hide:hover { opacity: 1; background: rgba(0, 0, 0, 0.06); }

/* 加群表单（P4）：竖版窄屏，单列表单控件；字号沿用五档令牌 */
[data-theme-root="tim"] .tim-addpage { display: flex; flex-direction: column; }
[data-theme-root="tim"] .tim-form-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 16px 20px; }
[data-theme-root="tim"] .tim-form-label { display: block; margin: 12px 0 6px; font-size: 12px; color: var(--tim-text-2); }
[data-theme-root="tim"] .tim-form-input { width: 100%; height: 38px; padding: 0 12px; border: 1px solid var(--tim-line); border-radius: 8px; background: #fff; font-size: 13.5px; color: var(--tim-text-1); outline: none; }
/* 自绘平台下拉：触发器沿用 form-input 的形状；浮层用同一套圆角/边框/字号 tokens */
[data-theme-root="tim"] .tim-picker { position: relative; }
[data-theme-root="tim"] .tim-picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; text-align: left; }
[data-theme-root="tim"] .tim-picker-trigger:focus-visible { border-color: var(--tim-blue); box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
[data-theme-root="tim"] .tim-picker-placeholder { color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-picker-arrow { color: var(--tim-text-3); font-size: 11px; flex: none; }
[data-theme-root="tim"] .tim-picker-list { position: absolute; z-index: 3; left: 0; right: 0; margin: 4px 0 0; padding: 4px; list-style: none; background: #fff; border: 1px solid var(--tim-line); border-radius: 8px; box-shadow: 0 8px 24px rgba(15,23,42,.12); max-height: 220px; overflow: auto; outline: none; }
[data-theme-root="tim"] .tim-picker-option { padding: 8px 10px; border-radius: 6px; font-size: 13.5px; color: var(--tim-text-1); cursor: pointer; }
[data-theme-root="tim"] .tim-picker-option[data-active="true"] { background: var(--tim-bg-2); }
[data-theme-root="tim"] .tim-picker-option.is-selected { color: var(--tim-blue); font-weight: 600; }
[data-theme-root="tim"] .tim-form-input:focus { border-color: var(--tim-primary); }
[data-theme-root="tim"] .tim-form-section { margin-top: 4px; }
[data-theme-root="tim"] .tim-form-field { margin-bottom: 2px; }
[data-theme-root="tim"] .tim-form-primary { width: 100%; height: 40px; margin-top: 14px; border: none; border-radius: 8px; background: var(--tim-primary); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
[data-theme-root="tim"] .tim-form-primary:disabled { background: #C7D3DC; cursor: not-allowed; }
[data-theme-root="tim"] .tim-form-ghost { height: 34px; padding: 0 14px; border: 1px solid var(--tim-primary); border-radius: 8px; background: #fff; color: var(--tim-primary); font-size: 13px; cursor: pointer; }
[data-theme-root="tim"] .tim-form-row { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
[data-theme-root="tim"] .tim-form-note { margin-top: 8px; font-size: 11.5px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-form-error { margin-top: 8px; font-size: 11.5px; color: var(--tim-status-bad); }
[data-theme-root="tim"] .tim-form-models { margin: 8px 0 0; padding: 0; list-style: none; }
[data-theme-root="tim"] .tim-form-model { padding: 7px 10px; border-bottom: 1px solid var(--tim-line); font-size: 12.5px; color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-contact-edit { align-self: center; margin-right: 14px; padding: 4px 10px; border: 1px solid var(--tim-line); border-radius: 8px; background: #fff; color: var(--tim-text-2); font-size: 11.5px; cursor: pointer; }
[data-theme-root="tim"] .tim-profile-file { display: none; }
/* 导入面板 / 分组编辑 / 删除确认：都走同一套底部弹层（竖版窄屏用底部弹层，不用居中模态） */
[data-theme-root="tim"] .tim-import-panel { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px 14px; background: #F7FAFC; border-bottom: 1px solid var(--tim-line); }
[data-theme-root="tim"] .tim-import-pick { display: inline-flex; align-items: center; justify-content: center; height: 34px; border: 1px dashed var(--tim-primary); border-radius: 8px; color: var(--tim-primary); font-size: 13px; cursor: pointer; }
[data-theme-root="tim"] .tim-form-textarea { width: 100%; min-height: 88px; padding: 8px 12px; border: 1px solid var(--tim-line); border-radius: 8px; background: #fff; font-size: 13px; color: var(--tim-text-1); font-family: inherit; outline: none; resize: vertical; }
[data-theme-root="tim"] .tim-sheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: 86%; display: flex; flex-direction: column; background: #fff; border-radius: 14px 14px 0 0; box-shadow: 0 -6px 24px rgba(0,0,0,0.16); z-index: 6; }
[data-theme-root="tim"] .tim-sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--tim-line); font-size: 14px; font-weight: 600; }
[data-theme-root="tim"] .tim-sheet-close { border: none; background: transparent; color: var(--tim-text-3); font-size: 12.5px; cursor: pointer; }
[data-theme-root="tim"] .tim-sheet-body { overflow-y: auto; padding: 4px 16px 18px; }
[data-theme-root="tim"] .tim-member-list { margin: 10px 0 0; padding: 0; list-style: none; }
[data-theme-root="tim"] .tim-member-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--tim-line); font-size: 12.5px; }
[data-theme-root="tim"] .tim-member-name { color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-member-remove { border: none; background: transparent; color: var(--tim-status-bad); font-size: 12px; cursor: pointer; }
[data-theme-root="tim"] .tim-member-empty { padding: 8px 10px; font-size: 12px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-contact-row { display: flex; align-items: center; }
[data-theme-root="tim"] .tim-contact-row .tim-contact-head { flex: 1; min-width: 0; }
[data-theme-root="tim"] .tim-contact-strategy { font-size: 11.5px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-groups-new { width: calc(100% - 32px); margin: 12px 16px; }
[data-theme-root="tim"] .tim-empty-action { margin-top: 10px; }
[data-theme-root="tim"] .tim-confirm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.35); z-index: 7; }
[data-theme-root="tim"] .tim-confirm-box { width: 100%; padding: 16px; border-radius: 12px; background: #fff; }
[data-theme-root="tim"] .tim-confirm-title { font-size: 14px; font-weight: 600; }
[data-theme-root="tim"] .tim-confirm-note { margin-top: 6px; font-size: 12px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-confirm-actions { display: flex; gap: 10px; margin-top: 14px; }
[data-theme-root="tim"] .tim-confirm-actions > * { flex: 1; }
[data-theme-root="tim"] .tim-confirm-danger { background: var(--tim-status-bad); }
[data-theme-root="tim"] .tim-platform-section { padding: 4px 0 2px; }
[data-theme-root="tim"] .tim-platform-group-name { padding: 6px 16px 2px; font-size: 11.5px; color: var(--tim-text-3); }

/* @ 选择器：底部弹出面板 */
[data-theme-root="tim"] .tim-mention { position: absolute; left: 0; right: 0; bottom: 54px; max-height: 62%; display: flex; flex-direction: column; background: #fff; border-top: 1px solid var(--tim-line); border-radius: 14px 14px 0 0; box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.12); z-index: 5; }
[data-theme-root="tim"] .tim-mention-head { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--tim-line); font-size: 12px; font-weight: 600; color: var(--tim-text-2); }
[data-theme-root="tim"] .tim-mention-close { border: none; background: transparent; color: var(--tim-text-3); cursor: pointer; font-size: 12px; }
[data-theme-root="tim"] .tim-mention-body { overflow-y: auto; padding: 6px; }
[data-theme-root="tim"] .tim-mention-section { padding: 6px 8px; font-size: 11.5px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-mention-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: none; background: transparent; border-radius: 8px; font-size: 13px; color: var(--tim-text-1); text-align: left; cursor: pointer; }
[data-theme-root="tim"] .tim-mention-item:hover { background: #F3F7FA; }
[data-theme-root="tim"] .tim-mention-empty { padding: 8px; font-size: 12px; color: var(--tim-text-3); }

/* ===== 消息列表 ===== */
[data-theme-root="tim"] .tim-list { background: var(--tim-bg-app); }
[data-theme-root="tim"] .tim-list-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; }
[data-theme-root="tim"] .tim-page-title { margin: 0; font-size: var(--tim-title); font-weight: 700; letter-spacing: -0.01em; color: var(--tim-text-1); }
/* 带返回键的标题栏：返回与标题左对齐相邻（默认 space-between 会把标题顶到右边） */
[data-theme-root="tim"] .tim-list-head-inline { justify-content: flex-start; gap: 6px; }
[data-theme-root="tim"] .tim-list-head-inline .tim-back { color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-add-wrap { position: relative; }
[data-theme-root="tim"] .tim-add { width: 34px; height: 34px; border: none; border-radius: 10px; background: #fff; color: var(--tim-text-1); font-size: 22px; line-height: 1; cursor: pointer; box-shadow: 0 1px 4px rgba(17, 24, 39, 0.1); }
[data-theme-root="tim"] .tim-add-menu { position: absolute; right: 0; top: 40px; width: 190px; background: #fff; border-radius: 12px; box-shadow: 0 8px 28px rgba(17, 24, 39, 0.16); padding: 6px; z-index: 20; }
[data-theme-root="tim"] .tim-add-menu button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 10px; border: none; background: transparent; border-radius: 8px; font-size: 13px; color: var(--tim-text-1); text-align: left; cursor: pointer; }
[data-theme-root="tim"] .tim-add-menu button:hover { background: #F3F7FA; }

[data-theme-root="tim"] .tim-search-wrap { padding: 0 16px 8px; }
[data-theme-root="tim"] .tim-search { width: 100%; height: 34px; padding: 0 12px; border: none; border-radius: 10px; background: rgba(229, 231, 235, 0.7); font-size: 13px; color: var(--tim-text-1); outline: none; }
[data-theme-root="tim"] .tim-list-meta-line { padding: 6px 16px 8px; font-size: 12.5px; color: var(--tim-text-3); border-bottom: 1px solid rgba(229, 231, 235, 0.7); }

[data-theme-root="tim"] .tim-list-body { flex: 1; min-height: 0; overflow-y: auto; }
[data-theme-root="tim"] .tim-list-item { width: 100%; min-height: 72px; display: flex; align-items: center; gap: 12px; padding: 10px 16px; border: none; background: transparent; text-align: left; cursor: pointer; transition: background 0.15s ease; }
[data-theme-root="tim"] .tim-list-item:hover { background: rgba(0, 0, 0, 0.03); }
[data-theme-root="tim"] .tim-list-main { flex: 1; min-width: 0; }
[data-theme-root="tim"] .tim-list-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
[data-theme-root="tim"] .tim-list-name { flex: 1; min-width: 0; font-size: 16px; font-weight: 600; color: var(--tim-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-list-time { flex: none; font-size: 12px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-list-summary { display: block; margin-top: 2px; font-size: 14px; color: var(--tim-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ===== 通讯录（折叠分组）===== */
[data-theme-root="tim"] .tim-contacts { background: #fff; }   /* 通讯录为白底（消息/我才是 #f7f7f7） */
[data-theme-root="tim"] .tim-contacts-body { flex: 1; min-height: 0; overflow-y: auto; }
[data-theme-root="tim"] .tim-contact-tabs { display: flex; align-items: center; gap: 24px; padding: 0 16px 10px; border-bottom: 1px solid var(--tim-line); font-size: 15px; color: var(--tim-text-2); }
[data-theme-root="tim"] .tim-contact-tab { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; padding: 0; border: none; background: transparent; font-size: 15px; color: var(--tim-text-2); cursor: pointer; }
[data-theme-root="tim"] .tim-contact-tab:hover { color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-contact-tab-active { color: var(--tim-primary); font-weight: 600; }
/* 选中下划线用真实元素（不是伪元素）：16×2px 圆角品牌蓝，居中——肉眼可辨 */
/* 更细的线（16×2px）在 400px 竖版 + 高分屏缩放后不可辨，
   这里放大到 28×4px（仍居中、仍圆角、仍品牌蓝），并让选中文字也用品牌蓝——
   判据是「肉眼能看出选中哪个 tab」，不是像素尺寸逐值相等（docs/03 §十 允许有理由的偏离） */
[data-theme-root="tim"] .tim-contact-underline { display: block; width: 28px; height: 4px; border-radius: 4px; background: var(--tim-primary); }
[data-theme-root="tim"] .tim-contact-group { border-bottom: 1px solid #F1F2F4; }
[data-theme-root="tim"] .tim-contact-head { width: 100%; display: flex; align-items: center; gap: 8px; padding: 14px 16px; border: none; background: transparent; cursor: pointer; }
[data-theme-root="tim"] .tim-contact-head:hover { background: #FAFAFA; }
[data-theme-root="tim"] .tim-arrow { display: inline-block; width: 14px; color: var(--tim-text-3); transition: transform 0.2s ease-in-out; }
[data-theme-root="tim"] .tim-arrow-expanded { transform: rotate(90deg); }
[data-theme-root="tim"] .tim-contact-name { flex: 1; text-align: left; font-size: 15px; color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-contact-count { font-size: 11.5px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-contact-items { background: #FAFAFA; padding: 4px 0; }
[data-theme-root="tim"] .tim-contact-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px 9px 38px; font-size: 13.5px; color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-contact-item:hover { background: #F1F3F5; }
[data-theme-root="tim"] .tim-contact-empty { padding: 10px 38px; font-size: 12px; color: var(--tim-text-3); }

/* ===== 我 / 数据库页 ===== */
[data-theme-root="tim"] .tim-profile { background: var(--tim-bg-app); }
[data-theme-root="tim"] .tim-profile-head { flex: none; display: flex; align-items: center; gap: 14px; padding: 20px 16px; background: #fff; border-bottom: 1px solid var(--tim-line); }
[data-theme-root="tim"] .tim-profile-avatar { width: 56px; height: 56px; border-radius: 14px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #38BDF8, var(--tim-primary-deep)); color: #fff; font-size: 22px; font-weight: 700; box-shadow: 0 4px 12px rgba(18, 183, 245, 0.3); }
[data-theme-root="tim"] .tim-profile-title { font-size: 18px; font-weight: 700; }
[data-theme-root="tim"] .tim-profile-sub { margin-top: 2px; font-size: 12.5px; color: var(--tim-text-2); }
[data-theme-root="tim"] .tim-profile-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 20px; display: flex; flex-direction: column; gap: 10px; }
[data-theme-root="tim"] .tim-profile-row { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 14px 16px; border: 1px solid var(--tim-line); border-radius: 12px; background: #fff; font-size: 13.5px; color: var(--tim-text-1); cursor: pointer; box-shadow: 0 1px 3px rgba(17, 24, 39, 0.04); }
[data-theme-root="tim"] .tim-profile-row:hover { background: #FAFBFC; }
[data-theme-root="tim"] .tim-chevron { color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-platform-title { margin-top: 6px; font-size: 12px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-platform-list { background: #fff; border: 1px solid var(--tim-line); border-radius: 12px; overflow: hidden; }
[data-theme-root="tim"] .tim-platform-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #F1F2F4; }
[data-theme-root="tim"] .tim-platform-item:last-child { border-bottom: none; }
[data-theme-root="tim"] .tim-platform-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-platform-badge { font-size: 11px; padding: 1px 8px; border-radius: 6px; background: #DCFCE7; color: #15803D; }

/* ===== 底边栏：56px（classic 是 54px）===== */
[data-theme-root="tim"] .tim-tabbar { flex: none; height: var(--tim-tabbar); display: flex; align-items: center; justify-content: space-around; background: var(--tim-bg-app); border-top: 1px solid var(--tim-line); }
[data-theme-root="tim"] .tim-tab { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 72px; padding: 0; border: none; background: transparent; color: var(--tim-text-2); font-size: 10px; font-weight: 500; cursor: pointer; }
[data-theme-root="tim"] .tim-tab[aria-selected="true"] { color: var(--tim-primary); font-weight: 600; }

/* ===== 悬浮球：品牌蓝渐变圆球 ===== */
/* 悬浮球：深色胶囊（圆角全满 + 白字 10px + 右下绿点） */
[data-theme-root="tim"] .tim-ball { position: relative; min-width: 56px; height: 34px; padding: 0 12px; border-radius: 999px; display: flex; align-items: center; justify-content: center; gap: 6px; color: #fff; font-size: 10px; cursor: grab; touch-action: none; background: #111827; box-shadow: 0 8px 20px rgba(17, 24, 39, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.08); transition: transform 0.16s ease, box-shadow 0.16s ease; }
[data-theme-root="tim"] .tim-ball:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(17, 24, 39, 0.4); }
[data-theme-root="tim"] .tim-ball-target { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; font-weight: 700; background: rgba(255, 255, 255, 0.16); }
[data-theme-root="tim"] .tim-ball-target img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
[data-theme-root="tim"] .tim-ball::after { content: ""; position: absolute; right: -2px; bottom: -2px; width: 12px; height: 12px; border-radius: 50%; background: #22C55E; border: 2px solid #fff; }

/* ===== 面板：深色标题条 ===== */
[data-theme-root="tim"] .tim-panel { z-index: 3; width: 320px; border-radius: 12px; overflow: hidden; background: #fff; box-shadow: 0 18px 44px rgba(17, 24, 39, 0.34); border: 1px solid var(--tim-line); font: 13px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif; color: var(--tim-text-1); }
[data-theme-root="tim"] .tim-panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #111827; color: #fff; }
[data-theme-root="tim"] .tim-panel-title { border: none; background: transparent; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; padding: 0; }
[data-theme-root="tim"] .tim-panel-model { margin-left: auto; font-size: 11.5px; color: #9CA3AF; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-panel-min { width: 20px; height: 20px; border: none; border-radius: 4px; background: transparent; color: #9CA3AF; font-size: 14px; line-height: 1; cursor: pointer; }
[data-theme-root="tim"] .tim-panel-min:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
[data-theme-root="tim"] .tim-panel-body { padding: 10px 14px; }
[data-theme-root="tim"] .tim-panel-row { display: flex; gap: 6px; padding: 3px 0; font-size: 12.5px; }
[data-theme-root="tim"] .tim-panel-k { flex: none; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-panel-v { color: var(--tim-text-1); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-panel-hint { margin-left: 4px; color: var(--tim-text-3); font-weight: 400; font-size: 11px; }
[data-theme-root="tim"] .tim-panel-sep { height: 1px; margin: 6px 0; background: var(--tim-line); }
[data-theme-root="tim"] .tim-panel-enter { display: block; width: calc(100% - 28px); margin: 0 14px 12px; padding: 7px 0; border: none; border-radius: 8px; background: var(--tim-primary-soft); color: var(--tim-primary-deep); font-size: 12px; font-weight: 600; cursor: pointer; }
[data-theme-root="tim"] .tim-panel-enter:hover { background: #D6F3FE; }

/* ===== 空态与错误态 ===== */
[data-theme-root="tim"] .tim-empty-inline { margin: 16px; padding: 14px; border-radius: 10px; background: rgba(229, 231, 235, 0.55); color: var(--tim-text-3); font-size: 13px; text-align: center; }
[data-theme-root="tim"] .tim-list-error { margin: 14px 16px; padding: 16px; border: 1px solid rgba(248, 113, 113, 0.45); border-radius: 12px; background: rgba(248, 113, 113, 0.08); text-align: center; }
[data-theme-root="tim"] .tim-list-error-title { font-size: 13px; font-weight: 600; color: #EF4444; }
[data-theme-root="tim"] .tim-list-error-detail { margin-top: 6px; font-size: 11.5px; color: var(--tim-text-3); word-break: break-all; }
[data-theme-root="tim"] .tim-retry { margin-top: 10px; padding: 6px 14px; border: 1px solid var(--tim-line); border-radius: 8px; background: #fff; font-size: 12px; cursor: pointer; }

/* 0.4.0：legacy 界面（骨架 + 悬浮件）已整体删除，主题成为唯一界面来源，
 * 所以这里不再需要"隐藏 legacy 主窗口"。历史规则 html[data-dmt-theme] .team-app{display:none}
 * 曾把主题自己的主窗口一起隐藏——因为主题窗口带契约别名 .team-app（docs/03 §2.2）。
 * 保留一条更窄的兜底：只隐藏仍挂在 legacy 宿主容器里的残留节点（正常情况不存在）。 */
[data-dmt-theme] .dmt-host .team-app,
[data-dmt-theme] .dmt-host .float-dock,
[data-dmt-theme] .dmt-host .float-panel {
  display: none !important;
}

/* ===== 深色模式（docs/25 §六；主色不变）===== */
@media (prefers-color-scheme: dark) {
  [data-theme-root="tim"] {
    --tim-bg-app: #1A1D21;
    --tim-bg-chat: #15181C;
    --tim-bg-card: #22262B;
    --tim-bg-input: #2A2F35;
    --tim-text-1: #E6E8EB;
    --tim-text-2: #9BA1A8;
    --tim-text-3: #6B7178;
    --tim-line: #33383E;
  }
  [data-theme-root="tim"] .tim-contacts,
  [data-theme-root="tim"] .tim-panel,
  [data-theme-root="tim"] .tim-profile-head,
  [data-theme-root="tim"] .tim-platform-list,
  [data-theme-root="tim"] .tim-profile-row,
  [data-theme-root="tim"] .tim-add,
  [data-theme-root="tim"] .tim-add-menu,
  [data-theme-root="tim"] .tim-input-bar,
  [data-theme-root="tim"] .tim-mention { background: var(--tim-bg-card); }
  [data-theme-root="tim"] .tim-list-meta-line,
  [data-theme-root="tim"] .tim-chat-head { border-color: var(--tim-line); }
  [data-theme-root="tim"] .tim-bubble-left::before { border-right-color: var(--tim-bg-card); }
  [data-theme-root="tim"] .tim-contact-items { background: #1F2328; }
  [data-theme-root="tim"] .tim-search { background: #2A2F35; color: var(--tim-text-1); }
  [data-theme-root="tim"] .tim-tabbar { background: #1A1D21; }
}
`;

export default defineTheme({
  meta: { id: 'tim', name: '经典蓝（竖版）', contractVersion: 1 },
  styles: THEME_STYLES,
  Root: function TimRoot() {
    // 收起 = 只不渲染主窗口（DOM 与订阅都保留，球还在），再点球展开；不销毁、不退订
    // 默认收起：首帧时既有判定还没到、球也还没显示，此时**不该弹出聊天界面**
    // （契约 03 §7.3.6：球隐藏 ⇒ 主窗口隐藏，单向；球显示不反向强制展开）
    const [windowHidden, setWindowHidden] = useState(true);
    // 主窗口位置：由宿主 dock 状态持有（主题不碰浏览器存储）；null = 还没拖过（居中）
    const dockBridge = useDockState();
    const [windowPosition, setWindowPosition] = useState<{ left: number; top: number } | null>(null);
    const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);
    // 拖动过程中的最新位置（同一个 tick 里 state 还没刷新，落盘要用它）
    const latestPositionRef = useRef<{ left: number; top: number } | null>(null);

    const anchorFromHost = dockBridge.snapshot && dockBridge.snapshot.windowAnchor;
    const effectivePosition = windowPosition || (anchorFromHost ? { left: anchorFromHost.left, top: anchorFromHost.top } : null);

    // 只在顶栏空白处起拖：按钮/输入/选择器不触发（触屏也一样，pointer 事件统一处理）
    const beginWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest('button,input,select,textarea,a,[data-no-drag]')) return;
      const inHeader = target && target.closest('.tim-list-head,.tim-chat-head,.tim-profile-head');
      if (!inHeader) return;
      const appElement = (event.currentTarget as HTMLElement).getBoundingClientRect();
      dragRef.current = { startX: event.clientX, startY: event.clientY, left: appElement.left, top: appElement.top };
      try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* 捕获失败不影响拖动 */ }
    };

    const moveWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
      const context = dragRef.current;
      if (!context) return;
      const appElement = event.currentTarget as HTMLElement;
      const size = { width: appElement.offsetWidth, height: appElement.offsetHeight };
      const clamped = clampDockPosition(
        context.left + (event.clientX - context.startX),
        context.top + (event.clientY - context.startY),
        size,
        readViewSize(),
      );
      latestPositionRef.current = clamped;
      setWindowPosition(clamped);
    };

    const endWindowDrag = () => {
      const context = dragRef.current;
      dragRef.current = null;
      const finalPosition = latestPositionRef.current || windowPosition;
      if (!context || !finalPosition) return;
      // 位置存宿主：与球锚点分开的 windowAnchor（持久化由宿主的状态工厂负责）
      if (dockBridge.bridge && typeof dockBridge.bridge.setWindowAnchor === 'function') {
        dockBridge.bridge.setWindowAnchor(finalPosition);
      }
    };

    return (
      <div data-theme-root="tim" className="tim-theme-root">
        <DockLayer windowHidden={windowHidden} onExpand={() => setWindowHidden(false)} />
        {windowHidden || !(dockBridge.snapshot && dockBridge.snapshot.visible) ? null : (
          <MainWindow
            onHide={() => setWindowHidden(true)}
            windowStyle={effectivePosition
              ? { left: effectivePosition.left, top: effectivePosition.top, transform: 'none' }
              : {}}
            dragHandlers={{ onPointerDown: beginWindowDrag, onPointerMove: moveWindowDrag, onPointerUp: endWindowDrag }}
          />
        )}
      </div>
    );
  },
});

export { attachStore as __attachStore } from '../theme-sdk/index';
// 三个页面单独导出：只给「渲染出什么」这类断言用（构建产物仍只用 default 的 Root）
export { AddPage, ContactsPage, ProfilePage, FriendGroupEditor };
