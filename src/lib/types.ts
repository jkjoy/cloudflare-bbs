import { z } from 'zod';

export type Role = 'member' | 'moderator' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'deleted';
export type AdminCapabilities = {
  accessAdmin: boolean;
  manageSettings: boolean;
  manageBoards: boolean;
  manageUsers: boolean;
  manageUserRoles: boolean;
  suspendUsers: boolean;
  deleteUsers: boolean;
  managePosts: boolean;
  manageRecycle: boolean;
  manageBackups: boolean;
  manageProfile: boolean;
};

export type Bindings = {
  DB: D1Database;
  FORUM_KV: KVNamespace;
  ASSETS: Fetcher;
  SESSION_TTL_DAYS?: string;
};

export type AppUser = {
  id: string;
  username: string;
  email: string;
  role: Role;
  status: UserStatus;
  bio: string;
  createdAt: number;
};

export type Variables = {
  user: AppUser | null;
  sessionToken: string | null;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type CacheBucket = 'meta' | 'posts' | 'notifications' | 'admin';

export type ForumSettings = {
  forumTitle: string;
  forumDescription: string;
  forumKeywords: string;
  siteNotice: string;
  turnstileSiteKey: string;
  turnstileEnabled: boolean;
  allowRegistration: boolean;
  pageSizePosts: number;
  pageSizeReplies: number;
};

export type AdminSettings = ForumSettings & {
  turnstileSecretKey: string;
};

export type Board = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  description: string;
  accent: string;
  sortOrder: number;
  isVisible: boolean;
};

export type PublicPostItem = {
  id: string;
  boardId: string;
  boardSlug: string;
  boardName: string;
  boardIcon: string;
  boardAccent: string;
  isPinned: boolean;
  title: string;
  contentPreview: string;
  replyCount: number;
  likeCount: number;
  viewCount: number;
  createdAt: number;
  lastActivityAt: number;
  author: {
    id: string;
    name: string;
    role: Role;
    avatarHash: string;
  };
};

export type ForumSnapshot = {
  version: number;
  createdAt: number;
  tables: {
    settings: Array<Record<string, unknown>>;
    boards: Array<Record<string, unknown>>;
    users: Array<Record<string, unknown>>;
    posts: Array<Record<string, unknown>>;
    replies: Array<Record<string, unknown>>;
    likes: Array<Record<string, unknown>>;
    notifications: Array<Record<string, unknown>>;
  };
};

export const SESSION_COOKIE = 'bbs_session';

export const DEFAULT_SETTINGS: ForumSettings = {
  forumTitle: 'Hi~是这！',
  forumDescription: '一个运行在 Cloudflare Workers 上的微型论坛。',
  forumKeywords: 'cloudflare,worker,d1,bbs',
  siteNotice: '欢迎来到这个轻量讨论版。',
  turnstileSiteKey: '',
  turnstileEnabled: false,
  allowRegistration: true,
  pageSizePosts: 12,
  pageSizeReplies: 15,
};

export const usernameSchema = z
  .string()
  .trim()
  .min(2, '用户名至少 2 个字符')
  .max(20, '用户名最多 20 个字符')
  .regex(/^[\p{L}\p{N}_-]+$/u, '用户名只允许中文、字母、数字、下划线和短横线');

export const emailSchema = z.string().trim().email('邮箱格式不正确').max(120);
export const existingPasswordSchema = z.string().min(1, '请输入密码').max(200, '密码过长');
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(72, '密码过长');
export const boardSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,15}$/u, '板块标识需要 2-16 位小写字母、数字或短横线');

export const setupSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  forumTitle: z.string().trim().min(1).max(60).optional(),
  forumDescription: z.string().trim().max(160).optional(),
});

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  turnstileToken: z.string().trim().min(1).max(2048).optional(),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(2).max(120),
  password: existingPasswordSchema,
});

export const createPostSchema = z.object({
  boardId: boardSlugSchema,
  title: z.string().trim().min(2).max(120),
  content: z.string().trim().min(2).max(20000),
  turnstileToken: z.string().trim().min(1).max(2048).optional(),
});

export const createReplySchema = z.object({
  content: z.string().trim().min(1).max(10000),
  turnstileToken: z.string().trim().min(1).max(2048).optional(),
});

export const markNotificationsSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(200).optional(),
  markAll: z.boolean().optional(),
});

export const settingsSchema = z.object({
  forumTitle: z.string().trim().min(1).max(60),
  forumDescription: z.string().trim().max(160),
  forumKeywords: z.string().trim().max(200),
  siteNotice: z.string().trim().max(300),
  turnstileSiteKey: z.string().trim().max(200),
  turnstileSecretKey: z.string().trim().max(200),
  allowRegistration: z.boolean(),
  pageSizePosts: z.number().int().min(5).max(50),
  pageSizeReplies: z.number().int().min(5).max(50),
});

export const boardSchema = z.object({
  slug: boardSlugSchema,
  name: z.string().trim().min(1).max(30),
  icon: z.string().trim().min(1).max(4),
  description: z.string().trim().max(120),
  accent: z.string().trim().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, '颜色格式不正确'),
  sortOrder: z.number().int().min(0).max(999),
  isVisible: z.boolean(),
});

export const updateUserSchema = z.object({
  role: z.enum(['member', 'moderator', 'admin']),
  status: z.enum(['active', 'suspended']),
  bio: z.string().trim().max(240).optional(),
});

export const idBatchSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1, '请至少选择一项').max(200, '单次最多处理 200 项'),
});

export const pinPostSchema = z.object({
  isPinned: z.boolean(),
});

export const adminProfileSchema = z.object({
  username: usernameSchema.optional(),
  email: emailSchema.optional(),
  currentPassword: existingPasswordSchema,
  newPassword: passwordSchema.optional(),
});

export const userPasswordSchema = z.object({
  currentPassword: existingPasswordSchema,
  newPassword: passwordSchema,
});

export const userEmailSchema = z.object({
  email: emailSchema,
  currentPassword: existingPasswordSchema,
});

export const backupSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
});
