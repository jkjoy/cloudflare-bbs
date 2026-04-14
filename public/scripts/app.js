import {
  $,
  $$,
  api,
  attachMarkdownToolbar,
  avatarUrl,
  decodeHashPart,
  escapeHtml,
  formatRelativeTime,
  roleBadge,
  renderMarkdown,
  showError,
} from './shared.js';

const dom = {
  nav: $('#h'),
  sideUser: $('#u'),
  sideInfo: $('#link'),
  main: $('#m'),
};

const state = {
  bootstrap: null,
  authMode: 'login',
  smiles: null,
  profileEmailNotice: '',
  profileEmailNoticeTone: 'success',
  profilePasswordNotice: '',
  profilePasswordNoticeTone: 'success',
};

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
let turnstileReadyPromise = null;

init().catch(showError);

async function init() {
  await refreshBootstrap();
  window.addEventListener('hashchange', route);
  route();
}

async function refreshBootstrap() {
  state.bootstrap = await api('/api/public/bootstrap');
  renderShell();
}

function renderShell() {
  const { forum, boards } = state.bootstrap;
  document.title = forum.forumTitle;
  dom.nav.innerHTML = `<a href="#home">首页</a>${boards
    .filter((board) => board.isVisible)
    .map((board) => `<a href="#t/${board.slug}" class="board-nav-link" style="${boardAccentVar(board.accent)}">${escapeHtml(board.name)}</a>`)
    .join('')}`;

  renderUserPanel();
  renderSideLinks();
}

function renderUserPanel() {
  const { hasAdmin, currentUser, unreadNotifications } = state.bootstrap;

  if (!hasAdmin) {
    dom.sideUser.innerHTML = `
      <form method="post" id="setup-form" autocomplete="off">
        <p><input class="text" name="forumTitle" placeholder="论坛标题" value="Hi~是这！" required></p>
        <p><input class="text" name="forumDescription" placeholder="站点描述" value="一个运行在 Cloudflare Workers 上的微型论坛。"></p>
        <p><input class="text" name="username" placeholder="管理员昵称" required></p>
        <p><input class="text" name="email" type="email" placeholder="管理员邮箱" required></p>
        <p><input class="text" name="password" type="password" placeholder="管理员密码" required></p>
        <p><button type="submit" class="btn">初始化论坛</button></p>
      </form>
    `;
    $('#setup-form').addEventListener('submit', handleSetup);
    return;
  }

  if (!currentUser) {
    if (state.authMode === 'register') {
      dom.sideUser.innerHTML = `
        <form method="post" id="Ur" autocomplete="off">
          <p><input class="text" name="username" placeholder="请输入昵称" required></p>
          <p><input class="text" name="email" placeholder="请输入邮箱" required></p>
          <p><input class="text" type="password" name="password" placeholder="请输入密码" required></p>
          ${renderTurnstileSlot('register', '注册前需要先完成人机验证，用来拦截注册机。')}
          <p><button type="submit" class="btn">加入我们 ٩͡[๏v͡๏]۶ </button></p>
        </form>
        <div class="U-act">
          <p>已有账户？</p>
          <button type="button" class="btn" id="go-login">登录 (ノ≧∇≦)ノ </button>
        </div>
      `;
      $('#Ur').addEventListener('submit', handleRegister);
      void mountTurnstile($('#Ur'));
      $('#go-login').addEventListener('click', () => {
        state.authMode = 'login';
        renderUserPanel();
      });
    } else {
      dom.sideUser.innerHTML = `
        <form method="post" id="Ul">
          <p><input class="text" name="identifier" placeholder="输入昵称或邮箱" required></p>
          <p><input class="text" type="password" name="password" placeholder="请输入密码" required></p>
          <p><button type="submit" class="btn">登录 (ノ≧∇≦)ノ </button></p>
        </form>
        <div class="U-act">
          <p>尚未注册？</p>
          <button type="button" class="btn" id="go-register">加入我们 ٩͡[๏v͡๏]۶ </button>
        </div>
      `;
      $('#Ul').addEventListener('submit', handleLogin);
      $('#go-register').addEventListener('click', () => {
        state.authMode = 'register';
        renderUserPanel();
      });
    }
    return;
  }

  dom.sideUser.innerHTML = `
    <div class="user_link">
      <img src="${avatarUrl(currentUser.avatarHash, 64)}" alt="${escapeHtml(currentUser.username)}">
      <div class="user_meta">
        <span class="user_name">${escapeHtml(currentUser.username)}</span>
        <span class="identity-badges user_identity">${renderIdentityBadges(currentUser)}</span>
      </div>
      <a class="close" id="logout-link">×</a>
    </div>
    <ul class="U-act">
      <li><a class="btn" href="#add">发表文章ヽ(\`Д´)</a></li>
      <li><a class="btn" href="#profile">用户中心</a></li>
      <li><a class="btn" href="#notifications">${unreadNotifications ? `通知 (${unreadNotifications})` : '通知中心'}</a></li>
      ${currentUser.capabilities?.accessAdmin ? '<li><a class="btn" href="/admin.html">后台管理</a></li>' : ''}
    </ul>
  `;
  $('#logout-link').addEventListener('click', handleLogout);
}

function renderSideLinks() {
  const { forum } = state.bootstrap;
  const links = [
    '<ul class="hp c">',
    `<li class="hr"><h2>${escapeHtml(forum.forumTitle)}</h2></li>`,
    `<li><a href="#home" class="side-copy-link"><span class="side-copy-text">${escapeHtml(forum.forumDescription)}</span></a></li>`,
    `<li>
      <div class="quick-search-panel">
        <strong>搜索</strong>
        <span>按关键词搜索帖子和用户</span>
        <form id="quick-search-form" class="quick-search-form">
          <input class="text" id="quick-search-input" name="q" placeholder="输入关键词">
          <button type="submit" class="btn">搜索</button>
        </form>
      </div>
    </li>`,
    '</ul>',
  ];

  dom.sideInfo.innerHTML = links.join('');
  $('#quick-search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q')?.toString().trim() || '';
    location.hash = q ? `#search/${encodeURIComponent(q)}` : '#home';
  });
}

function turnstileEnabled() {
  return Boolean(state.bootstrap?.forum?.turnstileEnabled && state.bootstrap?.forum?.turnstileSiteKey);
}

function renderTurnstileSlot(action, hint) {
  if (!turnstileEnabled()) {
    return '';
  }
  return `
    <div class="turnstile-wrap">
      <div class="turnstile-slot" data-turnstile-action="${escapeHtml(action)}"></div>
      <input type="hidden" name="turnstileToken" value="">
      <p class="turnstile-hint">${escapeHtml(hint)}</p>
    </div>
  `;
}

async function waitForTurnstile() {
  if (!turnstileEnabled()) {
    return null;
  }
  if (window.turnstile?.render) {
    return window.turnstile;
  }
  if (!turnstileReadyPromise) {
    turnstileReadyPromise = new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        if (window.turnstile?.render) {
          window.clearInterval(timer);
          resolve(window.turnstile);
          return;
        }
        if (Date.now() - startedAt >= 10000) {
          window.clearInterval(timer);
          turnstileReadyPromise = null;
          reject(new Error('Turnstile 脚本加载超时，请刷新页面重试'));
        }
      }, 80);
    });
  }
  return turnstileReadyPromise;
}

async function mountTurnstile(root) {
  if (!root || !turnstileEnabled()) {
    return;
  }
  const slots = $$('.turnstile-slot', root);
  if (!slots.length) {
    return;
  }
  let turnstile;
  try {
    turnstile = await waitForTurnstile();
  } catch (error) {
    showError(error);
    return;
  }
  slots.forEach((slot) => {
    if (!slot.isConnected || slot.dataset.mounted === 'true') {
      return;
    }
    const hidden = slot.parentElement?.querySelector('input[name="turnstileToken"]');
    if (!hidden) {
      return;
    }
    hidden.value = '';
    slot.dataset.mounted = 'true';
    slot.dataset.widgetId = String(turnstile.render(slot, {
      sitekey: state.bootstrap.forum.turnstileSiteKey,
      action: slot.dataset.turnstileAction || 'submit',
      callback(token) {
        hidden.value = token;
      },
      'expired-callback'() {
        hidden.value = '';
      },
      'timeout-callback'() {
        hidden.value = '';
      },
      'error-callback'() {
        hidden.value = '';
      },
    }));
  });
}

function getTurnstileToken(root) {
  return root?.querySelector('input[name="turnstileToken"]')?.value?.trim() || '';
}

function ensureTurnstileToken(root) {
  if (!turnstileEnabled()) {
    return;
  }
  if (getTurnstileToken(root)) {
    return;
  }
  throw new Error('请先完成人机验证');
}

function resetTurnstile(root) {
  const hidden = root?.querySelector('input[name="turnstileToken"]');
  if (hidden) {
    hidden.value = '';
  }
  const slot = root?.querySelector('.turnstile-slot');
  if (!slot?.dataset.widgetId || !window.turnstile?.reset) {
    return;
  }
  window.turnstile.reset(slot.dataset.widgetId);
}

async function route() {
  try {
    const parts = location.hash.replace(/^#/, '').split('/').map(decodeHashPart).filter(Boolean);
    const name = parts[0] || 'home';
    if (name !== 'profile') {
      state.profileEmailNotice = '';
      state.profileEmailNoticeTone = 'success';
      state.profilePasswordNotice = '';
      state.profilePasswordNoticeTone = 'success';
    }

    if (!state.bootstrap.hasAdmin) {
      renderSetupPage();
      return;
    }

    if (name === 'home') {
      await renderPostList({ page: Number(parts[1]) || 1 });
      return;
    }
    if (name === 't') {
      await renderPostList({ boardKey: parts[1], page: Number(parts[2]) || 1 });
      return;
    }
    if (name === 'p' && parts[1]) {
      await renderPostDetail(parts[1], Number(parts[2]) || 1);
      return;
    }
    if (name === 'add') {
      await renderAddPost();
      return;
    }
    if (name === 'search') {
      await renderSearch(parts[1] || '');
      return;
    }
    if (name === 'profile') {
      await renderProfile();
      return;
    }
    if (name === 'notifications') {
      await renderNotifications(Number(parts[1]) || 1);
      return;
    }
    location.hash = '#home';
  } catch (error) {
    showError(error);
    dom.main.innerHTML = '<p class="loading">载入失败。</p>';
  }
}

function renderSetupPage() {
  setActiveNav();
  document.title = '初始化论坛';
  dom.main.innerHTML = `
    <ul class="hp c a-fadein">
      <li class="hr"><h2>初始化</h2></li>
      <li><a><strong>论坛还没有管理员</strong><span>请在右侧填写管理员账号和论坛基础信息。</span></a></li>
      <li><a><strong>当前架构</strong><span>Cloudflare Workers + D1 + KV</span></a></li>
    </ul>
  `;
}

async function renderPostList({ boardKey = '', page = 1 }) {
  const board = findBoard(boardKey);
  const boardSlug = board?.slug || boardKey;
  setActiveNav(boardSlug || 'home');
  dom.main.innerHTML = '<p class="loading">载入中...</p>';
  const params = new URLSearchParams({ page: String(page) });
  if (boardKey) params.set('board', boardKey);
  const data = await api(`/api/public/posts?${params.toString()}`);
  document.title = board ? board.name : state.bootstrap.forum.forumTitle;

  if (!data.items.length) {
    dom.main.innerHTML = '<p class="loading">还没有内容啦OwQ</p>';
    return;
  }

  dom.main.innerHTML = `
    <ul class="F a-fadein">
      ${data.items.map((item) => `
        <li id="P-${item.id}">
          <a href="#p/${item.id}">
            <i class="i board-icon" style="color:${safeAccentColor(item.boardAccent)}">${escapeHtml(item.boardIcon)}</i>
            <img src="${avatarUrl(item.author.avatarHash, 64)}" alt="${escapeHtml(item.author.name)}">
            <h2>${item.isPinned ? '<span class="pin-badge">置顶</span>' : ''}${escapeHtml(item.title)}</h2>
            <p class="ctrl">
              <span>${escapeHtml(item.author.name)}</span>
              <span>${formatRelativeTime(item.lastActivityAt)}</span>
              <span class="plus${item.liked ? ' a' : ''}">${item.likeCount}</span>
            </p>
            <cite>${item.replyCount}</cite>
          </a>
        </li>
      `).join('')}
    </ul>
    ${renderPager(data.page, data.totalPages, (nextPage) => boardSlug ? `#t/${boardSlug}/${nextPage}` : `#home/${nextPage}`)}
  `;
}

async function renderPostDetail(postId, page = 1) {
  dom.main.innerHTML = '<p class="loading">载入中...</p>';
  const [{ post }, replies] = await Promise.all([
    api(`/api/public/posts/${postId}`),
    api(`/api/public/posts/${postId}/replies?page=${page}`),
  ]);
  setActiveNav(post.boardSlug || findBoardById(post.boardId)?.slug || post.boardId);
  document.title = post.title;

  dom.main.innerHTML = `
    <div class="P a-fadein">
      <h1>${post.isPinned ? '<span class="pin-badge detail">置顶</span>' : ''}${escapeHtml(post.title)}</h1>
      <div class="entry">${renderMarkdown(post.content)}</div>
      <p class="ctrl c">
        <b><img class="avatar" src="${avatarUrl(post.author.avatarHash, 64)}" alt="${escapeHtml(post.author.name)}">${escapeHtml(post.author.name)}</b>
        <span class="date">${formatRelativeTime(post.createdAt)}</span>
        <span class="plus${post.liked ? ' a' : ''}" data-post-id="${post.id}">${post.likeCount}</span>
        <a href="#t/${escapeHtml(post.boardSlug || post.boardId)}" class="board-label" style="${boardAccentVar(post.boardAccent)}">${escapeHtml(post.boardName)}</a>
      </p>
    </div>
    <ul class="C">
      ${replies.items.length ? replies.items.map((reply, index) => `
        <li id="R-${reply.id}" class="a-fadein">
          <b>${escapeHtml(reply.author.name)}<img class="avatar" src="${avatarUrl(reply.author.avatarHash, 64)}" alt="${escapeHtml(reply.author.name)}"></b>
          <p class="entry">${renderMarkdown(reply.content)}</p>
          <i>#${(page - 1) * replies.pageSize + index + 1}</i>
          <p class="ctrl c">
            <span class="date">${formatRelativeTime(reply.createdAt)}</span>
            <span data-name="${escapeHtml(reply.author.name)}" class="fo">回复</span>
            <span class="plus${reply.liked ? ' a' : ''}" data-reply-id="${reply.id}">${reply.likeCount}</span>
          </p>
        </li>
      `).join('') : '<li class="loading">沙发还在，还不快抢？</li>'}
    </ul>
    ${renderPager(replies.page, replies.totalPages, (nextPage) => `#p/${postId}/${nextPage}`)}
    <form class="Cf" method="post" id="reply-form">
      <p><textarea name="content" placeholder="在这里输入内容" rows="4" ${state.bootstrap.currentUser ? '' : 'disabled'}></textarea></p>
      ${state.bootstrap.currentUser ? renderTurnstileSlot('reply', '回复前需要先完成人机验证，用来拦截垃圾回复。') : ''}
      <p><button type="submit" class="btn" ${state.bootstrap.currentUser ? '' : 'disabled'}>${state.bootstrap.currentUser ? '回复 (Ctrl+Enter)' : '登录后回复'}</button></p>
      <ul class="smile c" id="smile-list"></ul>
    </form>
  `;

  void mountTurnstile($('#reply-form'));
  await renderSmiles();
  bindPostDetail(postId, page);
}

async function bindPostDetail(postId, page) {
  $('[data-post-id]')?.addEventListener('click', () => likePost(postId, page));
  $$('[data-reply-id]').forEach((node) => {
    node.addEventListener('click', () => likeReply(node.dataset.replyId, postId, page));
  });

  const form = $('#reply-form');
  const textarea = $('#reply-form textarea');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.bootstrap.currentUser) {
      showError(new Error('请先登录'));
      return;
    }
    try {
      ensureTurnstileToken(form);
      const formData = new FormData(form);
      await api(`/api/posts/${postId}/replies`, {
        method: 'POST',
        body: Object.fromEntries(formData.entries()),
      });
      await refreshBootstrap();
      location.hash = `#p/${postId}`;
    } catch (error) {
      resetTurnstile(form);
      showError(error);
    }
  });

  textarea.addEventListener('keydown', async (event) => {
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  textarea.addEventListener('input', () => {
    const rows = (textarea.value.match(/\n/g) || []).length + 4;
    textarea.setAttribute('rows', String(rows));
  });

  $$('.fo').forEach((node) => {
    node.addEventListener('click', () => {
      textarea.focus();
      textarea.value += `@${node.getAttribute('data-name')} `;
    });
  });
}

async function renderSmiles() {
  if (!state.smiles) {
    const text = await fetch('/smile.txt').then((res) => res.text()).catch(() => '');
    state.smiles = text.split(/[\r\n]+/).filter(Boolean);
  }
  const list = $('#smile-list');
  if (!list || !state.smiles.length) {
    return;
  }
  list.innerHTML = `<li>${state.smiles.join('</li><li>')}</li>`;
  list.addEventListener('click', (event) => {
    const item = event.target.closest('li');
    if (!item) return;
    const textarea = $('#reply-form textarea');
    textarea.focus();
    textarea.value += ` ${item.textContent} `;
  });
}

async function renderAddPost() {
  setActiveNav();
  if (!state.bootstrap.currentUser) {
    showError(new Error('请先登录'));
    location.hash = '#home';
    return;
  }

  const boards = state.bootstrap.boards.filter((board) => board.isVisible);
  document.title = '发表文章';
  dom.main.innerHTML = `
    <style>
    .A-tag{padding:.4em;font-size:1.3em;}
    .A-tag b{float:left;margin:.2em;padding:.4em .7em;cursor:pointer;border-radius:.5em;}
    .A-tag b.board-choice{color:var(--board-accent,#35506d);box-shadow:inset 0 0 0 1px var(--board-accent,#d0d7e2);}
    .A-tag b.board-choice:hover{background:#F8F8F8;}
    .A-tag b.board-choice.a{background:var(--board-accent,#DEF);box-shadow:none;color:#fff;}
    #A{padding:1em;}
    #A .text{width:100%;resize:none;box-sizing:border-box;}
    #A textarea.text{min-height:200px;}
    .md-toolbar{margin:.5em 0;padding:.5em;background:#f5f5f5;border-radius:.3em;}
    .md-toolbar .md-btn{display:inline-block;padding:.3em .6em;margin:0 .2em;cursor:pointer;background:#fff;border:1px solid #ddd;border-radius:.2em;font-size:.9em;user-select:none;}
    .md-toolbar .md-btn:hover{background:#e8e8e8;border-color:#aaa;}
    </style>
    <form method="post" id="A" class="a-fadein">
      <p class="A-tag o">
        ${boards.map((board, index) => `<b class="board-choice${index === 0 ? ' a' : ''}" style="${boardAccentVar(board.accent)}" data-board="${escapeHtml(board.id)}">${escapeHtml(board.name)}</b>`).join('')}
      </p>
      <input type="hidden" name="boardId" value="${boards[0]?.id || ''}">
      <p><input type="text" name="title" class="text" placeholder="请输入标题"></p>
      <div class="md-toolbar">
        <span class="md-btn" data-cmd="bold" title="加粗">加粗</span>
        <span class="md-btn" data-cmd="italic" title="斜体">斜体</span>
        <span class="md-btn" data-cmd="table" title="表格">表格</span>
        <span class="md-btn" data-cmd="link" title="链接">链接</span>
        <span class="md-btn" data-cmd="image" title="图片">图片</span>
        <span class="md-btn" data-cmd="quote" title="引用">引用</span>
        <span class="md-btn" data-cmd="code" title="代码">代码</span>
      </div>
      <p><textarea name="content" class="text" rows="7" placeholder="请输入正文（支持 Markdown）"></textarea></p>
      ${renderTurnstileSlot('post', '发表内容前需要先完成人机验证，用来拦截垃圾发帖。')}
      <p><button type="submit" class="btn">发表内容</button></p>
    </form>
  `;

  const form = $('#A');
  const textarea = $('#A textarea[name="content"]');
  attachMarkdownToolbar(form, textarea);
  void mountTurnstile(form);
  $$('.A-tag b').forEach((node) => {
    node.addEventListener('click', () => {
      $$('.A-tag b').forEach((item) => item.classList.remove('a'));
      node.classList.add('a');
      $('#A [name="boardId"]').value = node.dataset.board;
    });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      ensureTurnstileToken(form);
      const formData = new FormData(form);
      const result = await api('/api/posts', {
        method: 'POST',
        body: Object.fromEntries(formData.entries()),
      });
      await refreshBootstrap();
      location.hash = `#p/${result.id}`;
    } catch (error) {
      resetTurnstile(form);
      showError(error);
    }
  });
}

async function renderSearch(keyword) {
  setActiveNav();
  const q = keyword.trim();
  if (!q) {
    location.hash = '#home';
    return;
  }
  document.title = `搜索 ${q}`;
  const data = await api(`/api/public/search?q=${encodeURIComponent(q)}`);
  dom.main.innerHTML = `
    <ul class="hp c a-fadein">
      <li class="hr"><h2>搜索</h2></li>
      <li><a><strong>关键词</strong><span>${escapeHtml(q)}</span></a></li>
      <li class="hr"><h2>帖子</h2></li>
      ${data.posts.length
        ? data.posts.map((post) => `<li><a href="#p/${post.id}"><strong>${escapeHtml(post.title)}</strong><span>${escapeHtml(post.boardName)} / ${escapeHtml(post.authorName)} / ${formatRelativeTime(post.lastActivityAt)}</span></a></li>`).join('')
        : '<li><a><strong>没有匹配的帖子</strong><span>换个关键词试试。</span></a></li>'}
      <li class="hr"><h2>用户</h2></li>
      ${data.users.length
        ? data.users.map((user) => `<li><a><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.bio || '这个人很安静。')}</span></a></li>`).join('')
        : '<li><a><strong>没有匹配的用户</strong><span>换个关键词试试。</span></a></li>'}
    </ul>
  `;
}

async function renderNotifications(page = 1) {
  setActiveNav();
  if (!state.bootstrap.currentUser) {
    showError(new Error('请先登录'));
    location.hash = '#home';
    return;
  }
  document.title = '通知';
  const data = await api(`/api/notifications?page=${page}`);
  dom.main.innerHTML = `
    <ul class="hp c a-fadein">
      <li class="hr"><h2>通知</h2></li>
      <li><button type="button" class="btn" id="mark-all">全部标记已读</button></li>
      ${data.items.length
        ? data.items.map((item) => `
          <li>
            <a ${item.postId ? `href="#p/${item.postId}"` : ''}>
              <strong>${escapeHtml(item.actorName)} ${notificationLabel(item.type)}</strong>
              <span>${escapeHtml(item.textPreview || '无摘要')} / ${formatRelativeTime(item.createdAt)}${item.isRead ? '' : ' / 未读'}</span>
            </a>
          </li>
        `).join('')
        : '<li><a><strong>还没有通知</strong><span>系统通知、回复或点赞会显示在这里。</span></a></li>'}
    </ul>
    ${renderPager(data.page, data.totalPages, (nextPage) => `#notifications/${nextPage}`)}
  `;

  $('#mark-all')?.addEventListener('click', async () => {
    try {
      await api('/api/notifications/read', {
        method: 'POST',
        body: { markAll: true },
      });
      await refreshBootstrap();
      await renderNotifications(page);
    } catch (error) {
      showError(error);
    }
  });
}

async function renderProfile() {
  setActiveNav();
  if (!state.bootstrap.currentUser) {
    showError(new Error('请先登录'));
    location.hash = '#home';
    return;
  }
  const { currentUser, unreadNotifications } = state.bootstrap;
  const profileStats = [
    unreadNotifications > 0
      ? `<p><strong>${unreadNotifications}</strong><span>未读通知</span></p>`
      : '',
    `<p><strong>${formatRelativeTime(currentUser.createdAt)}</strong><span>注册时间</span></p>`,
  ].join('');
  document.title = '用户中心';
  dom.main.innerHTML = `
    <section class="profile-panel a-fadein">
      <div class="profile-card profile-overview">
        <div class="profile-user">
          <img class="profile-avatar" src="${avatarUrl(currentUser.avatarHash, 80)}" alt="${escapeHtml(currentUser.username)}">
          <div>
            <p class="profile-name">${escapeHtml(currentUser.username)}</p>
            <div class="identity-badges profile-badges">${renderIdentityBadges(currentUser)}</div>
            <p class="profile-sub">${escapeHtml(currentUser.email)}</p>
          </div>
        </div>
        <div class="profile-stats">${profileStats}</div>
      </div>

      <div class="profile-card">
        <div class="profile-head">
          <h2>修改邮箱</h2>
          <p>保存前可以先验证邮箱是否可用；提交时系统也会再次检查是否已被占用。</p>
        </div>
        ${state.profileEmailNotice ? `<p class="profile-notice ${state.profileEmailNoticeTone === 'error' ? 'error' : 'success'}">${escapeHtml(state.profileEmailNotice)}</p>` : ''}
        <form id="profile-email-form" class="profile-form" autocomplete="off">
          <p><input class="text" type="email" name="email" value="${escapeHtml(currentUser.email)}" placeholder="新邮箱地址" required></p>
          <p><input class="text" type="password" name="currentPassword" placeholder="当前密码" required></p>
          <p class="profile-actions">
            <button type="button" class="btn profile-link-btn" id="check-email-availability">验证邮箱可用性</button>
            <button type="submit" class="btn">保存新邮箱</button>
          </p>
        </form>
      </div>

      <div class="profile-card">
        <div class="profile-head">
          <h2>修改密码</h2>
          <p>使用当前密码验证后即可更新，新密码至少 8 位。</p>
        </div>
        ${state.profilePasswordNotice ? `<p class="profile-notice ${state.profilePasswordNoticeTone === 'error' ? 'error' : 'success'}">${escapeHtml(state.profilePasswordNotice)}</p>` : ''}
        <form id="profile-password-form" class="profile-form" autocomplete="off">
          <p><input class="text" type="password" name="currentPassword" placeholder="当前密码" required></p>
          <p><input class="text" type="password" name="newPassword" placeholder="新密码" required></p>
          <p><input class="text" type="password" name="confirmPassword" placeholder="确认新密码" required></p>
          <p class="profile-actions">
            <button type="submit" class="btn">保存新密码</button>
            <a href="#notifications" class="btn profile-link-btn">${unreadNotifications ? `查看通知 (${unreadNotifications})` : '查看通知'}</a>
          </p>
        </form>
      </div>
    </section>
  `;

  $('#profile-email-form')?.addEventListener('submit', handleProfileEmailSubmit);
  $('#check-email-availability')?.addEventListener('click', handleProfileEmailAvailabilityCheck);
  $('#profile-email-form [name="email"]')?.addEventListener('input', () => {
    state.profileEmailNotice = '';
    state.profileEmailNoticeTone = 'success';
  });
  $('#profile-password-form')?.addEventListener('submit', handleProfilePasswordSubmit);
}

async function handleProfileEmailAvailabilityCheck() {
  const emailInput = $('#profile-email-form [name="email"]');
  if (!emailInput) return;
  try {
    const payload = await api(`/api/profile/email-availability?email=${encodeURIComponent(emailInput.value)}`);
    state.profileEmailNoticeTone = 'success';
    state.profileEmailNotice = payload.sameAsCurrent ? '当前使用的就是这个邮箱' : '这个邮箱可以使用';
    await renderProfile();
    $('#profile-email-form [name="email"]')?.focus();
  } catch (error) {
    state.profileEmailNoticeTone = 'error';
    state.profileEmailNotice = error instanceof Error ? error.message : String(error);
    await renderProfile();
    $('#profile-email-form [name="email"]')?.focus();
  }
}

async function handleProfileEmailSubmit(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    await api('/api/profile/email', {
      method: 'PUT',
      body: {
        email: form.get('email'),
        currentPassword: form.get('currentPassword'),
      },
    });
    state.profileEmailNoticeTone = 'success';
    state.profileEmailNotice = '邮箱已更新';
    await refreshBootstrap();
    await renderProfile();
  } catch (error) {
    state.profileEmailNoticeTone = 'error';
    state.profileEmailNotice = error instanceof Error ? error.message : String(error);
    await renderProfile();
    if (state.profileEmailNotice.includes('当前密码')) {
      $('#profile-email-form [name="currentPassword"]')?.focus();
      return;
    }
    $('#profile-email-form [name="email"]')?.focus();
  }
}

async function handleSetup(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    await api('/api/setup/admin', {
      method: 'POST',
      body: Object.fromEntries(form.entries()),
    });
    await refreshBootstrap();
    location.hash = '#home';
  } catch (error) {
    showError(error);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    await api('/api/auth/login', {
      method: 'POST',
      body: Object.fromEntries(form.entries()),
    });
    await refreshBootstrap();
    route();
  } catch (error) {
    showError(error);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  try {
    ensureTurnstileToken(event.currentTarget);
    const form = new FormData(event.currentTarget);
    await api('/api/auth/register', {
      method: 'POST',
      body: Object.fromEntries(form.entries()),
    });
    await refreshBootstrap();
    route();
  } catch (error) {
    resetTurnstile(event.currentTarget);
    showError(error);
  }
}

async function handleLogout(event) {
  event.preventDefault();
  try {
    await api('/api/auth/logout', { method: 'POST' });
    await refreshBootstrap();
    location.hash = '#home';
  } catch (error) {
    showError(error);
  }
}

async function handleProfilePasswordSubmit(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const currentPassword = form.get('currentPassword')?.toString() || '';
    const newPassword = form.get('newPassword')?.toString() || '';
    const confirmPassword = form.get('confirmPassword')?.toString() || '';
    if (newPassword !== confirmPassword) {
      state.profilePasswordNoticeTone = 'error';
      state.profilePasswordNotice = '两次输入的新密码不一致';
      await renderProfile();
      $('#profile-password-form [name="confirmPassword"]')?.focus();
      return;
    }
    await api('/api/profile/password', {
      method: 'PUT',
      body: {
        currentPassword,
        newPassword,
      },
    });
    state.profilePasswordNoticeTone = 'success';
    state.profilePasswordNotice = '密码已更新';
    await renderProfile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.profilePasswordNoticeTone = 'error';
    state.profilePasswordNotice = message;
    if (message.includes('当前密码不正确')) {
      await renderProfile();
      $('#profile-password-form [name="currentPassword"]')?.focus();
      return;
    }
    showError(error);
  }
}

async function likePost(postId, page) {
  if (!state.bootstrap.currentUser) {
    showError(new Error('请先登录'));
    return;
  }
  try {
    await api(`/api/posts/${postId}/like`, { method: 'POST' });
    await refreshBootstrap();
    await renderPostDetail(postId, page);
  } catch (error) {
    showError(error);
  }
}

async function likeReply(replyId, postId, page) {
  if (!state.bootstrap.currentUser) {
    showError(new Error('请先登录'));
    return;
  }
  try {
    await api(`/api/replies/${replyId}/like`, { method: 'POST' });
    await refreshBootstrap();
    await renderPostDetail(postId, page);
  } catch (error) {
    showError(error);
  }
}

function setActiveNav(boardId = '') {
  $$('#h a').forEach((node) => node.classList.remove('a'));
  if (!boardId || boardId === 'home') {
    $('#h a[href="#home"]')?.classList.add('a');
    return;
  }
  $$(`#h a`).find((node) => node.getAttribute('href') === `#t/${boardId}`)?.classList.add('a');
}

function renderPager(page, totalPages, hrefFactory) {
  if (totalPages <= 1) {
    return '<p class="end">没有更多啦OwQ</p>';
  }
  const parts = [];
  if (page > 1) {
    parts.push(`<a href="${hrefFactory(page - 1)}">上一页</a>`);
  }
  if (page < totalPages) {
    parts.push(`<a href="${hrefFactory(page + 1)}">下一页</a>`);
  }
  return `<p class="end">${parts.join(' / ')}</p>`;
}

function notificationLabel(type) {
  if (type === 'system_notice') return '发布了系统通知';
  if (type === 'reply') return '回复了你的帖子';
  if (type === 'post_like') return '赞了你的帖子';
  if (type === 'reply_like') return '赞了你的回复';
  return '有了新的提醒';
}

function safeAccentColor(value, fallback = '#99CC66') {
  const color = String(value || '').trim();
  return HEX_COLOR_RE.test(color) ? color : fallback;
}

function boardAccentVar(value) {
  return `--board-accent:${safeAccentColor(value)}`;
}

function renderIdentityBadges(user) {
  return roleBadge(user.role, user.status);
}

function findBoard(boardKey = '') {
  const key = String(boardKey || '').trim();
  if (!key) {
    return null;
  }
  return state.bootstrap.boards.find((board) => board.slug === key || board.id === key) || null;
}

function findBoardById(boardId = '') {
  const key = String(boardId || '').trim();
  if (!key) {
    return null;
  }
  return state.bootstrap.boards.find((board) => board.id === key) || null;
}
