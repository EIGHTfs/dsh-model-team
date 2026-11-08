// tim.tsx —— TIM 主题：**一个文件就是一套完整界面**（结构 + 视觉 + styles）。
//
// 来源：参考项目/1.html（366 行）逐段翻成 React JSX，不是重新设计（转译契约见 docs/24 §5.5.2.1）。
// 1.html 里属于「手机 demo 外壳」的东西没有搬：400×800 手机边框、顶部状态栏（时间/5G/电池）、
// 硬编码假数据（05:12 / 99+ / 「已连接 3 个网关」）、外部 CDN 与参考稿的框架指令。
// 数据全部来自 ui/theme-sdk 的 hooks；样式是本文件里的纯 CSS 字符串。
//
// 与 classic 的差异必须在 5 处以上肉眼可辨（docs/25 §十一 对照表）：
//   ① 主色 #12B7F5（比 classic 的 #12a7f5 更亮）② 群聊顶栏蓝底白字 ③ 聊天区点阵背景
//   ④ 气泡带三角尾巴 ⑤ 列表头像 52px ⑥ 底栏 56px ⑦ 面板标题条深色。
//
// 行为逻辑（拖动、夹取、象限、列表三态、summary 判空、tab 映射）全在 ui/theme-sdk —— 这里只画。

import { useMemo, useRef, useState } from 'react';

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
  useFriendGroups,
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

function Avatar({ avatar, fallbackName, size = 'sm' }: { avatar: unknown; fallbackName: unknown; size?: 'sm' | 'lg' }) {
  const rawValue = String(avatar == null ? '' : avatar).trim();
  const isImageUrl = /^https?:\/\//i.test(rawValue) || /^data:/i.test(rawValue);
  const initial = String(fallbackName == null ? '' : fallbackName).trim().charAt(0).toUpperCase() || '?';
  const className = size === 'lg' ? 'tim-avatar tim-avatar-lg' : 'tim-avatar';
  if (isImageUrl) return <span className={className}><img src={rawValue} alt="" loading="lazy" /></span>;
  return <span className={className}>{rawValue || initial}</span>;
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

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" /></svg>
);
const ContactsIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" /></svg>
);
const ProfileIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
);

// ---------------------------------------------------------------- 群聊页

function ChatPage({ groupId }: { groupId: string }) {
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
              <button key={String(model.id)} type="button" className="tim-mention-item" onClick={() => { actions.switchTarget({ type: 'model', id: String(model.id) }); setMentionOpen(false); }}>
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

function ListPage() {
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

      {/* 1.html 这里是「已连接 3 个网关」的硬编码，句式保留、数字换成真实条数（契约 §5.5.2.1） */}
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

// ---------------------------------------------------------------- 通讯录（折叠分组）

function ContactsPage() {
  const friendGroups = useFriendGroups() as Array<{ id?: unknown; name?: unknown; strategy?: unknown; members?: Array<Record<string, unknown>> }>;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <section className="tim-view tim-contacts" data-view="contacts">
      <div className="tim-list-head"><h1 className="tim-page-title">联系人</h1></div>
      {/* 1.html L149-194 的分类 tab：只有「好友」有对应数据，其余三个是静态标签（不实现跳转） */}
      <div className="tim-contact-tabs">
        <span className="tim-contact-tab tim-contact-tab-active">好友</span>
        <span className="tim-contact-tab">分组</span>
        <span className="tim-contact-tab">群聊</span>
        <span className="tim-contact-tab">机器人</span>
      </div>
      <div className="tim-contacts-body">
        {friendGroups.length === 0 ? <div className="tim-empty-inline">还没有好友分组</div> : null}
        {friendGroups.map((friendGroup) => {
          const groupId = String(friendGroup.id || '');
          const isExpanded = Boolean(expanded[groupId]);
          const members = Array.isArray(friendGroup.members) ? friendGroup.members : [];
          return (
            <div key={groupId} className="tim-contact-group">
              <button type="button" className="tim-contact-head" onClick={() => setExpanded((previous) => ({ ...previous, [groupId]: !previous[groupId] }))}>
                <span className={isExpanded ? 'tim-arrow tim-arrow-expanded' : 'tim-arrow'}>›</span>
                <span className="tim-contact-name">{String(friendGroup.name || groupId)}</span>
                <span className="tim-contact-count">{members.length} 个平台模型</span>
              </button>
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
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 我 / 数据库页

function ProfilePage() {
  const groups = useGroups() as Array<{ id?: unknown; name?: unknown; driver?: unknown }>;
  return (
    <section className="tim-view tim-profile" data-view="profile">
      <div className="tim-profile-head">
        <span className="tim-profile-avatar">我</span>
        <div>
          <div className="tim-profile-title">我的 TIM 数据库</div>
          <div className="tim-profile-sub">当前已连接 {groups.length} 个平台</div>
        </div>
      </div>
      <div className="tim-profile-body">
        <button type="button" className="tim-profile-row" onClick={() => actions.openView('add')}>
          <span>🔐 登录平台 / 导入账号配置 (JSON)</span><span className="tim-chevron">&gt;</span>
        </button>
        <button type="button" className="tim-profile-row" onClick={() => actions.openView('db')}>
          <span>📤 导出当前配置</span><span className="tim-chevron">&gt;</span>
        </button>
        <div className="tim-platform-title">已接入平台</div>
        <div className="tim-platform-list">
          {groups.map((group) => (
            <div key={String(group.id)} className="tim-platform-item">
              <Avatar avatar={null} fallbackName={group.name} />
              <span className="tim-platform-name">{String(group.name || group.id)}</span>
              <span className="tim-platform-badge">正常</span>
            </div>
          ))}
          {groups.length === 0 ? <div className="tim-empty-inline">还没有接入平台</div> : null}
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
    <nav className="tim-tabbar" role="tablist">
      {TAB_ITEMS.map((tab) => {
        const selected = tab.key === activeTab;
        return (
          <button key={tab.key} type="button" role="tab" className="tim-tab" aria-selected={selected} onClick={() => actions.openView(tab.view as never)}>
            {tab.key === 'messages' ? <ChatIcon /> : tab.key === 'contacts' ? <ContactsIcon /> : <ProfileIcon />}
            <span className="tim-tab-label">{labels[tab.key] || tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function MainWindow() {
  const view = useView();
  return (
    <div className="tim-app">
      <div className="tim-app-body">
        {view.view === 'list' ? <ListPage /> : null}
        {view.view === 'chat' ? <ChatPage groupId={view.currentGroupId} /> : null}
        {view.view === 'contacts' ? <ContactsPage /> : null}
        {view.view === 'profile' ? <ProfilePage /> : null}
        {view.view === 'add' || view.view === 'db' ? <div className="tim-empty-inline">该页面将在下一阶段迁移</div> : null}
      </div>
      <TabBar />
    </div>
  );
}

// ---------------------------------------------------------------- L0 球 + L1 面板

function DockLayer() {
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

  if (!snapshot || !snapshot.visible) return null;

  const platformName = activeGroup && typeof activeGroup.name === 'string' ? activeGroup.name : '';
  const accessibleLabel = platformName ? `${targetLabel} · ${platformName}` : targetLabel;

  const finishDrag = () => {
    const context = dragContextRef.current;
    dragContextRef.current = null;
    setDragging(false);
    if (!context) return;
    if (!context.moved) { setPanelOpen(!context.panelWasOpen); return; }
    const rawPosition = dragOffset || { left: context.left, top: context.top };
    const committed = clampDockPosition(rawPosition.left, rawPosition.top, ballSize, readViewSize());
    setDragOffset(null);
    if (!bridge) return;
    bridge.setDockAnchor({ left: Math.round(committed.left), top: Math.round(committed.top) });
    bridge.setDockOpenDir(computeOpenDir({ ...committed, ...ballSize }, readViewSize()));
  };

  return (
    <>
      {/* 悬浮球：品牌蓝渐变圆球（1.html 的深灰胶囊属于 demo 外壳，25 §3.6 要求蓝渐变） */}
      <div
        ref={setBallElement}
        className="tim-ball-anchor"
        data-open-dir={openDir}
        style={{ position: 'fixed', left: `${ballPosition.left}px`, top: `${ballPosition.top}px`, transition: dragging ? 'none' : 'transform 220ms cubic-bezier(.16,1,.3,1)' }}
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
        <div className="tim-ball" role="button" tabIndex={0} data-fb-target="" title={accessibleLabel} aria-label={accessibleLabel}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPanelOpen(true); } }}>
          <span className="tim-ball-target"><Avatar avatar={activeGroup ? activeGroup.avatar : null} fallbackName={platformName} /></span>
        </div>
      </div>

      {panelOpen ? (
        <section ref={setPanelElement} className="tim-panel" role="dialog" aria-label="我的模型团队"
          style={{ position: 'fixed', left: `${panelPosition.left}px`, top: `${panelPosition.top}px` }}>
          <header className="tim-panel-head">
            <button type="button" className="tim-panel-title" onClick={() => { actions.openView('db'); setPanelOpen(false); }}>我的模型团队</button>
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
          <button type="button" className="tim-panel-enter" onClick={() => { actions.openView('list'); setPanelOpen(false); }}>进入群聊界面 &gt;</button>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- styles（1.html 的类名逐一翻成受 [data-theme-root="tim"] 约束的纯 CSS）

const TIM_STYLES = `/* ===== TIM 主题令牌（docs/25 §二）===== */
[data-theme-root="tim"] {
  --tim-primary: #12B7F5;
  --tim-primary-deep: #0E9FD8;
  --tim-primary-soft: #E7F7FE;
  --tim-bg-app: #F7F7F7;
  --tim-bg-chat: #F3F4F6;
  --tim-bg-card: #FFFFFF;
  --tim-bg-input: #EEF0F2;
  --tim-text-1: #111827;
  --tim-text-2: #4B5563;
  --tim-text-3: #9BA1A8;
  --tim-line: #E5E7EB;
  --tim-radius: 8px;
  --tim-avatar: 52px;
  --tim-tabbar: 56px;
  /* 窄长比例：1.html 是 400×800 的竖版，TIM 主题沿用这个比例（不是 desktop 的 760×540 横版） */
  --tim-window-width: min(400px, 92vw);
  --tim-window-height: min(760px, 86vh);
}

/* 主窗口（桌面浮窗，不是 1.html 的手机外壳） */
[data-theme-root="tim"] .tim-app {
  position: fixed;
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
[data-theme-root="tim"] .tim-chat-title { font-size: 17px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-badge { font-size: 11px; background: rgba(255, 255, 255, 0.22); padding: 1px 8px; border-radius: 999px; }

/* 聊天区点阵背景（1.html 的 .chat-bg 原样搬过来） */
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
  border: 1px solid var(--tim-line);
  box-shadow: 0 1px 4px rgba(17, 24, 39, 0.06);
  padding: 10px 12px;
  cursor: pointer;
}

[data-theme-root="tim"] .tim-bubble-left::before {
  content: ""; position: absolute; left: -6px; top: 14px;
  border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-right: 6px solid var(--tim-bg-card);
}

[data-theme-root="tim"] .tim-card:hover { background: #FAFBFC; }
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

/* @ 选择器：底部弹出面板（1.html 的 bottom sheet） */
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
[data-theme-root="tim"] .tim-page-title { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
[data-theme-root="tim"] .tim-add-wrap { position: relative; }
[data-theme-root="tim"] .tim-add { width: 34px; height: 34px; border: none; border-radius: 10px; background: #fff; color: var(--tim-text-1); font-size: 22px; line-height: 1; cursor: pointer; box-shadow: 0 1px 4px rgba(17, 24, 39, 0.1); }
[data-theme-root="tim"] .tim-add-menu { position: absolute; right: 0; top: 40px; width: 190px; background: #fff; border-radius: 12px; box-shadow: 0 8px 28px rgba(17, 24, 39, 0.16); padding: 6px; z-index: 20; }
[data-theme-root="tim"] .tim-add-menu button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 10px; border: none; background: transparent; border-radius: 8px; font-size: 13px; color: var(--tim-text-1); text-align: left; cursor: pointer; }
[data-theme-root="tim"] .tim-add-menu button:hover { background: #F3F7FA; }

[data-theme-root="tim"] .tim-search-wrap { padding: 0 16px 8px; }
[data-theme-root="tim"] .tim-search { width: 100%; height: 34px; padding: 0 12px; border: none; border-radius: 10px; background: rgba(229, 231, 235, 0.7); font-size: 13px; color: var(--tim-text-1); outline: none; }
[data-theme-root="tim"] .tim-list-meta-line { padding: 6px 16px 8px; font-size: 12.5px; color: var(--tim-text-3); border-bottom: 1px solid rgba(229, 231, 235, 0.7); }

[data-theme-root="tim"] .tim-list-body { flex: 1; min-height: 0; overflow-y: auto; }
[data-theme-root="tim"] .tim-list-item { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: none; background: transparent; text-align: left; cursor: pointer; }
[data-theme-root="tim"] .tim-list-item:hover { background: rgba(229, 231, 235, 0.5); }
[data-theme-root="tim"] .tim-list-main { flex: 1; min-width: 0; }
[data-theme-root="tim"] .tim-list-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
[data-theme-root="tim"] .tim-list-name { flex: 1; min-width: 0; font-size: 16px; font-weight: 600; color: var(--tim-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="tim"] .tim-list-time { flex: none; font-size: 11.5px; color: var(--tim-text-3); }
[data-theme-root="tim"] .tim-list-summary { display: block; margin-top: 2px; font-size: 13.5px; color: var(--tim-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ===== 通讯录（折叠分组）===== */
[data-theme-root="tim"] .tim-contacts { background: #fff; }
[data-theme-root="tim"] .tim-contacts-body { flex: 1; min-height: 0; overflow-y: auto; }
[data-theme-root="tim"] .tim-contact-tabs { display: flex; gap: 22px; padding: 0 16px 10px; border-bottom: 1px solid #F1F2F4; font-size: 14px; color: var(--tim-text-2); }
[data-theme-root="tim"] .tim-contact-tab { position: relative; padding-bottom: 4px; }
[data-theme-root="tim"] .tim-contact-tab-active { color: var(--tim-text-1); font-weight: 600; }
[data-theme-root="tim"] .tim-contact-tab-active::after { content: ""; position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); width: 16px; height: 2px; border-radius: 2px; background: var(--tim-primary); }
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
[data-theme-root="tim"] .tim-tab { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 72px; padding: 0; border: none; background: transparent; color: var(--tim-text-3); font-size: 10.5px; cursor: pointer; }
[data-theme-root="tim"] .tim-tab[aria-selected="true"] { color: var(--tim-primary); font-weight: 600; }

/* ===== 悬浮球：品牌蓝渐变圆球 ===== */
[data-theme-root="tim"] .tim-ball { position: relative; width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; cursor: grab; touch-action: none; background: linear-gradient(145deg, #4FC9F8, var(--tim-primary) 55%, var(--tim-primary-deep)); box-shadow: 0 10px 24px rgba(18, 183, 245, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.4); transition: transform 0.16s ease, box-shadow 0.16s ease; }
[data-theme-root="tim"] .tim-ball:hover { transform: translateY(-2px) scale(1.03); }
[data-theme-root="tim"] .tim-ball-target { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 50%; font-size: 18px; font-weight: 700; }
[data-theme-root="tim"] .tim-ball-target img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
[data-theme-root="tim"] .tim-ball::after { content: ""; position: absolute; right: 2px; bottom: 2px; width: 11px; height: 11px; border-radius: 50%; background: #22C55E; border: 2px solid #fff; }

/* ===== 面板：深色标题条（1.html 的 gray-900）===== */
[data-theme-root="tim"] .tim-panel { width: 320px; border-radius: 12px; overflow: hidden; background: #fff; box-shadow: 0 18px 44px rgba(17, 24, 39, 0.34); border: 1px solid var(--tim-line); font: 13px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif; color: var(--tim-text-1); }
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

/* 双轨过渡期：legacy 仍负责 store 装配（M7 才拆走），但它的界面必须完全不可见——
 * 漏隐藏主窗口会出现「同一界面渲染两遍」（实测：data-view 同时有 list/contacts/profile/chat 四份）。 */
html[data-dmt-theme] .team-app,
html[data-dmt-theme] .float-dock,
html[data-dmt-theme] .float-panel,
html[data-dmt-theme] .float-recall,
html[data-dmt-theme] .toast,
html[data-dmt-theme] .modal-mask {
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
  meta: { id: 'tim', name: 'TIM 经典蓝', contractVersion: 1 },
  styles: TIM_STYLES,
  Root: function TimRoot() {
    return (
      <div data-theme-root="tim" className="tim-theme-root">
        <DockLayer />
        <MainWindow />
      </div>
    );
  },
});

export { attachStore as __attachStore } from '../theme-sdk/index';
