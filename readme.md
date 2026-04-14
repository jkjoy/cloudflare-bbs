# Micro BBS

基于 Cloudflare Workers + D1 + KV 的微型论坛。

## 已实现

- 初始化向导：首次进入可创建管理员账号并填写论坛标题、简介
- 论坛设置：标题、简介、关键词、公告、注册开关、分页大小
- 板块管理：新增、编辑、显示隐藏、排序、删除空板块
- 用户系统：注册、登录、登出、会话 Cookie、管理员账号更新
- 内容系统：发帖、回复、帖子点赞、回复点赞
- 管理功能：删除帖子、删除用户、修改角色与状态
- 搜索：按关键词搜索帖子和用户
- 分页：帖子列表、回复列表、后台列表均支持分页
- 通知：帖子被回复、帖子被点赞、回复被点赞时收到通知
- 安全：D1 预编译参数、防 XSS 的前端 Markdown 渲染、PBKDF2 密码哈希、基础限流
- 性能：论坛设置、板块和帖子列表使用 KV 读穿缓存
- 备份恢复：管理员可创建 KV 快照备份、下载备份、从备份恢复

## 目录

- `src/index.ts`：Worker API 入口
- `src/lib/core.ts`：鉴权、缓存、限流、密码哈希、通用工具
- `src/lib/data.ts`：论坛查询、通知、级联删除、备份恢复
- `migrations/0001_initial.sql`：D1 数据结构和默认板块
- `public/`：前台页面、后台页面、样式、前端脚本
- `wrangler.toml`：Workers / D1 / KV / Assets 配置

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 创建 Cloudflare 资源并把真实 ID 填入 `wrangler.toml`

- `database_id`
- `kv_namespaces.id`

3. 应用 D1 迁移

```bash
npx wrangler d1 migrations apply micro-bbs --local
```

如果是远程环境，把 `--local` 去掉。

4. 启动开发

```bash
npm run dev
```

5. 打开站点后，先完成初始化向导创建管理员

## 部署

```bash
npm run deploy
```

## 本地 D1 备份并导入远程

如果你要把本地开发环境的 D1 数据带到远程环境，直接用下面这套命令。

1. 只备份本地开发库到 SQL

```bash
npm run d1:backup:local
```

默认会导出到 `backups/d1/local-时间戳.sql`。

2. 只把当前本地 D1 数据导入远程 D1

```bash
npm run d1:import:remote
```

这个命令会自动执行以下动作：

- 从当前本地 D1 按业务表导出数据，生成 `local-时间戳.data.sql`
- 生成一个远程可直接执行的 `local-时间戳.remote-import.sql`
- 先备份当前远程 D1 到 `remote-before-import-时间戳.sql`
- 自动执行远程 D1 migrations
- 清空远程业务表后再导入本地数据
- 自动 bump KV 缓存版本，避免远程页面继续读旧缓存

3. 远程部署时同时同步本地数据

```bash
npm run d1:deploy:with-data
```

这个命令会先备份本地 D1，再同步远程 D1 数据，最后执行 `wrangler deploy`。

### 说明

- 为了避免误把空本地库覆盖到远程，脚本默认会在检测到“本地导出没有任何业务数据”时直接中止。
- 如果你明确就是想清空远程业务数据，可以追加 `-- --allow-empty`。
- 如果你已经有现成 SQL，也可以直接导入：

```bash
npm run d1:import:remote -- --input backups/d1/your-file.sql
```

- 这些脚本只处理 D1 数据；会话、限流、备份快照等 KV 数据不会一起迁移。

## 导入 Discuz `dz.sql`

当前仓库已经补了一个本地转换脚本，可以把 Discuz 的 `dz.sql` 转成当前 D1 结构可直接执行的 SQL。

1. 生成导入 SQL

```bash
npm run import:discuz -- --input dz.sql --output discuz-import.sql
```

如果你的文件名就是仓库根目录下的 `dz.sql`，也可以直接执行：

```bash
npm run import:discuz
```

2. 导入到本地 D1

```bash
npx wrangler d1 execute micro-bbs --local --file=discuz-import.sql
```

如果要导入远程 D1，把 `--local` 去掉。

3. 导入完成后刷新站点

- 脚本会清空当前 D1 里的 `settings / boards / users / posts / replies / likes / notifications`，再写入 Discuz 转换后的数据。
- 论坛设置、板块和帖子列表有 KV 缓存，导入后如果页面还是旧数据，等待约 60 秒再刷新，或直接更换/清空对应 KV。

### 导入范围

- 用户：导入 `pre_common_member + pre_ucenter_members`
- 板块：导入 `pre_forum_forum` 里的 `forum / sub`
- 主题和回复：导入 `pre_forum_thread + pre_forum_post`
- 设置：会读取 `sitename / siteurl / srchhotkeywords / regstatus / topicperpage / postperpage`

### 兼容说明

- 已兼容 Discuz 老密码，导入用户可以继续用原密码登录；首次登录后会自动升级为当前站点使用的 PBKDF2 哈希。
- 附件二进制、点赞记录、通知记录不会迁移；帖子正文中的 Discuz BBCode 会尽量转成 Markdown，可读性优先。
- 游客发帖、缺失作者、重复邮箱或非法邮箱会自动生成占位用户或 `import.local` 邮箱，避免 D1 唯一约束报错。

## 已验证

- `npm run typecheck`
- `node --check scripts/import-discuz.mjs`
- `node --check scripts/d1-sync.mjs`
- `node --check public/scripts/shared.js`
- `node --check public/scripts/app.js`
- `node --check public/scripts/admin.js`
- `npx wrangler deploy --dry-run`

## 说明

- 会话、缓存版本号、限流计数和备份快照都存放在 KV。
- 论坛主数据存放在 D1。
- 当前回复/帖子编辑、附件上传、富文本审计日志、外部对象存储还没有做，如果要继续扩展，可以在现有 API 上直接追加。
