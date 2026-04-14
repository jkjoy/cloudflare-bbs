export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
let toastLayer = null;

export async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
    init.headers = {
      'content-type': 'application/json',
      ...(init.headers || {}),
    };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `请求失败: ${response.status}`);
  }
  return payload;
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function decodeHashPart(value = '') {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function formatRelativeTime(inputSeconds) {
  const now = Date.now();
  const time = Number(inputSeconds || 0) * 1000;
  const delta = Math.max(0, Math.floor((now - time) / 1000));
  if (delta < 60) return `${delta || 1}秒前`;
  if (delta < 3600) return `${Math.floor(delta / 60)}分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}小时前`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}天前`;
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function avatarUrl(hash = '', size = 64) {
  const safeHash = String(hash || '').trim().toLowerCase();
  return `https://cravatar.cn/avatar/${encodeURIComponent(safeHash)}?d=mm&s=${size}`;
}

export function roleBadge(role, status) {
  const tags = [];
  if (role === 'admin') tags.push('<span class="tag admin"><span class="tag-dot">管</span>管理员</span>');
  if (role === 'moderator') tags.push('<span class="tag moderator"><span class="tag-dot">版</span>版主</span>');
  if (role === 'member') tags.push('<span class="tag member"><span class="tag-dot">员</span>成员</span>');
  if (status === 'suspended') tags.push('<span class="tag suspended"><span class="tag-dot">停</span>停用</span>');
  if (status === 'deleted') tags.push('<span class="tag deleted"><span class="tag-dot">删</span>回收站</span>');
  return tags.join(' ');
}

export function buildPager(routeFactory, currentPage, totalPages) {
  if (totalPages <= 1) return '';
  const pages = [];
  const min = Math.max(1, currentPage - 2);
  const max = Math.min(totalPages, currentPage + 2);
  if (currentPage > 1) {
    pages.push(`<a href="${routeFactory(currentPage - 1)}">上一页</a>`);
  }
  for (let page = min; page <= max; page += 1) {
    pages.push(page === currentPage
      ? `<span class="current">${page}</span>`
      : `<a href="${routeFactory(page)}">${page}</a>`);
  }
  if (currentPage < totalPages) {
    pages.push(`<a href="${routeFactory(currentPage + 1)}">下一页</a>`);
  }
  return `<div class="pager">${pages.join('')}</div>`;
}

export function attachMarkdownToolbar(root, textarea) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('.md-btn');
    if (!button) return;
    const cmd = button.dataset.cmd;
    switch (cmd) {
      case 'bold':
        insertAround(textarea, '**', '**', '加粗文本');
        break;
      case 'italic':
        insertAround(textarea, '*', '*', '斜体文本');
        break;
      case 'quote':
        insertAround(textarea, '> ', '', '引用内容');
        break;
      case 'code':
        insertAround(textarea, '```\n', '\n```', '代码片段');
        break;
      case 'link': {
        const url = prompt('请输入链接地址', 'https://');
        if (url) insertAround(textarea, '[', `](${url})`, '链接文本');
        break;
      }
      case 'image': {
        const url = prompt('请输入图片地址', 'https://');
        if (url) insertAround(textarea, '![', `](${url})`, '图片描述');
        break;
      }
      case 'table':
        insertAround(textarea, '', '', '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容1 | 内容2 | 内容3 |');
        break;
      default:
        break;
    }
  });
}

export function insertAround(textarea, before, after, fallback) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end) || fallback;
  textarea.value = `${textarea.value.slice(0, start)}${before}${selected}${after}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
}

export function renderMarkdown(input = '') {
  const codeBlocks = [];
  const inlineCodes = [];
  let source = escapeHtml(input).replace(/\r\n?/g, '\n');

  source = source.replace(/```([\s\S]*?)```/g, (_, code) => {
    const token = `@@CODE${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return token;
  });

  source = source.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `@@INLINE${inlineCodes.length}@@`;
    inlineCodes.push(`<code>${code}</code>`);
    return token;
  });

  const blocks = source.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const htmlBlocks = blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith('&gt;'))) {
      return `<blockquote>${lines.map((line) => inlineMarkdown(line.replace(/^&gt;\s?/, ''))).join('<br>')}</blockquote>`;
    }
    if (isTable(lines)) {
      const [head, , ...rows] = lines;
      const header = head.split('|').map((cell) => cell.trim()).filter(Boolean).map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('');
      const body = rows.map((row) => `<tr>${row.split('|').map((cell) => cell.trim()).filter(Boolean).map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('');
      return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
    }
    return `<p>${lines.map((line) => inlineMarkdown(line)).join('<br>')}</p>`;
  });

  let html = htmlBlocks.join('');
  codeBlocks.forEach((block, index) => {
    html = html.replaceAll(`@@CODE${index}@@`, block);
  });
  inlineCodes.forEach((code, index) => {
    html = html.replaceAll(`@@INLINE${index}@@`, code);
  });
  return html || '<p class="muted">暂无内容</p>';
}

function inlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener nofollow">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function isTable(lines) {
  return lines.length >= 2
    && lines[0].includes('|')
    && /^[\s|:-]+$/.test(lines[1])
    && lines.slice(2).every((line) => line.includes('|'));
}

function getToastLayer() {
  if (toastLayer?.isConnected) {
    return toastLayer;
  }
  toastLayer = document.createElement('div');
  toastLayer.className = 'toast-layer';
  toastLayer.setAttribute('aria-live', 'polite');
  toastLayer.setAttribute('aria-atomic', 'true');
  document.body.appendChild(toastLayer);
  return toastLayer;
}

function dismissToast(node) {
  if (!node?.isConnected) {
    return;
  }
  node.classList.remove('visible');
  window.setTimeout(() => node.remove(), 220);
}

export function showToast(message, type = 'error', duration = 3200) {
  const text = String(message || '').trim();
  if (!text) {
    return;
  }
  const layer = getToastLayer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-copy">${escapeHtml(text)}</div>
    <button type="button" class="toast-close" aria-label="关闭提示">×</button>
  `;
  layer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const timer = window.setTimeout(() => dismissToast(toast), duration);
  toast.querySelector('.toast-close')?.addEventListener('click', () => {
    window.clearTimeout(timer);
    dismissToast(toast);
  });
}

export function showError(error) {
  showToast(error instanceof Error ? error.message : String(error), 'error');
}
