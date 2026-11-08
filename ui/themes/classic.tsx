// classic.tsx —— classic 主题：**一个文件就是一套完整界面**（结构 + 视觉 + 样式）。
//
// 为什么是单文件（docs/22 §六「单文件主题规格」）：主题作者只打开这一个文件就能改完整界面，
// 不需要在 base/ 与 skins/ 之间来回跳。行为逻辑（几何、文案、列表规则、状态桥）从 ui/theme-sdk 拿，
// 那些是「两套主题必须一致」的部分，放在 SDK 里才有唯一实现（S-3 的结构保证）。
//
// 本主题对应现状外观（对照组）：令牌逐值取自 ui/css/layout.css:5-24，不做「更好看」的改动。
// data-theme-root 必须写**字面量**：构建期靠它核对主题 id（scripts/build-theme.mjs）。

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  actions,
  defineTheme,
  formatSessionLine,
  formatTargetLabel,
  targetSourceHint,
  buildPanelFields,
  buildListItemView,
  clampDockPosition,
  computeOpenDir,
  computePanelPosition,
  defaultAnchor,
  filterGroups,
  measureSize,
  readViewSize,
  resolveCountText,
  resolveListStatus,
  shouldStartDrag,
  tabKeyOf,
  titleOf,
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
  type ListItemView,
  type PanelField,
  type Point,
  type Size,
} from '../theme-sdk/index';

// ---------------------------------------------------------------- 视觉小件

/** 头像：URL 用 <img>，其余用首字母牌（与 ui/js/view/render.js 的 renderAvatar 同规则） */
function Avatar({ avatar, fallbackName }: { avatar: unknown; fallbackName: unknown }) {
  const rawValue = String(avatar == null ? '' : avatar).trim();
  const isImageUrl = /^https?:\/\//i.test(rawValue) || /^data:/i.test(rawValue);
  const initial = String(fallbackName == null ? '' : fallbackName).trim().charAt(0).toUpperCase() || '?';
  if (isImageUrl) return <img src={rawValue} alt="" loading="lazy" />;
  return <span className="cl-ball-initial">{rawValue || initial}</span>;
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 5.5h16v10.5H9l-5 4z" strokeLinejoin="round" />
    </svg>
  );
}

function ContactsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" strokeLinecap="round" />
      <path d="M16 7.5a3 3 0 0 1 0 5.6M17.5 19c0-2.2-.9-3.9-2.4-4.8" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.5 20c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5" strokeLinecap="round" />
    </svg>
  );
}

/** 面板一行：title 是值的身份（D-6），hint 是值的补充说明（来源提示），都按「有才渲染」处理 */
function PanelRow({ field }: { field: PanelField }) {
  const titleAttribute = field.title && field.title.length > 0 ? field.title : undefined;
  return (
    <div className="cl-panel-row">
      <span className="cl-panel-key">{field.label}</span>
      <span className="cl-panel-value" title={titleAttribute}>
        {field.value}
        {field.hint ? <span className="cl-panel-hint">{field.hint}</span> : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- L0 + L1：悬浮球与面板

function DockLayer() {
  const { snapshot, bridge } = useDockState();
  const [panelOpen, setPanelOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<Point | null>(null);
  const ballRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragContextRef = useRef<{ startX: number; startY: number; startLeft: number; startTop: number; panelWasOpen: boolean; moved: boolean } | null>(null);

  const groups = useGroups() as Array<{ id: string; name: string; avatar?: unknown }>;
  const friendGroups = useFriendGroups() as Array<{ id?: unknown; name?: unknown }>;
  const session = useSession();
  const target = useTarget();
  const stats = useStats() as { rate?: string; global?: { text?: string } };
  const view = useView();

  const activeGroup = groups.find((group) => group.id === view.currentGroupId);
  const sessionLine = formatSessionLine(session.sessionId, session.sessionTitle);
  const targetLabel = formatTargetLabel(target.effectiveTarget, friendGroups);
  const fields = buildPanelFields({
    groupName: activeGroup ? activeGroup.name : '',
    sessionText: sessionLine.text,
    sessionTitle: sessionLine.title,
    targetLabel,
    // 显式绑定过就不提示（提示的含义是「你没绑，我替你回落的」）
    targetSourceHintText: target.target ? '' : targetSourceHint(target.targetSource),
    rate: stats.rate,
    globalText: stats.global && stats.global.text,
  });

  const ballSize = measureSize(ballRef.current, { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX });
  const viewSize = readViewSize();
  const anchor = snapshot && snapshot.anchor ? snapshot.anchor : defaultAnchor(ballSize, viewSize);
  const ballPosition = dragOffset || clampDockPosition(anchor.left, anchor.top, ballSize, viewSize);
  const openDir = snapshot ? snapshot.openDir : computeOpenDir({ ...ballPosition, ...ballSize }, viewSize);
  const panelPosition = computePanelPosition({ ...ballPosition, ...ballSize }, measureSize(panelRef.current, PANEL_FALLBACK_SIZE as Size), openDir, viewSize);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // 只记录「按下时面板是否打开」，不在这里收起（否则点球永远只能展开，F-01）
    event.preventDefault();
    dragContextRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: ballPosition.left,
      startTop: ballPosition.top,
      panelWasOpen: panelOpen,
      moved: false,
    };
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // 指针捕获失败不影响拖动（部分宿主/预览环境不支持）
    }
  }, [ballPosition.left, ballPosition.top, panelOpen]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const context = dragContextRef.current;
    if (!context) return;
    const deltaX = event.clientX - context.startX;
    const deltaY = event.clientY - context.startY;
    if (!context.moved) {
      if (!shouldStartDrag(deltaX, deltaY)) return;
      context.moved = true;
      setDragging(true);
      // 真进入拖动才收起面板：球动而面板停在原地会显得「拖不动」
      if (context.panelWasOpen) setPanelOpen(false);
    }
    // 拖动每帧都夹取：不夹的话球能被拖到视口外，落盘后刷新也找不回来
    setDragOffset(clampDockPosition(context.startLeft + deltaX, context.startTop + deltaY, ballSize, readViewSize()));
  }, [ballSize]);

  const finishDrag = useCallback(() => {
    const context = dragContextRef.current;
    if (!context) return;
    dragContextRef.current = null;
    setDragging(false);
    if (!context.moved) {
      // 没超过阈值 = 点击：按「按下时」的状态切换（两个方向都能切，F-01）
      setPanelOpen(!context.panelWasOpen);
      return;
    }
    const rawPosition = dragOffset || { left: context.startLeft, top: context.startTop };
    const committed = clampDockPosition(rawPosition.left, rawPosition.top, measureSize(ballRef.current, ballSize), readViewSize());
    setDragOffset(null);
    if (!bridge) return;
    bridge.setDockAnchor({ left: Math.round(committed.left), top: Math.round(committed.top) });
    // 松手才重算方向：拖动中算会让文本在球的左右来回跳
    bridge.setDockOpenDir(computeOpenDir({ ...committed, ...measureSize(ballRef.current, ballSize) }, readViewSize()));
  }, [ballSize, bridge, dragOffset]);

  useEffect(() => {
    if (bridge) bridge.setDockShape(panelOpen ? 'panel' : 'ball');
  }, [bridge, panelOpen]);

  // 显隐只由 INV-14（dock-state 工厂）决定：判不了或不是本插件的会话就什么都不画
  if (!snapshot || !snapshot.visible) return null;

  const platformName = activeGroup && typeof activeGroup.name === 'string' ? activeGroup.name : '';
  const accessibleLabel = platformName ? `${targetLabel} · ${platformName}` : targetLabel;

  return (
    <>
      <div
        ref={ballRef}
        className="dmt-ball-anchor"
        data-open-dir={openDir}
        style={{ position: 'fixed', left: `${ballPosition.left}px`, top: `${ballPosition.top}px`, transition: dragging ? 'none' : 'transform 220ms cubic-bezier(.16,1,.3,1)' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        {/* 球内只放平台头像/首字母：不放文字，F-06（文字撑破球体）从设计上消失 */}
        <div
          className="cl-ball"
          role="button"
          tabIndex={0}
          data-fb-target=""
          title={accessibleLabel}
          aria-label={accessibleLabel}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setPanelOpen(true);
            }
          }}
        >
          <span className="cl-ball-target"><Avatar avatar={activeGroup ? activeGroup.avatar : null} fallbackName={platformName} /></span>
        </div>
      </div>

      {panelOpen ? (
        <section
          ref={panelRef}
          className="cl-panel"
          role="dialog"
          aria-label="我的模型团队"
          style={{ position: 'fixed', left: `${panelPosition.left}px`, top: `${panelPosition.top}px` }}
        >
          <header className="cl-panel-head">
            <button type="button" className="cl-panel-title" onClick={() => { actions.openView('db'); setPanelOpen(false); }}>👤 我的模型团队</button>
            <span className="cl-panel-model">{`模型 ${targetLabel}`}</span>
            <span className="cl-panel-ops">
              {/* 只有「—」收起面板：球不提供关闭入口（显隐 = INV-14） */}
              <button type="button" className="cl-panel-op" onClick={() => setPanelOpen(false)} aria-label="收起面板" title="收起面板">—</button>
            </span>
          </header>
          <div className="cl-panel-body">
            {fields.map((field) => <PanelRow key={field.key} field={field} />)}
          </div>
          <footer className="cl-panel-foot">
            <button type="button" className="cl-panel-enter" onClick={() => setPanelOpen(false)}>进入群聊界面 &gt;</button>
          </footer>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- L2：主窗口（消息列表 + 三 tab）

function ListView() {
  const groups = useGroups() as Array<{ id?: unknown; name?: unknown; avatar?: unknown; summary?: unknown; driver?: unknown; lastUpdated?: unknown }>;
  const loadError = useGroupsError();
  const view = useView();
  const [keyword, setKeyword] = useState('');

  const visibleGroups = filterGroups(groups, keyword);
  const status = resolveListStatus(groups, loadError);
  const searchMissed = status === 'loaded' && visibleGroups.length === 0;

  return (
    <section className="cl-view cl-view-list" data-view="list">
      <div className="cl-list-head">
        <h2 className="cl-list-title">消息</h2>
        {/* 搜索框不无条件 focus（F-02）：这里从不调用 focus()，重渲染时 React 自己保住已有焦点 */}
        <input
          className="cl-group-search"
          type="search"
          autoComplete="off"
          placeholder="🔍 搜索群聊 (账号)"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <span className={status === 'load-failed' ? 'cl-list-count cl-list-count-error' : 'cl-list-count'}>
          {resolveCountText(status, groups.length)}
        </span>
        <button type="button" className="cl-btn-add" onClick={() => actions.openView('add')}>＋ 加群</button>
      </div>

      {status === 'load-failed' ? (
        <div className="cl-list-error" role="alert">
          <div className="cl-list-error-title">群列表加载失败</div>
          <div className="cl-list-error-detail">{loadError}</div>
          <button type="button" className="cl-btn-retry" onClick={() => actions.loadGroups()}>点此重试</button>
        </div>
      ) : null}

      {status === 'empty' ? <EmptyState text="还没有群，点右上角「＋ 加群」接入一个平台" /> : null}
      {searchMissed ? <EmptyState text={`没有匹配「${keyword}」的群`} /> : null}

      {status === 'loaded' && visibleGroups.length > 0 ? (
        <ul className="cl-group-list">
          {visibleGroups.map((group) => {
            const groupId = group.id == null ? '' : String(group.id);
            const item: ListItemView = buildListItemView(group, view.currentGroupId, () => actions.openView('chat', groupId));
            return (
              <li key={groupId}>
                <button type="button" className={item.active ? 'cl-list-item cl-list-item-active' : 'cl-list-item'} onClick={item.onClick}>
                  <span className="cl-avatar"><Avatar avatar={item.avatar} fallbackName={item.title} /></span>
                  <span className="cl-list-main">
                    <span className="cl-list-line"><span className="cl-list-name">{item.title}</span></span>
                    {/* 空串 = 不渲染副标题（D-4）：判空在 SDK 里做完，这里只管画不画 */}
                    {item.subtitle ? <span className="cl-list-summary">{item.subtitle}</span> : null}
                  </span>
                  {item.meta ? <span className="cl-list-meta">{item.meta}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="cl-empty">
      <div className="cl-empty-text">{text}</div>
    </div>
  );
}

function TabBar() {
  const view = useView();
  const activeTab = tabKeyOf(view.view);
  return (
    <nav className="cl-tabbar" role="tablist">
      {TAB_ITEMS.map((tab) => {
        const selected = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className="cl-tab"
            aria-selected={selected}
            onClick={() => actions.openView(tab.view as never)}
          >
            {tab.key === 'messages' ? <ChatIcon /> : tab.key === 'contacts' ? <ContactsIcon /> : <ProfileIcon />}
            <span className="cl-tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------- L2：群聊页

/** 请求卡片的状态色（与 legacy statusClass 同口径：2xx 成功绿、429 限流橙、其余失败红） */
function statusClassOf(status: unknown): string {
  const numericStatus = Number(status);
  if (Number.isFinite(numericStatus) && numericStatus >= 200 && numericStatus < 300) return 'cl-st cl-st-ok';
  if (numericStatus === 429) return 'cl-st cl-st-warn';
  return 'cl-st cl-st-err';
}

/** 群友数三态：未加载 —、已加载 N、失败「加载失败」（D-3；三者必须互相可区分） */
function memberCountText(modelsStatus: string, modelCount: number): string {
  if (modelsStatus === 'error') return '加载失败';
  if (modelsStatus === 'loading' || modelsStatus === '' || modelsStatus === undefined) return '—';
  return String(modelCount);
}

function RequestCard({ row, expanded, onToggle }: { row: Record<string, unknown>; expanded: boolean; onToggle: () => void }) {
  const text = (value: unknown) => (value == null || value === '' ? '—' : String(value));
  const modelName = text(row.model).replace(/^global:/, '');
  const hint = targetSourceHint(row.targetSource);
  return (
    <div className="msg msg-left">
      <span className="avatar" title={`@${modelName}`}><Avatar avatar={null} fallbackName={modelName} /></span>
      <div
        className={expanded ? 'bubble cl-req expanded' : 'bubble cl-req'}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={text(row.title)}
        onClick={onToggle}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }}
      >
        <div className="cl-req-head">
          <span className="cl-req-model">{modelName}</span>
          {hint ? <span className="cl-req-source">{hint}</span> : null}
          <span className="cl-req-time">{text(row.time)}</span>
          <span className="cl-req-caret" aria-hidden="true" />
        </div>
        <div className="cl-req-meta">
          <span className={statusClassOf(row.status)}>{text(row.status)} {text(row.statusText)}</span>
          <span>{text(row.latency)}</span><span className="cl-sep">·</span>
          <span>{text(row.tokens)} tok</span><span className="cl-sep">·</span>
          <span>{text(row.credit)} credit</span><span className="cl-sep">·</span>
          <span>命中 {text(row.cacheHit)}</span>
        </div>
        {expanded ? (
          <div className="cl-req-detail">
            <span className="k">状态</span><span className="v">{text(row.status)} {text(row.statusText)}</span>
            <span className="k">模型</span><span className="v">{text(row.model)}</span>
            {/* claimedReason：只有失败被上游错误认领时才有（D-2 决策：展开态纯文本，不高亮） */}
            {row.claimedReason ? <><span className="k">认领依据</span><span className="v">{text(row.claimedReason)}</span></> : null}
            {/* targetSource：只有「后端回落」三值才显示中文提示，显式绑定不显示 */}
            {hint ? <><span className="k">目标来源</span><span className="v">{text(row.targetSource)} {hint}</span></> : null}
            <span className="k">账号</span><span className="v">{text((row.account as { name?: string } | undefined)?.name)}</span>
            <span className="k">来源 IP</span><span className="v">{text(row.ip)}</span>
            <span className="k">User-Agent</span><span className="v">{text(row.ua)}</span>
            <span className="k">耗时</span><span className="v">{text(row.latency)}</span>
            <span className="k">token</span><span className="v">{text(row.tokens)}</span>
            <span className="k">credit</span><span className="v">{text(row.credit)}</span>
            <span className="k">命中率</span><span className="v">{text(row.cacheHit)}</span>
            <span className="k">req-id</span><span className="v">{text(row.requestId)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChatPage({ groupId }: { groupId: string }) {
  const groups = useGroups() as Array<{ id: string; name: string; avatar?: unknown }>;
  const friendGroups = useFriendGroups() as Array<{ id?: unknown; name?: unknown }>;
  const chat = useChat(groupId) as { messages?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>>; modelsStatus?: string };
  const [draft, setDraft] = useState('');
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [atOpen, setAtOpen] = useState(false);
  const group = groups.find((item) => item.id === groupId);
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const models = Array.isArray(chat.models) ? chat.models : [];

  return (
    <section className="view view-chat" data-view="chat">
      <header className="view-head chat-head">
        <button type="button" className="btn-back" onClick={() => actions.openView('list')}>&lt; 返回</button>
        <span className="head-title">{group ? group.name : ''}</span>
        <span className="group-tag">[群友: {memberCountText(String(chat.modelsStatus || ''), models.length)}]</span>
        <span className="head-sub">群友 = 模型 · 消息 = 请求记录</span>
      </header>
      <div className="chat-stream">
        {messages.length === 0 ? <div className="cl-empty-text">还没有请求记录</div> : null}
        {messages.map((message, index) => {
          const type = String(message.type || '');
          if (type === 'sys') return <div key={index} className="msg msg-sys"><span className="sys-tip">[系统] {String(message.text || '')}</span></div>;
          if (type === 'row') {
            const rowIndex = Number(message.rowIndex ?? index);
            return (
              <RequestCard
                key={index}
                row={(message.row || {}) as Record<string, unknown>}
                expanded={Boolean(expandedRows[rowIndex])}
                onToggle={() => setExpandedRows((previous) => ({ ...previous, [rowIndex]: !previous[rowIndex] }))}
              />
            );
          }
          return (
            <div key={index} className="msg msg-right">
              <span className="avatar round">[我]</span>
              <div className="bubble">{String(message.text || '')}</div>
            </div>
          );
        })}
      </div>
      {atOpen ? (
        <div className="at-pop">
          <div className="at-pop-title">选择群友（单模型）或好友分组（轮换组）—— 发送后切换当前目标</div>
          <div className="at-section">本群群友</div>
          {models.length === 0 ? <div className="cl-empty-text">没有群友</div> : null}
          {models.map((model) => (
            <button key={String(model.id)} type="button" className="at-item" onClick={() => { actions.switchTarget({ type: 'model', id: String(model.id) }); setAtOpen(false); }}>
              <span className="avatar at-avatar">{String(model.name || model.id).charAt(0)}</span>
              <span className="at-model">{String(model.name || model.id)}</span>
            </button>
          ))}
          <div className="at-section">我的好友分组</div>
          {friendGroups.length === 0 ? <div className="cl-empty-text">还没有分组</div> : null}
          {friendGroups.map((friendGroup) => (
            <button key={String(friendGroup.id)} type="button" className="at-item" onClick={() => { actions.switchTarget({ type: 'group', id: String(friendGroup.id) }); setAtOpen(false); }}>
              <span className="avatar at-avatar">👥</span>
              <span className="at-model">{String(friendGroup.name || friendGroup.id)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <footer className="chat-input">
        <button type="button" className="btn-at" onClick={() => setAtOpen((open) => !open)} title="选择群友或分组">@</button>
        <textarea
          id="msgInput"
          rows={1}
          value={draft}
          placeholder="@ 选择群友或分组…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && draft.trim()) {
              event.preventDefault();
              actions.sendMessage(draft.trim());
              setDraft('');
            }
          }}
        />
        <button type="button" className="btn-send" onClick={() => { if (draft.trim()) { actions.sendMessage(draft.trim()); setDraft(''); } }}>发送</button>
      </footer>
    </section>
  );
}

function MainWindow() {
  const view = useView();
  return (
    <div className="cl-app">
      <header className="cl-topbar">
        <span className="cl-logo">团队</span>
        <span className="cl-topbar-title">{titleOf(view.view)}</span>
      </header>
      <div className="cl-main-body">
        {view.view === 'list' ? <ListView /> : null}
        {view.view === 'chat' ? <ChatPage groupId={view.currentGroupId} /> : null}
        {view.view === 'add' || view.view === 'db' ? <EmptyState text="该页面将在下一阶段迁移" /> : null}
        {view.view === 'contacts' ? <EmptyState text="通讯录（好友分组）将在下一阶段迁移" /> : null}
        {view.view === 'profile' ? <EmptyState text="「我」页（导入/导出）将在下一阶段迁移" /> : null}
      </div>
      <TabBar />
    </div>
  );
}

// ---------------------------------------------------------------- 主题定义

const CLASSIC_STYLES = `/* tokens.css —— classic skin 的设计令牌（对照组规格）。
 *
 * 来源：ui/css/layout.css:5-24 的 --team-* 变量，逐值照抄（docs/25 §十一 的对照表）。
 * 为什么照抄而不重新设计：classic 的验收口径是「与现状视觉等价」，
 * 自制更好看的颜色/圆角一律算缺陷（用户比对时会当作回归）。
 *
 * 命名空间：全部限定在 [data-theme-root="classic"] 之下，避免污染宿主与另一套 skin。
 * 变量名保留 --team-* 前缀：迁移期两套并存，同名变量让逐项对照变容易。
 */

[data-theme-root="classic"] {
  /* 主窗口尺寸（契约条款 26：宽高各由变量控制） */
  --team-window-width: min(760px, 92vw);
  --team-window-height: min(540px, 86vh);

  /* 主色三档 */
  --team-blue: #12a7f5;
  --team-blue-deep: #0b8bd0;
  --team-blue-soft: #e8f5ff;

  /* 文字三级 + 分隔线 + 底色 */
  --team-text: #1f2329;
  --team-text-2: #6b7785;
  --team-text-3: #9aa6b2;
  --team-line: #e6ebf0;
  --team-bg: #f5f8fb;
  --team-white: #ffffff;

  /* 语义色 */
  --team-green: #20b26c;
  --team-orange: #f0a020;
  --team-red: #e8513d;

  /* 形状与投影 */
  --team-radius: 10px;
  --team-shadow: 0 10px 30px rgba(16, 58, 96, 0.14);
  --team-shadow-lg: 0 18px 48px rgba(16, 58, 96, 0.22);
}

/* 悬浮球：蓝渐变圆球 + 白字，尺寸与旧实现一致（56px） */
[data-theme-root="classic"] .cl-ball {
  position: relative;
  width: 56px;
  height: 56px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: grab;
  touch-action: none;              /* 触屏下别让浏览器把手势当成滚动 */
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.05em;
  background: linear-gradient(145deg, #38bdf8, var(--team-blue) 55%, var(--team-blue-deep));
  box-shadow: 0 10px 22px rgba(12, 122, 186, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.45);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

[data-theme-root="classic"] .cl-ball:hover {
  transform: translateY(-2px) scale(1.03);
  box-shadow: 0 14px 28px rgba(12, 122, 186, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

/* 球内目标标：容器撑满球心并裁掉溢出 —— F-06（文字撑破球体）的验收口径是
   scrollWidth <= clientWidth，所以这里必须 overflow: hidden + 绝对定位铺满 */
[data-theme-root="classic"] .cl-ball-target {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  font-size: 18px;
  line-height: 1;
}

[data-theme-root="classic"] .cl-ball-target img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

[data-theme-root="classic"] .cl-ball-initial {
  text-transform: uppercase;
  text-shadow: 0 1px 2px rgba(6, 55, 84, 0.35);
}

/* 面板：白卡 + 浅蓝标题条 + 大投影（与旧 .float-panel 同口径） */
[data-theme-root="classic"] .cl-panel {
  width: 384px;
  border-radius: 12px;
  background: var(--team-white);
  border: 1px solid var(--team-line);
  box-shadow: var(--team-shadow-lg);
  overflow: hidden;
  font: 14px/1.6 "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif;
  color: var(--team-text);
}

[data-theme-root="classic"] .cl-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: linear-gradient(120deg, #eaf7ff, #f7fbff);
  border-bottom: 1px solid var(--team-line);
  cursor: move;
  user-select: none;
  touch-action: none;
}

[data-theme-root="classic"] .cl-panel-title { font-weight: 600; font-size: 13px; }

[data-theme-root="classic"] .cl-panel-model {
  margin-left: auto;
  font-size: 12px;
  color: var(--team-text-2);
  font-family: "JetBrains Mono", Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}

[data-theme-root="classic"] .cl-panel-body { padding: 12px 14px; }

[data-theme-root="classic"] .cl-panel-row {
  display: flex;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
}

[data-theme-root="classic"] .cl-panel-key { color: var(--team-text-2); flex: none; }

[data-theme-root="classic"] .cl-panel-value {
  color: var(--team-text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-theme-root="classic"] .cl-panel-foot { padding: 0 14px 12px; }

[data-theme-root="classic"] .cl-panel-enter {
  width: 100%;
  padding: 9px 0;
  border: 1px solid rgba(18, 167, 245, 0.4);
  border-radius: 8px;
  background: linear-gradient(120deg, #eaf7ff, #f4fbff);
  color: var(--team-blue-deep);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

[data-theme-root="classic"] .cl-panel-enter:hover {
  background: linear-gradient(120deg, #dcf1ff, #eef9ff);
}

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

/* 标题条：左侧标题按钮（点击进数据库页）+ 中间模型标签 + 右侧收起/关闭。
   与旧 .fp-title-btn / .fp-model / .fp-ops 同口径（layout.css 的悬浮面板段）。 */
[data-theme-root="classic"] .cl-panel-title {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}

[data-theme-root="classic"] .cl-panel-title:hover:not(:disabled) { color: var(--team-blue-deep); }
[data-theme-root="classic"] .cl-panel-title:disabled { cursor: default; }

[data-theme-root="classic"] .cl-panel-ops {
  display: flex;
  gap: 2px;
  flex: none;
}

[data-theme-root="classic"] .cl-panel-op {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--team-text-2);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

[data-theme-root="classic"] .cl-panel-op:hover:not(:disabled) { background: rgba(18, 167, 245, 0.14); color: var(--team-blue-deep); }
[data-theme-root="classic"] .cl-panel-op:disabled { opacity: 0.45; cursor: default; }

/* 值的补充说明（目标来源提示）：浅色小字紧跟在值后面，不抢目标名。
   旧实现是 <span class="fp-target-source">，这里保持同样的视觉位置。 */
[data-theme-root="classic"] .cl-panel-hint {
  margin-left: 4px;
  color: var(--team-text-3);
  font-weight: 400;
  font-size: 11px;
}

/* ---------------------------------------------------------------- L2 主窗口 */
/* 外壳：白底圆角浮窗 + 柔和投影，尺寸由变量控制（条款 10：min(760px,92vw) × min(540px,86vh)） */
[data-theme-root="classic"] .cl-app {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: var(--team-window-width);
  height: var(--team-window-height);
  display: flex;
  flex-direction: column;
  background: var(--team-white);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 14px;
  box-shadow: var(--team-shadow-lg);
  overflow: hidden;
  font: 14px/1.6 "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif;
  color: var(--team-text);
}

/* 顶栏：团队标识 + 当前视图名（条款 8：只保留这两样 + 收起；收起语义待定，M4 先不放） */
[data-theme-root="classic"] .cl-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  padding: 0 14px;
  flex: none;
  background: linear-gradient(120deg, #f2f9ff, #ffffff);
  border-bottom: 1px solid var(--team-line);
}

[data-theme-root="classic"] .cl-logo {
  padding: 2px 8px;
  border-radius: 6px;
  background: linear-gradient(145deg, #38bdf8, var(--team-blue-deep));
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

[data-theme-root="classic"] .cl-topbar-title { font-size: 14px; font-weight: 600; }
[data-theme-root="classic"] .cl-topbar-actions { margin-left: auto; }

/* 内容区：内部滚动；底栏固定不滚动（条款 9） */
[data-theme-root="classic"] .cl-main-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--team-bg);
}

[data-theme-root="classic"] .cl-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* 列表头：标题 + 搜索 + 计数 + 加群（条款 11：不设「我」入口，从底边栏进） */
[data-theme-root="classic"] .cl-list-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  padding: 12px 16px 8px;
}

[data-theme-root="classic"] .cl-list-title { margin: 0; font-size: 15px; font-weight: 700; }

[data-theme-root="classic"] .cl-group-search {
  flex: 1;
  min-width: 120px;
  max-width: 280px;
  padding: 6px 12px;
  border: 1px solid var(--team-line);
  border-radius: 999px;
  background: #fff;
  font-size: 12px;
  color: var(--team-text);
  outline: none;
}

[data-theme-root="classic"] .cl-group-search:focus { border-color: rgba(18, 167, 245, 0.55); }

[data-theme-root="classic"] .cl-list-count { font-size: 12px; color: var(--team-text-3); }
[data-theme-root="classic"] .cl-list-count-error { color: var(--team-red); font-weight: 600; }

[data-theme-root="classic"] .cl-btn-add {
  margin-left: auto;
  padding: 6px 14px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(12, 122, 186, 0.28);
}

/* 群列表：每行一个「会话」（= 平台账号） */
[data-theme-root="classic"] .cl-group-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 4px 10px 14px;
}

[data-theme-root="classic"] .cl-list-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease;
}

[data-theme-root="classic"] .cl-list-item:hover { background: #fff; box-shadow: 0 2px 10px rgba(16, 58, 96, 0.06); }
[data-theme-root="classic"] .cl-list-item-active { background: var(--team-blue-soft); }

[data-theme-root="classic"] .cl-avatar {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: linear-gradient(145deg, #e8f5ff, #d4ecff);
  color: var(--team-blue-deep);
  font-size: 13px;
  font-weight: 700;
}

[data-theme-root="classic"] .cl-avatar img { width: 100%; height: 100%; object-fit: cover; }

/* 关键：min-width: 0 是「超长文本能省略」的前提，缺了它 flex 子项不会收缩（F-06 同类教训） */
[data-theme-root="classic"] .cl-list-main { flex: 1; min-width: 0; }
[data-theme-root="classic"] .cl-list-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }

[data-theme-root="classic"] .cl-list-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-theme-root="classic"] .cl-list-summary {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--team-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-theme-root="classic"] .cl-list-meta {
  flex: none;
  align-self: flex-start;
  font-size: 11px;
  color: var(--team-text-3);
  font-variant-numeric: tabular-nums;
}

/* 加载失败块：与「确实没有群」必须看起来不同（失败要能重试，空要能加群） */
[data-theme-root="classic"] .cl-list-error {
  margin: 16px;
  padding: 18px;
  border: 1px solid rgba(248, 113, 113, 0.45);
  border-radius: 10px;
  background: rgba(248, 113, 113, 0.08);
  text-align: center;
}

[data-theme-root="classic"] .cl-list-error-title { font-size: 13px; font-weight: 600; color: #f87171; }
[data-theme-root="classic"] .cl-list-error-detail { margin-top: 6px; font-size: 11px; color: var(--team-text-3); word-break: break-all; }

[data-theme-root="classic"] .cl-btn-retry {
  margin-top: 12px;
  padding: 6px 14px;
  border: 1px solid var(--team-line);
  border-radius: 8px;
  background: transparent;
  color: var(--team-text);
  font-size: 12px;
  cursor: pointer;
}

/* 空态：居中灰字 */
/* 群聊：消息流 + 请求卡片（取值同 ui/css/views.css 的 .chat-stream/.req-* 段） */
[data-theme-root="classic"] .chat-stream { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 6px; display: flex; flex-direction: column; gap: 12px; }
[data-theme-root="classic"] .msg { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; }
[data-theme-root="classic"] .msg-left { justify-content: flex-start; }
[data-theme-root="classic"] .msg-right { justify-content: flex-end; }
[data-theme-root="classic"] .msg-right .avatar { order: 2; }
[data-theme-root="classic"] .msg-sys { justify-content: center; }
[data-theme-root="classic"] .sys-tip { align-self: center; padding: 3px 10px; border-radius: 999px; background: rgba(31, 35, 41, 0.06); color: var(--team-text-3); font-size: 11.5px; }
[data-theme-root="classic"] .bubble { position: relative; max-width: min(78%, 620px); padding: 9px 12px; border-radius: 10px; font-size: 13px; line-height: 1.55; word-break: break-word; box-shadow: 0 2px 8px rgba(16, 58, 96, 0.06); }
[data-theme-root="classic"] .msg-left .bubble { background: #fff; border: 1px solid var(--team-line); border-top-left-radius: 3px; }
[data-theme-root="classic"] .msg-right .bubble { background: linear-gradient(135deg, #45c2fb, var(--team-blue-deep)); border: none; border-top-right-radius: 3px; color: #fff; }
[data-theme-root="classic"] .cl-req { cursor: pointer; transition: box-shadow 0.14s ease, transform 0.14s ease; }
[data-theme-root="classic"] .cl-req:hover { box-shadow: 0 6px 18px rgba(16, 58, 96, 0.12); transform: translateY(-1px); }
[data-theme-root="classic"] .cl-req-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
[data-theme-root="classic"] .cl-req-model { font-family: "JetBrains Mono", Consolas, monospace; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="classic"] .cl-req-source { flex: none; font-size: 11px; color: var(--team-text-3); }
[data-theme-root="classic"] .cl-req-time { margin-left: auto; flex: none; font-size: 11px; color: var(--team-text-3); font-variant-numeric: tabular-nums; }
[data-theme-root="classic"] .cl-req-caret { flex: none; width: 0; height: 0; margin-top: 2px; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid var(--team-text-3); }
[data-theme-root="classic"] .cl-req.expanded .cl-req-caret { border-top: none; border-bottom: 5px solid var(--team-blue-deep); }
[data-theme-root="classic"] .cl-req-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 3px; font-size: 11.5px; color: var(--team-text-2); }
[data-theme-root="classic"] .cl-sep { color: #cbd5df; }
[data-theme-root="classic"] .cl-st { flex: none; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
[data-theme-root="classic"] .cl-st-ok { background: rgba(32, 178, 108, 0.12); color: var(--team-green); }
[data-theme-root="classic"] .cl-st-warn { background: rgba(240, 160, 32, 0.14); color: #b5730a; }
[data-theme-root="classic"] .cl-st-err { background: rgba(232, 81, 61, 0.12); color: var(--team-red); }
[data-theme-root="classic"] .cl-req-detail { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--team-line); display: grid; grid-template-columns: 74px 1fr; gap: 4px 10px; font-size: 12px; }
[data-theme-root="classic"] .cl-req-detail .k { color: var(--team-text-3); }
[data-theme-root="classic"] .cl-req-detail .v { color: var(--team-text); font-family: "JetBrains Mono", Consolas, monospace; word-break: break-all; }
[data-theme-root="classic"] .chat-input { position: relative; flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #fff; border-top: 1px solid var(--team-line); }
[data-theme-root="classic"] .btn-at { flex: none; width: 32px; height: 32px; border: 1px solid var(--team-line); border-radius: 8px; background: #fff; color: var(--team-text-2); font-size: 14px; font-weight: 700; cursor: pointer; }
[data-theme-root="classic"] #msgInput { flex: 1; min-width: 0; height: 36px; max-height: 88px; padding: 9px 12px; border: 1px solid var(--team-line); border-radius: 8px; background: var(--team-bg); font-size: 13px; color: var(--team-text); outline: none; resize: none; }
[data-theme-root="classic"] .btn-send { flex: none; height: 36px; padding: 0 18px; border: none; border-radius: 8px; background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep)); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
[data-theme-root="classic"] .at-pop { position: absolute; left: 12px; bottom: 56px; width: min(320px, 70%); max-height: 320px; overflow-y: auto; padding: 6px; border-radius: 10px; background: #fff; border: 1px solid var(--team-line); box-shadow: var(--team-shadow); z-index: 20; }
[data-theme-root="classic"] .at-pop-title { padding: 4px 8px 6px; font-size: 11px; color: var(--team-text-3); }
[data-theme-root="classic"] .at-section { padding: 6px 8px 3px; font-size: 11px; color: var(--team-text-3); border-top: 1px solid var(--team-line); margin-top: 4px; }
[data-theme-root="classic"] .at-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: none; border-radius: 7px; background: transparent; cursor: pointer; font-size: 12.5px; text-align: left; }
[data-theme-root="classic"] .at-item:hover { background: var(--team-blue-soft); }
[data-theme-root="classic"] .at-avatar { width: 26px; height: 26px; border-radius: 7px; font-size: 11px; }
[data-theme-root="classic"] .at-model { font-family: "JetBrains Mono", Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-theme-root="classic"] .cl-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--team-text-3);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

/* 底边栏：三 tab，固定高度不滚动（条款 9），选中态用主题色 */
[data-theme-root="classic"] .cl-tabbar {
  flex: none;
  display: flex;
  height: 54px;
  border-top: 1px solid var(--team-line);
  background: #fff;
}

[data-theme-root="classic"] .cl-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--team-text-3);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: color 140ms ease;
}

[data-theme-root="classic"] .cl-tab:hover { color: var(--team-blue-deep); }
[data-theme-root="classic"] .cl-tab[aria-selected="true"] { color: var(--team-blue-deep); font-weight: 600; }
[data-theme-root="classic"] .cl-tab-label { font-size: 11px; }
`;

export default defineTheme({
  meta: { id: 'classic', name: '经典（现状外观）', contractVersion: 1 },
  styles: CLASSIC_STYLES,
  Root: function ClassicRoot() {
    return (
      <div data-theme-root="classic" className="dmt-theme-root">
        <DockLayer />
        <MainWindow />
      </div>
    );
  },
});

// 把 SDK 的 store 桥暴露给宿主：宿主要在挂载前把 store 接进**这个主题 bundle 里的** store-bridge 实例
// （同一份实例才有同一个版本号；宿主自己再 require 一次会得到另一个实例，界面永远不更新）。
export { attachStore as __attachStore } from '../theme-sdk/index';
