# CS2 WebSocket 队长选人

一个可直接部署到 Cloudflare Workers 的纯 Web 选人项目：

- React + Vite 前端
- Cloudflare Worker API
- 每个房间一个 Durable Object
- WebSocket Hibernation 实时同步
- 2–12 人自适应分队
- 房主手动/随机指定两位队长
- ABBA 蛇形选人
- 选人完成后 BO1 地图禁选
- 地图池：Dust II、Mirage、Inferno、Nuke、Ancient、Anubis、Cache
- 浏览器随机令牌恢复身份
- 复制邀请链接和最终阵容
- 地图完成后通过 RCON 调用 MatchZy，自动加载双方队伍、Steam64 ID 和 BO1 地图

> 玩家使用 Steam 登录，房间昵称自动读取 Steam 昵称。

## 环境要求

- Node.js 22.12 或更新版本
- npm
- Cloudflare 账号

## 本地运行

```bash
npm install
npm run dev
```

Vite 会显示本地地址。创建房间后，可以用不同浏览器、隐私窗口或不同设备模拟多名玩家。

## 部署到 Cloudflare

第一次使用 Wrangler：

```bash
npx wrangler login
```

Steam 登录需要配置两个 Cloudflare Secret：

```bash
npx wrangler secret put STEAM_SESSION_SECRET
npx wrangler secret put STEAM_API_KEY
```

`STEAM_SESSION_SECRET` 用于签名登录会话；`STEAM_API_KEY` 使用 Steam Web API Key。不要把这两个值写进代码或提交到 Git。

服务器 RCON 密码也必须配置为 Cloudflare Secret，用于执行 MatchZy 的比赛加载命令：

```bash
npx wrangler secret put RCON_PASSWORD
```

RCON 主机和端口在 `wrangler.jsonc` 中配置。前端只允许执行“开始竞技比赛”，不接受任意 RCON 命令。

然后部署：

```bash
npm run deploy
```

命令结束后会得到类似下面的地址：

```text
https://cs2-draft-room.<你的子域>.workers.dev
```

`wrangler.jsonc` 已经包含：

- Workers Static Assets SPA 配置
- `ROOMS` Durable Object binding
- SQLite-backed `DraftRoom` Durable Object 声明

不需要手动创建 D1、KV 或 Redis。

## 自定义域名

部署成功后，在 Cloudflare Dashboard 中打开 Worker，进入 **Settings / Domains & Routes** 添加自定义域名即可。

## 房间流程

1. 房主创建房间，设置队长后即可开始。
2. 玩家通过 Steam 登录后进入邀请链接，房间昵称自动使用 Steam 昵称。
3. 房主手动或随机指定两名队长。
4. 房主点击“开始选人”。
5. 两位队长按 `A → B → B → A` 循环选择。
6. 选人完成后，房主开始 BO1 地图禁选。
7. 两位队长按 `A → B → B → A → A → B` 禁用地图，最后剩余地图为比赛地图。

## 主要文件

```text
worker/index.ts     Worker 路由、Durable Object、WebSocket、选人规则
src/App.tsx         前端页面和实时连接
src/styles.css      界面样式
wrangler.jsonc      Cloudflare 部署配置
```

## 当前版本的安全边界

- 玩家身份令牌保存在浏览器 LocalStorage 中。
- Durable Object 只保存令牌的 SHA-256 摘要。
- WebSocket 连接会校验令牌，队长与房主权限由后端判断。
- 房间号不是密码。拿到邀请链接且已 Steam 登录的人可以加入尚未满员的房间。

## 后续可添加

- 房间密码
- Ready 状态
- 选人倒计时和自动选择
- 玩家主动退出/房主转移
- 管理员封禁名单
- D1 历史记录和战绩
- Steam OpenID 登录和 Steam 昵称同步
