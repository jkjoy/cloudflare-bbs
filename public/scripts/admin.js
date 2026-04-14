import {
  $,
  api,
  avatarUrl,
  buildPager,
  escapeHtml,
  formatRelativeTime,
  roleBadge,
  showError,
} from './shared.js';

const sectionDefinitions = [
  { id: 'home', label: '首页', capability: 'accessAdmin' },
  { id: 'settings', label: '设置', capability: 'manageSettings' },
  { id: 'boards', label: '板块管理', capability: 'manageBoards' },
  { id: 'users', label: '会员管理', capability: 'manageUsers' },
  { id: 'posts', label: '帖子管理', capability: 'managePosts' },
  { id: 'recycle', label: '回收站', capability: 'manageRecycle' },
];

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const dom = {
  nav: $('#h'),
  sideUser: $('#u'),
  sideInfo: $('#link'),
  main: $('#m'),
};

const state = {
  bootstrap: null,
  section: 'home',
  summary: null,
  settings: null,
  boards: [],
  users: null,
  posts: null,
  recycleUsers: null,
  recyclePosts: null,
  backups: [],
  filters: {
    usersQ: '',
    usersPage: 1,
    postsQ: '',
    postsPage: 1,
    recycleUsersQ: '',
    recycleUsersPage: 1,
    recyclePostsQ: '',
    recyclePostsPage: 1,
  },
  selected: {
    users: new Set(),
    posts: new Set(),
    recycleUsers: new Set(),
    recyclePosts: new Set(),
  },
};

function capabilities() {
  return state.bootstrap?.currentUser?.capabilities || {};
}

function can(capability) {
  return Boolean(capabilities()[capability]);
}

function availableSections() {
  return sectionDefinitions.filter((item) => can(item.capability));
}

function defaultSectionId() {
  return availableSections()[0]?.id || 'home';
}

function isSectionAvailable(sectionId) {
  return availableSections().some((item) => item.id === sectionId);
}

init().catch(showError);

async function init() {
  state.bootstrap = await api('/api/public/bootstrap');
  if (!state.bootstrap.currentUser || !state.bootstrap.currentUser.capabilities?.accessAdmin) {
    location.href = '/';
    return;
  }
  state.section = getSectionFromHash();
  renderChrome();
  dom.main.addEventListener('submit', handleMainSubmit);
  dom.main.addEventListener('click', handleMainClick);
  dom.main.addEventListener('change', handleMainChange);
  dom.main.addEventListener('input', handleMainInput);
  window.addEventListener('hashchange', handleHashChange);
  await refreshSection();
}

async function handleHashChange() {
  const next = getSectionFromHash();
  if (next === state.section) return;
  state.section = next;
  clearAllSelections();
  await refreshSection();
}

function getSectionFromHash() {
  const raw = location.hash.replace(/^#/, '').trim();
  return isSectionAvailable(raw) ? raw : defaultSectionId();
}

function renderChrome() {
  const user = state.bootstrap.currentUser;
  dom.nav.innerHTML = `
    <a href="/admin.html" class="a">后台</a>
    <a href="/">前台</a>
  `;
  dom.sideUser.innerHTML = `
    <div class="side-card">
      <div class="user_link">
        <img class="avatar" src="${avatarUrl(user.avatarHash, 64)}" alt="${escapeHtml(user.username)}">
        ${escapeHtml(user.username)}
      </div>
      <div class="hp">
        <p>${roleBadge(user.role, user.status)}</p>
        <p><a class="btn" href="/">返回前台</a></p>
      </div>
    </div>
  `;
}

function renderSideInfo() {
  const summary = state.summary || {};
  const current = sectionDefinitions.find((item) => item.id === state.section);
  const scopeTip = can('manageSettings')
    ? '设置、板块、会员、帖子和回收站已经拆开，减少误操作。'
    : '当前账号为版主，仅开放帖子管理和普通会员停用。';
  dom.sideInfo.innerHTML = `
    <div class="side-card">
      <div class="notice-box admin-side-box">
        <h3>${escapeHtml(current?.label || '后台')}</h3>
        <p class="meta-line">${escapeHtml(scopeTip)}</p>
        <div class="mini-stats">
          <p><strong>${summary.users ?? 0}</strong><span>会员</span></p>
          <p><strong>${summary.posts ?? 0}</strong><span>帖子</span></p>
          <p><strong>${summary.deletedUsers ?? 0}</strong><span>已删会员</span></p>
          <p><strong>${summary.deletedPosts ?? 0}</strong><span>已删帖子</span></p>
        </div>
      </div>
    </div>
  `;
}

async function refreshSection() {
  if (!isSectionAvailable(state.section)) {
    state.section = defaultSectionId();
  }
  dom.main.innerHTML = '<p class="loading">载入中...</p>';
  const summaryPromise = api('/api/admin/summary');

  if (state.section === 'settings') {
    const [summary, settings, backups] = await Promise.all([
      summaryPromise,
      api('/api/admin/settings'),
      api('/api/admin/backups'),
    ]);
    state.summary = summary;
    state.settings = settings;
    state.backups = backups.items;
  } else if (state.section === 'home') {
    state.summary = await summaryPromise;
  } else if (state.section === 'boards') {
    const [summary, boards] = await Promise.all([summaryPromise, api('/api/admin/boards')]);
    state.summary = summary;
    state.boards = boards;
  } else if (state.section === 'users') {
    const [summary, users] = await Promise.all([
      summaryPromise,
      api(`/api/admin/users?page=${state.filters.usersPage}&q=${encodeURIComponent(state.filters.usersQ)}`),
    ]);
    state.summary = summary;
    state.users = users;
    state.selected.users = new Set();
  } else if (state.section === 'posts') {
    const [summary, posts] = await Promise.all([
      summaryPromise,
      api(`/api/admin/posts?page=${state.filters.postsPage}&q=${encodeURIComponent(state.filters.postsQ)}`),
    ]);
    state.summary = summary;
    state.posts = posts;
    state.selected.posts = new Set();
  } else if (state.section === 'recycle') {
    const [summary, recycleUsers, recyclePosts] = await Promise.all([
      summaryPromise,
      api(`/api/admin/recycle/users?page=${state.filters.recycleUsersPage}&q=${encodeURIComponent(state.filters.recycleUsersQ)}`),
      api(`/api/admin/recycle/posts?page=${state.filters.recyclePostsPage}&q=${encodeURIComponent(state.filters.recyclePostsQ)}`),
    ]);
    state.summary = summary;
    state.recycleUsers = recycleUsers;
    state.recyclePosts = recyclePosts;
    state.selected.recycleUsers = new Set();
    state.selected.recyclePosts = new Set();
  } else {
    state.summary = await summaryPromise;
  }

  renderSideInfo();
  renderMain();
}

function renderMain() {
  document.title = `论坛后台 · ${sectionLabel(state.section)}`;
  dom.main.innerHTML = `
    ${renderTabs()}
    ${renderSectionBody()}
  `;
}

function renderTabs() {
  return `
    <nav class="admin-tabs a-fadein">
      ${availableSections().map((item) => `
        <a href="#${item.id}" class="section-tab${state.section === item.id ? ' a' : ''}">${escapeHtml(item.label)}</a>
      `).join('')}
    </nav>
  `;
}

function renderSummary() {
  const summary = state.summary || {};
  return `
    <section class="admin-grid a-fadein">
      <div class="stat-box"><h3>会员</h3><p>${summary.users ?? 0}</p></div>
      <div class="stat-box"><h3>帖子</h3><p>${summary.posts ?? 0}</p></div>
      <div class="stat-box"><h3>回复</h3><p>${summary.replies ?? 0}</p></div>
      <div class="stat-box"><h3>未读通知</h3><p>${summary.unreadNotifications ?? 0}</p></div>
      <div class="stat-box"><h3>回收站会员</h3><p>${summary.deletedUsers ?? 0}</p></div>
      <div class="stat-box"><h3>回收站帖子</h3><p>${summary.deletedPosts ?? 0}</p></div>
    </section>
  `;
}

function renderSectionBody() {
  if (state.section === 'home') return renderHomeSection();
  if (state.section === 'settings') return renderSettingsSection();
  if (state.section === 'boards') return renderBoardsSection();
  if (state.section === 'users') return renderUsersSection();
  if (state.section === 'posts') return renderPostsSection();
  return renderRecycleSection();
}

function renderHomeSection() {
  const summary = state.summary || {};
  const homeLinks = availableSections()
    .filter((item) => item.id !== 'home')
    .map((item) => `
      <a class="home-link-card" href="#${item.id}"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(sectionDescription(item.id))}</span></a>
    `)
    .join('');
  const intro = can('manageSettings')
    ? '统计信息集中放在首页，其它管理页只保留操作区。'
    : '当前账号只开放帖子管理和普通会员停用，回收站和系统设置仍由管理员处理。';
  return `
    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>论坛概览</h3>
        <p class="muted">${escapeHtml(intro)}</p>
      </div>
      <section class="admin-grid a-fadein">
        <div class="stat-box"><h3>会员</h3><p>${summary.users ?? 0}</p></div>
        <div class="stat-box"><h3>帖子</h3><p>${summary.posts ?? 0}</p></div>
        <div class="stat-box"><h3>回复</h3><p>${summary.replies ?? 0}</p></div>
        <div class="stat-box"><h3>未读通知</h3><p>${summary.unreadNotifications ?? 0}</p></div>
        <div class="stat-box"><h3>回收站会员</h3><p>${summary.deletedUsers ?? 0}</p></div>
        <div class="stat-box"><h3>回收站帖子</h3><p>${summary.deletedPosts ?? 0}</p></div>
      </section>
    </section>

    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>快捷入口</h3>
        <p class="muted">直接进入常用管理区。</p>
      </div>
      <div class="home-links">
        ${homeLinks || '<p class="muted">当前账号没有更多可用的后台分区。</p>'}
      </div>
    </section>
  `;
}

function renderSettingsSection() {
  return `
    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>论坛设置</h3>
        <p class="muted">站点标题、系统通知、分页和 Turnstile 防护配置。</p>
      </div>
      <form id="settings-form">
        <p><input class="text" name="forumTitle" value="${escapeHtml(state.settings.forumTitle)}" placeholder="论坛标题"></p>
        <p><input class="text" name="forumDescription" value="${escapeHtml(state.settings.forumDescription)}" placeholder="论坛简介"></p>
        <p><input class="text" name="forumKeywords" value="${escapeHtml(state.settings.forumKeywords)}" placeholder="关键词"></p>
        <p><textarea class="text" name="siteNotice" rows="3" placeholder="系统通知">${escapeHtml(state.settings.siteNotice)}</textarea></p>
        <div class="inline-form">
          <input class="text" name="turnstileSiteKey" value="${escapeHtml(state.settings.turnstileSiteKey || '')}" placeholder="Turnstile Site Key">
          <input class="text" name="turnstileSecretKey" type="password" value="${escapeHtml(state.settings.turnstileSecretKey || '')}" placeholder="Turnstile Secret Key" autocomplete="new-password">
          <span class="tag ${state.settings.turnstileEnabled ? 'moderator' : 'suspended'}">${state.settings.turnstileEnabled ? 'Turnstile 已启用' : 'Turnstile 未启用'}</span>
        </div>
        <p class="muted">注册、发帖和回帖会在这里启用 Cloudflare Turnstile。站点 key 和密钥任一留空都会自动关闭。</p>
        <div class="inline-form">
          <label><input type="checkbox" name="allowRegistration" ${state.settings.allowRegistration ? 'checked' : ''}> 允许注册</label>
          <label>帖子每页 <input class="text" type="number" name="pageSizePosts" min="5" max="50" value="${state.settings.pageSizePosts}" style="max-width:180px"></label>
          <label>回复每页 <input class="text" type="number" name="pageSizeReplies" min="5" max="50" value="${state.settings.pageSizeReplies}" style="max-width:180px"></label>
          <button class="btn" type="submit">保存设置</button>
        </div>
      </form>
    </section>

    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>管理员账号</h3>
        <p class="muted">修改当前管理员昵称、邮箱和密码。</p>
      </div>
      <form id="profile-form">
        <div class="inline-form">
          <input class="text" name="username" placeholder="新昵称（可选）">
          <input class="text" name="email" type="email" placeholder="新邮箱（可选）">
          <input class="text" name="currentPassword" type="password" placeholder="当前密码" required>
          <input class="text" name="newPassword" type="password" placeholder="新密码（可选）">
          <button class="btn secondary" type="submit">更新账号</button>
        </div>
      </form>
    </section>

    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>备份与恢复</h3>
        <p class="muted">动数据前先备份，回滚更安全。</p>
      </div>
      <div class="board-actions">
        <form id="backup-form" class="inline-form">
          <input class="text" name="label" placeholder="备份名称（可选）">
          <button class="btn" type="submit">创建备份</button>
        </form>
      </div>
      <table class="admin-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${state.backups.length
            ? state.backups.map((backup) => `
              <tr data-backup-id="${backup.id}">
                <td>${escapeHtml(backup.label)}</td>
                <td>${formatRelativeTime(backup.createdAt)}</td>
                <td class="row-actions">
                  <a class="btn ghost" href="/api/admin/backups/${backup.id}" target="_blank">下载</a>
                  <button class="btn warn" type="button" data-action="restore-backup">恢复</button>
                </td>
              </tr>
            `).join('')
            : emptyTableRow(3, '还没有备份。')}
        </tbody>
      </table>
    </section>
  `;
}

function renderBoardsSection() {
  return `
    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>新增板块</h3>
        <p class="muted"><code>slug</code> 现在是前台访问地址标识，创建后可继续调整；内部 ID 只留给数据库使用。</p>
      </div>
      <form id="board-create-form" class="inline-form">
        <input class="text" name="slug" placeholder="slug，例如 tech" required>
        <input class="text" name="name" placeholder="名称" required>
        <input class="text" name="icon" placeholder="图标文字" required>
        <input class="text" name="description" placeholder="简介">
        <span class="color-chip" data-color-preview style="${boardAccentVar('#99CC66')}"></span>
        <input class="text" name="accent" value="#99CC66" placeholder="#99CC66">
        <input class="text" type="number" name="sortOrder" value="10" min="0" max="999">
        <label><input type="checkbox" name="isVisible" checked> 显示</label>
        <button class="btn" type="submit">新增板块</button>
      </form>
    </section>

    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>现有板块</h3>
        <p class="muted">修改 <code>slug</code> 会影响前台板块地址和导航链接，内部 ID 不会变。</p>
      </div>
      ${state.boards.map((board) => `
        <div class="admin-section board-row" data-board-id="${board.id}">
          <div class="inline-form">
            <input class="text readonly" name="boardId" value="${escapeHtml(board.id)}" disabled>
            <input class="text" name="slug" value="${escapeHtml(board.slug)}">
            <input class="text" name="name" value="${escapeHtml(board.name)}">
            <input class="text" name="icon" value="${escapeHtml(board.icon)}">
            <input class="text" name="description" value="${escapeHtml(board.description)}">
            <span class="color-chip" data-color-preview style="${boardAccentVar(board.accent)}"></span>
            <input class="text" name="accent" value="${escapeHtml(board.accent)}">
            <input class="text" type="number" name="sortOrder" value="${board.sortOrder}" min="0" max="999">
            <label><input type="checkbox" name="isVisible" ${board.isVisible ? 'checked' : ''}> 显示</label>
            <button class="btn ghost" type="button" data-action="save-board">保存</button>
            <button class="btn warn" type="button" data-action="delete-board">删除</button>
          </div>
        </div>
      `).join('')}
    </section>
  `;
}

function renderUsersSection() {
  const items = state.users?.items || [];
  const selected = state.selected.users;
  const canManageRoles = can('manageUserRoles');
  const canDeleteUsers = can('deleteUsers');
  const showSelection = canDeleteUsers;
  const columnCount = showSelection ? 7 : 5;
  const sectionTip = canManageRoles
    ? '支持搜索、批量删除和单个权限调整。删除后进入回收站，不会立刻硬删。'
    : '版主只能停用或恢复普通会员，不能改角色、不能删除会员。';
  return `
    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>会员管理</h3>
        <p class="muted">${escapeHtml(sectionTip)}</p>
      </div>
      <div class="board-actions">
        <form id="users-search-form" class="inline-form">
          <input class="text" name="q" value="${escapeHtml(state.filters.usersQ)}" placeholder="搜索昵称或邮箱">
          <button class="btn ghost" type="submit">筛选</button>
        </form>
        ${canDeleteUsers ? `
          <div class="bulk-bar">
            <span class="muted">已选 ${selected.size} 项</span>
            <button class="btn warn" type="button" data-action="batch-delete-users">批量删除</button>
          </div>
        ` : ''}
      </div>
      <table class="admin-table">
        <thead>
          <tr>
            ${showSelection ? `<th class="check-col"><input type="checkbox" data-check-all="users" ${isPageFullySelected('users', items) ? 'checked' : ''}></th>` : ''}
            <th>会员</th>
            <th>角色</th>
            <th>状态</th>
            ${canManageRoles ? '<th>简介</th>' : ''}
            <th>最后登录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${items.length ? items.map((user) => `
            <tr data-user-id="${user.id}" data-user-role="${user.role}">
              ${showSelection ? `<td class="check-col"><input type="checkbox" data-row-check="users" value="${user.id}" ${selected.has(user.id) ? 'checked' : ''}></td>` : ''}
              <td>
                <strong>${escapeHtml(user.username)}</strong><br>
                <span class="muted">${escapeHtml(user.email)}</span><br>
                <span>${roleBadge(user.role, user.status)}</span>
              </td>
              <td>
                ${canManageRoles
                  ? `
                    <select class="select" name="role">
                      <option value="member" ${user.role === 'member' ? 'selected' : ''}>member</option>
                      <option value="moderator" ${user.role === 'moderator' ? 'selected' : ''}>moderator</option>
                      <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option>
                    </select>
                  `
                  : roleBadge(user.role, 'active')}
              </td>
              <td>
                <select class="select" name="status" ${!canManageRoles && user.role !== 'member' ? 'disabled' : ''}>
                  <option value="active" ${user.status === 'active' ? 'selected' : ''}>active</option>
                  <option value="suspended" ${user.status === 'suspended' ? 'selected' : ''}>suspended</option>
                </select>
              </td>
              ${canManageRoles ? `<td><input class="text" name="bio" value="${escapeHtml(user.bio || '')}"></td>` : ''}
              <td>${user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : '从未'}</td>
              <td class="row-actions">
                <button class="btn ghost" type="button" data-action="save-user" ${!canManageRoles && user.role !== 'member' ? 'disabled' : ''}>${canManageRoles ? '保存' : '更新状态'}</button>
                ${canDeleteUsers
                  ? '<button class="btn warn" type="button" data-action="delete-user">删除</button>'
                  : `<span class="muted">${user.role === 'member' ? '仅可停用' : '仅限普通会员'}</span>`}
              </td>
            </tr>
          `).join('') : emptyTableRow(columnCount, '没有匹配的会员。')}
        </tbody>
      </table>
      ${renderPager('users', state.users?.page || 1, state.users?.totalPages || 1)}
    </section>
  `;
}

function renderPostsSection() {
  const items = state.posts?.items || [];
  const selected = state.selected.posts;
  const sectionTip = can('manageRecycle')
    ? '支持搜索、批量删除和单篇删除。删除后的帖子会进入回收站。'
    : '支持搜索、置顶和删除。删除后的帖子会进入回收站，但回收站清理仍由管理员处理。';
  return `
    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>帖子管理</h3>
        <p class="muted">${escapeHtml(sectionTip)}</p>
      </div>
      <div class="board-actions">
        <form id="posts-search-form" class="inline-form">
          <input class="text" name="q" value="${escapeHtml(state.filters.postsQ)}" placeholder="搜索标题、内容或作者">
          <button class="btn ghost" type="submit">筛选</button>
        </form>
        <div class="bulk-bar">
          <span class="muted">已选 ${selected.size} 项</span>
          <button class="btn warn" type="button" data-action="batch-delete-posts">批量删除</button>
        </div>
      </div>
      <table class="admin-table">
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" data-check-all="posts" ${isPageFullySelected('posts', items) ? 'checked' : ''}></th>
            <th>标题</th>
            <th>板块</th>
            <th>作者</th>
            <th>互动</th>
            <th>最后活跃</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${items.length ? items.map((post) => `
            <tr data-post-id="${post.id}">
              <td class="check-col"><input type="checkbox" data-row-check="posts" value="${post.id}" ${selected.has(post.id) ? 'checked' : ''}></td>
              <td>
                ${post.isPinned ? '<span class="tag pinned">置顶</span> ' : ''}
                <a href="/#p/${post.id}" target="_blank">${escapeHtml(post.title)}</a>
              </td>
              <td>${escapeHtml(post.boardName)}</td>
              <td>${escapeHtml(post.authorName)}</td>
              <td>${post.replyCount} 回 / ${post.likeCount} 赞 / ${post.viewCount} 浏览</td>
              <td>${formatRelativeTime(post.lastActivityAt)}</td>
              <td class="row-actions">
                <button class="btn ${post.isPinned ? 'secondary' : 'ghost'}" type="button" data-action="toggle-pin-post" data-is-pinned="${post.isPinned ? 'true' : 'false'}">${post.isPinned ? '取消置顶' : '置顶'}</button>
                <button class="btn warn" type="button" data-action="delete-post">删除</button>
              </td>
            </tr>
          `).join('') : emptyTableRow(7, '没有匹配的帖子。')}
        </tbody>
      </table>
      ${renderPager('posts', state.posts?.page || 1, state.posts?.totalPages || 1)}
    </section>
  `;
}

function renderRecycleSection() {
  const recycleUsers = state.recycleUsers?.items || [];
  const recyclePosts = state.recyclePosts?.items || [];
  return `
    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>会员回收站</h3>
        <p class="muted">恢复会把会员状态还原到删除前；彻底删除会连同其数据一起清除。</p>
      </div>
      <div class="board-actions">
        <form id="recycle-users-search-form" class="inline-form">
          <input class="text" name="q" value="${escapeHtml(state.filters.recycleUsersQ)}" placeholder="搜索回收站会员">
          <button class="btn ghost" type="submit">筛选</button>
        </form>
        <div class="bulk-bar">
          <span class="muted">已选 ${state.selected.recycleUsers.size} 项</span>
          <button class="btn secondary" type="button" data-action="batch-restore-users">批量恢复</button>
          <button class="btn warn" type="button" data-action="batch-purge-users">彻底删除</button>
        </div>
      </div>
      <table class="admin-table">
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" data-check-all="recycleUsers" ${isPageFullySelected('recycleUsers', recycleUsers) ? 'checked' : ''}></th>
            <th>会员</th>
            <th>角色</th>
            <th>删除时间</th>
            <th>最后登录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${recycleUsers.length ? recycleUsers.map((user) => `
            <tr data-user-id="${user.id}">
              <td class="check-col"><input type="checkbox" data-row-check="recycleUsers" value="${user.id}" ${state.selected.recycleUsers.has(user.id) ? 'checked' : ''}></td>
              <td>
                <strong>${escapeHtml(user.username)}</strong><br>
                <span class="muted">${escapeHtml(user.email)}</span><br>
                <span>${roleBadge(user.role, 'deleted')}</span>
              </td>
              <td>${escapeHtml(user.role)}</td>
              <td>${user.deletedAt ? formatRelativeTime(user.deletedAt) : '未知'}</td>
              <td>${user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : '从未'}</td>
              <td class="row-actions">
                <button class="btn secondary" type="button" data-action="restore-user">恢复</button>
                <button class="btn warn" type="button" data-action="purge-user">彻底删除</button>
              </td>
            </tr>
          `).join('') : emptyTableRow(6, '会员回收站为空。')}
        </tbody>
      </table>
      ${renderPager('recycleUsers', state.recycleUsers?.page || 1, state.recycleUsers?.totalPages || 1)}
    </section>

    <section class="admin-section a-risein">
      <div class="section-head">
        <h3>帖子回收站</h3>
        <p class="muted">恢复后帖子会重新出现在前台；彻底删除后不可恢复。</p>
      </div>
      <div class="board-actions">
        <form id="recycle-posts-search-form" class="inline-form">
          <input class="text" name="q" value="${escapeHtml(state.filters.recyclePostsQ)}" placeholder="搜索回收站帖子">
          <button class="btn ghost" type="submit">筛选</button>
        </form>
        <div class="bulk-bar">
          <span class="muted">已选 ${state.selected.recyclePosts.size} 项</span>
          <button class="btn secondary" type="button" data-action="batch-restore-posts">批量恢复</button>
          <button class="btn warn" type="button" data-action="batch-purge-posts">彻底删除</button>
        </div>
      </div>
      <table class="admin-table">
        <thead>
          <tr>
            <th class="check-col"><input type="checkbox" data-check-all="recyclePosts" ${isPageFullySelected('recyclePosts', recyclePosts) ? 'checked' : ''}></th>
            <th>标题</th>
            <th>板块</th>
            <th>作者</th>
            <th>删除时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${recyclePosts.length ? recyclePosts.map((post) => `
            <tr data-post-id="${post.id}">
              <td class="check-col"><input type="checkbox" data-row-check="recyclePosts" value="${post.id}" ${state.selected.recyclePosts.has(post.id) ? 'checked' : ''}></td>
              <td>${escapeHtml(post.title)}</td>
              <td>${escapeHtml(post.boardName)}</td>
              <td>${escapeHtml(post.authorName)}</td>
              <td>${post.deletedAt ? formatRelativeTime(post.deletedAt) : '未知'}</td>
              <td class="row-actions">
                <button class="btn secondary" type="button" data-action="restore-post">恢复</button>
                <button class="btn warn" type="button" data-action="purge-post">彻底删除</button>
              </td>
            </tr>
          `).join('') : emptyTableRow(6, '帖子回收站为空。')}
        </tbody>
      </table>
      ${renderPager('recyclePosts', state.recyclePosts?.page || 1, state.recyclePosts?.totalPages || 1)}
    </section>
  `;
}

async function handleMainSubmit(event) {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  try {
    if (form.id === 'settings-form') return await submitSettings(form);
    if (form.id === 'profile-form') return await submitProfile(form);
    if (form.id === 'board-create-form') return await submitCreateBoard(form);
    if (form.id === 'backup-form') return await submitBackup(form);
    if (form.id === 'users-search-form') {
      state.filters.usersQ = new FormData(form).get('q')?.toString().trim() || '';
      state.filters.usersPage = 1;
      return await refreshSection();
    }
    if (form.id === 'posts-search-form') {
      state.filters.postsQ = new FormData(form).get('q')?.toString().trim() || '';
      state.filters.postsPage = 1;
      return await refreshSection();
    }
    if (form.id === 'recycle-users-search-form') {
      state.filters.recycleUsersQ = new FormData(form).get('q')?.toString().trim() || '';
      state.filters.recycleUsersPage = 1;
      return await refreshSection();
    }
    if (form.id === 'recycle-posts-search-form') {
      state.filters.recyclePostsQ = new FormData(form).get('q')?.toString().trim() || '';
      state.filters.recyclePostsPage = 1;
      return await refreshSection();
    }
  } catch (error) {
    showError(error);
  }
}

async function handleMainClick(event) {
  const pager = event.target.closest('[data-page-target]');
  if (pager) {
    event.preventDefault();
    state.filters[`${pager.dataset.pageTarget}Page`] = Number(pager.dataset.page) || 1;
    await refreshSection();
    return;
  }

  const button = event.target.closest('[data-action]');
  if (!button) return;

  try {
    const action = button.dataset.action;
    if (action === 'save-board') return await saveBoard(button.closest('.board-row'));
    if (action === 'delete-board') return await deleteBoard(button.closest('.board-row'));
    if (action === 'save-user') return await saveUser(button.closest('tr'));
    if (action === 'delete-user') return await deleteUsers([button.closest('tr').dataset.userId]);
    if (action === 'toggle-pin-post') return await setPostPinned(button.closest('tr').dataset.postId, button.dataset.isPinned !== 'true');
    if (action === 'delete-post') return await deletePosts([button.closest('tr').dataset.postId]);
    if (action === 'batch-delete-users') return await deleteUsers([...state.selected.users]);
    if (action === 'batch-delete-posts') return await deletePosts([...state.selected.posts]);
    if (action === 'restore-user') return await restoreRecycleUsers([button.closest('tr').dataset.userId]);
    if (action === 'purge-user') return await purgeRecycleUsers([button.closest('tr').dataset.userId]);
    if (action === 'restore-post') return await restoreRecyclePosts([button.closest('tr').dataset.postId]);
    if (action === 'purge-post') return await purgeRecyclePosts([button.closest('tr').dataset.postId]);
    if (action === 'batch-restore-users') return await restoreRecycleUsers([...state.selected.recycleUsers]);
    if (action === 'batch-purge-users') return await purgeRecycleUsers([...state.selected.recycleUsers]);
    if (action === 'batch-restore-posts') return await restoreRecyclePosts([...state.selected.recyclePosts]);
    if (action === 'batch-purge-posts') return await purgeRecyclePosts([...state.selected.recyclePosts]);
    if (action === 'restore-backup') return await restoreBackup(button.closest('tr'));
  } catch (error) {
    showError(error);
  }
}

function handleMainChange(event) {
  const all = event.target.closest('[data-check-all]');
  if (all) {
    togglePageSelection(all.dataset.checkAll, all.checked);
    renderMain();
    return;
  }
  const row = event.target.closest('[data-row-check]');
  if (row) {
    if (row.checked) state.selected[row.dataset.rowCheck].add(row.value);
    else state.selected[row.dataset.rowCheck].delete(row.value);
    renderMain();
  }
}

function handleMainInput(event) {
  const input = event.target.closest('input[name="accent"]');
  if (!input) return;
  const chip = input.closest('.inline-form')?.querySelector('[data-color-preview]');
  if (!chip) return;
  chip.style.setProperty('--board-accent', safeAccentColor(input.value));
}

async function submitSettings(formNode) {
  const form = new FormData(formNode);
  await api('/api/admin/settings', {
    method: 'PUT',
    body: {
      forumTitle: form.get('forumTitle'),
      forumDescription: form.get('forumDescription'),
      forumKeywords: form.get('forumKeywords'),
      siteNotice: form.get('siteNotice'),
      turnstileSiteKey: form.get('turnstileSiteKey'),
      turnstileSecretKey: form.get('turnstileSecretKey'),
      allowRegistration: form.get('allowRegistration') === 'on',
      pageSizePosts: Number(form.get('pageSizePosts')),
      pageSizeReplies: Number(form.get('pageSizeReplies')),
    },
  });
  await refreshSection();
}

async function submitProfile(formNode) {
  const form = new FormData(formNode);
  const body = { currentPassword: form.get('currentPassword') };
  if (form.get('username')) body.username = form.get('username');
  if (form.get('email')) body.email = form.get('email');
  if (form.get('newPassword')) body.newPassword = form.get('newPassword');
  await api('/api/admin/profile', { method: 'PUT', body });
  await refreshSection();
}

async function submitCreateBoard(formNode) {
  const form = new FormData(formNode);
  await api('/api/admin/boards', {
    method: 'POST',
    body: {
      slug: form.get('slug'),
      name: form.get('name'),
      icon: form.get('icon'),
      description: form.get('description'),
      accent: form.get('accent'),
      sortOrder: Number(form.get('sortOrder')),
      isVisible: form.get('isVisible') === 'on',
    },
  });
  await refreshSection();
}

async function saveBoard(row) {
  await api(`/api/admin/boards/${row.dataset.boardId}`, {
    method: 'PUT',
    body: {
      slug: row.querySelector('[name="slug"]').value,
      name: row.querySelector('[name="name"]').value,
      icon: row.querySelector('[name="icon"]').value,
      description: row.querySelector('[name="description"]').value,
      accent: row.querySelector('[name="accent"]').value,
      sortOrder: Number(row.querySelector('[name="sortOrder"]').value),
      isVisible: row.querySelector('[name="isVisible"]').checked,
    },
  });
  await refreshSection();
}

async function deleteBoard(row) {
  if (!confirm('确定删除这个板块吗？空板块才能删除。')) return;
  await api(`/api/admin/boards/${row.dataset.boardId}`, { method: 'DELETE' });
  await refreshSection();
}

async function saveUser(row) {
  const roleInput = row.querySelector('[name="role"]');
  const bioInput = row.querySelector('[name="bio"]');
  await api(`/api/admin/users/${row.dataset.userId}`, {
    method: 'PUT',
    body: {
      role: roleInput ? roleInput.value : row.dataset.userRole,
      status: row.querySelector('[name="status"]').value,
      ...(bioInput ? { bio: bioInput.value } : {}),
    },
  });
  await refreshSection();
}

async function deleteUsers(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) throw new Error('请至少选择一个会员');
  const isBatch = clean.length > 1;
  if (!confirm(isBatch ? `确定删除选中的 ${clean.length} 个会员吗？它们会先进入回收站。` : '确定删除这个会员吗？它会先进入回收站。')) return;
  if (isBatch) {
    await api('/api/admin/users/batch-delete', { method: 'POST', body: { ids: clean } });
  } else {
    await api(`/api/admin/users/${clean[0]}`, { method: 'DELETE' });
  }
  await refreshSection();
}

async function deletePosts(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) throw new Error('请至少选择一篇帖子');
  const isBatch = clean.length > 1;
  if (!confirm(isBatch ? `确定删除选中的 ${clean.length} 篇帖子吗？它们会先进入回收站。` : '确定删除这篇帖子吗？它会先进入回收站。')) return;
  if (isBatch) {
    await api('/api/admin/posts/batch-delete', { method: 'POST', body: { ids: clean } });
  } else {
    await api(`/api/admin/posts/${clean[0]}`, { method: 'DELETE' });
  }
  await refreshSection();
}

async function setPostPinned(postId, isPinned) {
  await api(`/api/admin/posts/${postId}/pin`, {
    method: 'PUT',
    body: { isPinned },
  });
  await refreshSection();
}

async function restoreRecycleUsers(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) throw new Error('请至少选择一个会员');
  await api('/api/admin/recycle/users/restore', { method: 'POST', body: { ids: clean } });
  await refreshSection();
}

async function purgeRecycleUsers(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) throw new Error('请至少选择一个会员');
  if (!confirm(`确定彻底删除这 ${clean.length} 个会员吗？这一步不可恢复。`)) return;
  await api('/api/admin/recycle/users/purge', { method: 'POST', body: { ids: clean } });
  await refreshSection();
}

async function restoreRecyclePosts(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) throw new Error('请至少选择一篇帖子');
  await api('/api/admin/recycle/posts/restore', { method: 'POST', body: { ids: clean } });
  await refreshSection();
}

async function purgeRecyclePosts(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) throw new Error('请至少选择一篇帖子');
  if (!confirm(`确定彻底删除这 ${clean.length} 篇帖子吗？这一步不可恢复。`)) return;
  await api('/api/admin/recycle/posts/purge', { method: 'POST', body: { ids: clean } });
  await refreshSection();
}

async function submitBackup(formNode) {
  const form = new FormData(formNode);
  await api('/api/admin/backups', {
    method: 'POST',
    body: { label: form.get('label') || undefined },
  });
  await refreshSection();
}

async function restoreBackup(row) {
  if (!confirm('恢复备份会覆盖当前数据，确定继续吗？')) return;
  await api(`/api/admin/backups/${row.dataset.backupId}/restore`, { method: 'POST' });
  await refreshSection();
}

function renderPager(target, currentPage, totalPages) {
  return buildPager(
    (page) => `javascript:void(0)" data-page-target="${target}" data-page="${page}`,
    currentPage,
    totalPages,
  ).replaceAll('<a ', '<a class="page-link" ');
}
function sectionLabel(id) { return sectionDefinitions.find((item) => item.id === id)?.label || '后台'; }
function sectionDescription(id) {
  if (id === 'settings') return '论坛标题、系统通知、备份与管理员账号。';
  if (id === 'boards') return '编辑板块名称、slug、颜色和排序。';
  if (id === 'users') return can('manageUserRoles') ? '搜索会员、调权限、批量删除。' : '搜索会员并停用普通会员。';
  if (id === 'posts') return '搜索帖子、置顶、删除和批量处理。';
  if (id === 'recycle') return '恢复误删的会员和帖子，或彻底删除。';
  return '后台分区';
}
function emptyTableRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="muted">${escapeHtml(text)}</td></tr>`;
}

function getPageItems(key) {
  if (key === 'users') return state.users?.items || [];
  if (key === 'posts') return state.posts?.items || [];
  if (key === 'recycleUsers') return state.recycleUsers?.items || [];
  return state.recyclePosts?.items || [];
}

function isPageFullySelected(key, items) {
  return items.length > 0 && items.every((item) => state.selected[key].has(item.id));
}

function togglePageSelection(key, checked) {
  const items = getPageItems(key);
  state.selected[key] = checked ? new Set(items.map((item) => item.id)) : new Set();
}

function clearAllSelections() {
  state.selected.users = new Set();
  state.selected.posts = new Set();
  state.selected.recycleUsers = new Set();
  state.selected.recyclePosts = new Set();
}

function safeAccentColor(value, fallback = '#99CC66') {
  const color = String(value || '').trim();
  return HEX_COLOR_RE.test(color) ? color : fallback;
}

function boardAccentVar(value) {
  return `--board-accent:${safeAccentColor(value)}`;
}
