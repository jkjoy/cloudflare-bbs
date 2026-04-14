import md5 from 'blueimp-md5';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { z } from 'zod';
import {
  DEFAULT_SETTINGS,
  type AdminSettings,
  type AdminCapabilities,
  type AppEnv,
  type AppUser,
  type Bindings,
  type Board,
  type CacheBucket,
  type ForumSettings,
  SESSION_COOKIE,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const enc = new TextEncoder();
const DISCUZ_HASH_PREFIX = 'discuzmd5';
type SettingsRecord = Record<string, string>;
const EMPTY_ADMIN_CAPABILITIES: AdminCapabilities = {
  accessAdmin: false,
  manageSettings: false,
  manageBoards: false,
  manageUsers: false,
  manageUserRoles: false,
  suspendUsers: false,
  deleteUsers: false,
  managePosts: false,
  manageRecycle: false,
  manageBackups: false,
  manageProfile: false,
};
const MODERATOR_ADMIN_CAPABILITIES: AdminCapabilities = {
  ...EMPTY_ADMIN_CAPABILITIES,
  accessAdmin: true,
  manageUsers: true,
  suspendUsers: true,
  managePosts: true,
};
const FULL_ADMIN_CAPABILITIES: AdminCapabilities = {
  accessAdmin: true,
  manageSettings: true,
  manageBoards: true,
  manageUsers: true,
  manageUserRoles: true,
  suspendUsers: true,
  deleteUsers: true,
  managePosts: true,
  manageRecycle: true,
  manageBackups: true,
  manageProfile: true,
};

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function parsePage(input: string | undefined): number {
  const page = Number.parseInt(input ?? '1', 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

export function cleanQuery(input: string | undefined): string {
  return (input ?? '').trim().slice(0, 60);
}

export function escapeForLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function normalizeBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

export function normalizeNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function makePreview(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function gravatarHashFromEmail(email: string): string {
  return md5(email.trim().toLowerCase());
}

export function publicUser(user: AppUser) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    bio: user.bio,
    createdAt: user.createdAt,
    avatarHash: gravatarHashFromEmail(user.email),
    capabilities: getAdminCapabilities(user),
  };
}

export function getAdminCapabilities(user: Pick<AppUser, 'role' | 'status'> | null | undefined): AdminCapabilities {
  if (!user || user.status !== 'active') {
    return { ...EMPTY_ADMIN_CAPABILITIES };
  }
  if (user.role === 'admin') {
    return { ...FULL_ADMIN_CAPABILITIES };
  }
  if (user.role === 'moderator') {
    return { ...MODERATOR_ADMIN_CAPABILITIES };
  }
  return { ...EMPTY_ADMIN_CAPABILITIES };
}

export async function readJson<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, '请求体必须是 JSON');
  }
  return schema.parse(raw);
}

export async function resolveSessionUser(c: Context<AppEnv>, token: string | null): Promise<AppUser | null> {
  if (!token) {
    return null;
  }
  const session = await c.env.FORUM_KV.get(`session:${token}`, 'json');
  if (!session || typeof session !== 'object' || session === null || !('userId' in session)) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return null;
  }
  const data = session as { userId: string };
  const row = await c.env.DB.prepare(
    `SELECT id, username, email, role, status, bio, created_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
  ).bind(data.userId).first<{
    id: string;
    username: string;
    email: string;
    role: AppUser['role'];
    status: AppUser['status'];
    bio: string;
    created_at: number;
  }>();
  if (!row || row.status !== 'active') {
    await clearSession(c);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    bio: row.bio,
    createdAt: row.created_at,
  };
}

export async function createSession(c: Context<AppEnv>, user: AppUser): Promise<void> {
  const ttlDays = Number.parseInt(c.env.SESSION_TTL_DAYS ?? '14', 10);
  const maxAge = Math.max(1, ttlDays) * 24 * 60 * 60;
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const secure = new URL(c.req.url).protocol === 'https:';
  await c.env.FORUM_KV.put(
    `session:${token}`,
    JSON.stringify({
      userId: user.id,
      role: user.role,
      createdAt: unixNow(),
    }),
    { expirationTtl: maxAge },
  );
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    maxAge,
  });
}

export async function clearSession(c: Context<AppEnv>): Promise<void> {
  const token = c.get('sessionToken') ?? getCookie(c, SESSION_COOKIE);
  const secure = new URL(c.req.url).protocol === 'https:';
  if (token) {
    await c.env.FORUM_KV.delete(`session:${token}`);
  }
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
  });
}

export function requireUser(c: Context<AppEnv>): AppUser {
  const user = c.get('user');
  if (!user) {
    throw new ApiError(401, '请先登录');
  }
  return user;
}

export function requireAdmin(c: Context<AppEnv>): AppUser {
  const user = requireUser(c);
  if (user.role !== 'admin') {
    throw new ApiError(403, '需要管理员权限');
  }
  return user;
}

export function requireAdminAccess(c: Context<AppEnv>): AppUser {
  const user = requireUser(c);
  if (!getAdminCapabilities(user).accessAdmin) {
    throw new ApiError(403, '需要后台权限');
  }
  return user;
}

export function requireAdminCapability(
  c: Context<AppEnv>,
  capability: keyof AdminCapabilities,
  message = '没有权限执行此操作',
): AppUser {
  const user = requireAdminAccess(c);
  if (!getAdminCapabilities(user)[capability]) {
    throw new ApiError(403, message);
  }
  return user;
}

export async function applyRateLimit(
  c: Context<AppEnv>,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const bucket = Math.floor(unixNow() / windowSeconds);
  const key = `rate:${action}:${ip}:${bucket}`;
  const current = Number.parseInt((await c.env.FORUM_KV.get(key)) ?? '0', 10) + 1;
  await c.env.FORUM_KV.put(key, String(current), {
    expirationTtl: windowSeconds + 5,
  });
  if (current > limit) {
    throw new ApiError(429, '请求过于频繁，请稍后再试');
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomUUID().replaceAll('-', '');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(salt),
      iterations: 210_000,
    },
    key,
    256,
  );
  return `${salt}:${base64Url(new Uint8Array(bits))}`;
}

export function isLegacyPasswordHash(stored: string): boolean {
  const [scheme, salt, expected] = stored.split(':');
  return scheme === DISCUZ_HASH_PREFIX && salt !== undefined && Boolean(expected);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isLegacyPasswordHash(stored)) {
    const [, salt, expected] = stored.split(':');
    return verifyDiscuzPassword(password, salt ?? '', expected ?? '');
  }
  const [salt, expected, extra] = stored.split(':');
  if (!salt || !expected || extra !== undefined) {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(salt),
      iterations: 210_000,
    },
    key,
    256,
  );
  return constantTimeEqual(base64Url(new Uint8Array(bits)), expected);
}

export async function loadSettingsMap(env: Bindings, force = false): Promise<Map<string, string>> {
  return new Map(Object.entries(await loadSettingsRecord(env, force)));
}

export function settingsFromMap(map: Map<string, string>): ForumSettings {
  const turnstileSiteKey = (map.get('turnstile_site_key') ?? DEFAULT_SETTINGS.turnstileSiteKey).trim();
  const turnstileSecretKey = (map.get('turnstile_secret_key') ?? '').trim();
  return {
    forumTitle: map.get('forum_title') ?? DEFAULT_SETTINGS.forumTitle,
    forumDescription: map.get('forum_description') ?? DEFAULT_SETTINGS.forumDescription,
    forumKeywords: map.get('forum_keywords') ?? DEFAULT_SETTINGS.forumKeywords,
    siteNotice: map.get('site_notice') ?? DEFAULT_SETTINGS.siteNotice,
    turnstileSiteKey,
    turnstileEnabled: Boolean(turnstileSiteKey && turnstileSecretKey),
    allowRegistration: normalizeBoolean(map.get('allow_registration'), DEFAULT_SETTINGS.allowRegistration),
    pageSizePosts: normalizeNumber(map.get('page_size_posts'), DEFAULT_SETTINGS.pageSizePosts, 5, 50),
    pageSizeReplies: normalizeNumber(map.get('page_size_replies'), DEFAULT_SETTINGS.pageSizeReplies, 5, 50),
  };
}

export async function loadSettings(env: Bindings, force = false): Promise<ForumSettings> {
  return settingsFromMap(await loadSettingsMap(env, force));
}

export async function loadAdminSettings(env: Bindings, force = false): Promise<AdminSettings> {
  const map = await loadSettingsMap(env, force);
  return {
    ...settingsFromMap(map),
    turnstileSecretKey: (map.get('turnstile_secret_key') ?? '').trim(),
  };
}

export async function loadTurnstileConfig(env: Bindings, force = false): Promise<{
  siteKey: string;
  secretKey: string;
  enabled: boolean;
}> {
  const settings = await loadAdminSettings(env, force);
  return {
    siteKey: settings.turnstileSiteKey,
    secretKey: settings.turnstileSecretKey,
    enabled: settings.turnstileEnabled,
  };
}

export async function verifyTurnstile(
  c: Context<AppEnv>,
  token: string | undefined,
  action: string,
): Promise<void> {
  const config = await loadTurnstileConfig(c.env);
  if (!config.enabled) {
    return;
  }
  const responseToken = token?.trim();
  if (!responseToken) {
    throw new ApiError(400, '请先完成人机验证');
  }

  const body = new URLSearchParams({
    secret: config.secretKey,
    response: responseToken,
  });
  const ip = c.req.header('cf-connecting-ip')?.trim();
  if (ip) {
    body.set('remoteip', ip);
  }

  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (error) {
    console.error('Turnstile verify request failed', error);
    throw new ApiError(502, '人机验证服务暂时不可用');
  }

  if (!response.ok) {
    console.error('Turnstile verify bad status', response.status);
    throw new ApiError(502, '人机验证服务暂时不可用');
  }

  const result = await response.json<{
    success?: boolean;
    action?: string;
    ['error-codes']?: string[];
  }>();

  if (!result.success) {
    console.warn('Turnstile verification failed', {
      action,
      errorCodes: result['error-codes'] ?? [],
    });
    throw new ApiError(400, '人机验证未通过，请重试');
  }

  if (result.action && result.action !== action) {
    console.warn('Turnstile action mismatch', {
      expected: action,
      actual: result.action,
    });
    throw new ApiError(400, '人机验证已失效，请刷新后重试');
  }
}

export async function loadBoards(env: Bindings, force = false): Promise<Board[]> {
  if (!force) {
    return readThroughCache(env, 'meta', 'boards', 30, async () => loadBoards(env, true));
  }
  const { results } = await env.DB.prepare(
    `SELECT id, slug, name, icon, description, accent, sort_order, is_visible
     FROM boards
     ORDER BY sort_order ASC, created_at ASC`,
  ).all<{
    id: string;
    slug: string;
    name: string;
    icon: string;
    description: string;
    accent: string;
    sort_order: number;
    is_visible: number;
  }>();
  return results.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    description: row.description,
    accent: row.accent,
    sortOrder: row.sort_order,
    isVisible: Boolean(row.is_visible),
  }));
}

export async function forumHasAdmin(env: Bindings): Promise<boolean> {
  const cached = await env.FORUM_KV.get('cache:has-admin');
  if (cached) {
    return cached === 'true';
  }
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status != 'deleted'",
  ).first<{ total: number }>();
  const value = Number(row?.total ?? 0) > 0;
  await env.FORUM_KV.put('cache:has-admin', String(value), { expirationTtl: 60 });
  return value;
}

export async function readThroughCache<T>(
  env: Bindings,
  bucket: CacheBucket,
  suffix: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const version = await env.FORUM_KV.get(`cache-version:${bucket}`) ?? '1';
  const key = `cache:${bucket}:${version}:${suffix}`;
  const cached = await env.FORUM_KV.get(key, 'json');
  if (cached !== null) {
    return cached as T;
  }
  const value = await loader();
  await env.FORUM_KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  return value;
}

export async function bumpCacheBuckets(env: Bindings, buckets: CacheBucket[]): Promise<void> {
  await Promise.all(
    [...new Set(buckets)].map(async (bucket) => {
      const key = `cache-version:${bucket}`;
      const current = Number.parseInt((await env.FORUM_KV.get(key)) ?? '1', 10);
      await env.FORUM_KV.put(key, String(current + 1));
      if (bucket === 'meta') {
        await env.FORUM_KV.delete('cache:has-admin');
      }
    }),
  );
}

export function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadSettingsRecord(env: Bindings, force = false): Promise<SettingsRecord> {
  if (!force) {
    return readThroughCache(env, 'meta', 'settings-record', 30, async () => loadSettingsRecord(env, true));
  }
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{
    key: string;
    value: string;
  }>();
  return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

function base64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function verifyDiscuzPassword(password: string, salt: string, expected: string): boolean {
  const inner = md5(password);
  return constantTimeEqual(md5(`${inner}${salt}`), expected.trim().toLowerCase());
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
