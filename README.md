# mmoproxy

CCW MMO 账号聚合项目。

## 开发

```sh
npm install
npm run dev
```

Express API 运行在 `http://localhost:3000`。Vite 会将 `/api` 请求代理到后端。

## 构建与启动

```sh
npm run build
npm start
```

前端静态文件输出到 `dist/frontend`，后端使用 esbuild 将入口和依赖打包为单个 `dist/backend/index.cjs`。生产服务默认监听 `3000` 端口，可通过 `PORT` 环境变量调整。

应用会自动加载项目根目录的 `.env` 文件。可从 `.env.example` 复制后填写配置；敏感配置文件已加入 `.gitignore`。系统设置页面保存 `.env` 后，会立即重载当前进程中的易支付参数。

## Docker 部署

复制 Docker Compose 环境变量模板并修改数据库密码：

```sh
cp .env.docker.example .env
```

设置 `DB_PASSWORD` 和 `MARIADB_ROOT_PASSWORD` 为不同的强密码后启动：

```sh
docker compose up --build -d
```

应用运行在 `http://localhost:3000`，HTTP/WebSocket 代理端口为 `9989`。Compose 会自动启动 MariaDB 和 Redis，并为应用配置 MySQL 及 Redis 连接；数据库和 Redis 只在 Compose 内部网络开放。MariaDB 和 Redis 数据分别保存在 Docker 命名卷中。查看日志或停止服务：

```sh
docker compose logs -f app
docker compose down
```

## 数据库配置

默认使用项目目录下的 SQLite 文件 `user.db`，无需额外配置。设置 `SQLITE_PATH` 可指定 SQLite 文件路径。

切换到 MySQL 时，可通过连接 URL 配置：

```sh
DB_TYPE=mysql DATABASE_URL='mysql://user:password@localhost:3306/mmoproxy' npm start
```

也可以通过独立连接参数配置：

```sh
DB_TYPE=mysql DB_HOST=localhost DB_PORT=3306 DB_USER=user DB_PASSWORD=password DB_NAME=mmoproxy npm start
```

配置 `DATABASE_URL` 的 `mysql://` 地址也会自动选择 MySQL；配置 `DB_TYPE=sqlite` 可明确选择 SQLite。两种数据库都会自动创建 `users` 表，应用使用相同的数据库接口。

## 登录会话

登录页提供账号注册和登录入口。会话默认存储在进程内的 `globalThis.kv` 中，进程重启后会失效，有效期为 24 小时。需要使用 Redis 时，设置 `REDIS_ENABLED=true` 启用，并可通过 `REDIS_URL` 配置连接地址；启用后 Redis 不可用时，登录和已登录状态校验会返回错误。

用户密码使用 SHA-256 摘要保存。首次启动且用户表为空时，应用会生成一个随机用户名和随机口令的管理员，并将凭据打印到服务端日志；请妥善保管日志并使用该账号登录。旧数据库中的明文用户密码会在启动时迁移为 SHA-256 摘要。

登录后的工作空间对所有用户开放，首页显示本文件。管理员权限由以下权限节点控制：

- `admin.users.read`：查看用户列表、权限和用户数据。
- `admin.users.edit`：创建用户、修改用户权限和密码。
- `admin.pool.read`：查看号池账号和用户标识，不显示密码或登录令牌。
- `admin.pool.edit`：添加和移除号池账号（支持账号密码或仅 token）、修改账号密码，或让密码账号立即登录并刷新 token。号池密码为代理登录上游服务所需，会以明文保存在数据库中；修改密码会清除缓存的登录令牌。
- `admin.config.rw`：查看和修改 `.env` 配置、生成一次性兑换码。
- `user.plan.read`：查看可用套餐。
- `user.key`：在左侧密钥管理页面为自己的 WebSocket 密钥命名、重命名、移除和轮换；此权限不允许查看其他用户的密钥。

管理操作会由服务端校验登录会话及对应权限；新注册用户默认拥有 `user.login` 和 `user.plan.read` 权限。左侧个人中心始终显示，包含用户名、余额、易支付充值和兑换码兑换。

## 套餐与计费

当前套餐为默认的“按量计费”，标价为 `0.1 元/分钟`。每条成功建立的 WebSocket 代理连接开始时扣除 0.1 元，此后每满一分钟扣除 0.1 元；余额不足时拒绝新连接，并在活动连接下一计费周期到来时关闭连接。余额以分为单位保存在用户记录中。易支付通知经签名校验，充值订单只能入账一次。

复制 `.env.example` 为 `.env` 并填写易支付商户配置。`APP_BASE_URL` 应设置为外部可访问的 HTTPS 网站地址，以便易支付平台回调：

- `EPAY_URL`：易支付网关地址（以 `/` 结尾）。
- `EPAY_PID`、`EPAY_KEY`：商户编号和商户密钥。
- `EPAY_TYPE`：支付方式，默认为 `alipay`；多个支付方式可用逗号分隔（例如 `alipay,wxpay`），用户充值时可选择。
- `EPAY_SITENAME`：支付页面显示的网站名称。

管理员可在“系统设置”中生成带面额的兑换码。兑换码是 256 位十六进制随机数，只显示一次，数据库仅保存其 SHA-256 摘要，且每个兑换码只能成功兑换一次。

## HTTP 和 WebSocket 代理

后端另外监听 HTTP 和 WebSocket 代理端口，默认地址为 `http://0.0.0.0:9989` / `ws://0.0.0.0:9989`，通过 `WS_PROXY_HOST` 和 `WS_PROXY_PORT` 配置监听地址。WebSocket 上游默认为 `wss://ws.example.com`，可通过 `WS_UPSTREAM_URL` 配置；HTTP 上游默认为 WebSocket 上游的 HTTPS 地址，也可通过 `HTTP_UPSTREAM_URL` 单独配置。客户端请求的路径、查询参数、方法、请求体和响应会转发到上游。

HTTP 和 WebSocket 流量均由 `http-proxy` 库负责转发。

每个连接都必须提供 `Authorization: Bearer <key>`。`bearer_tokens` 表用 `key` 主键索引令牌，并用 `id` 关联 `users.id`；只有表中关联到现存用户的令牌才会获准连接。令牌由部署方写入数据库，例如：

```sql
INSERT INTO bearer_tokens (`key`, id) VALUES ('<random-secret>', <user-id>);
```

具有 `user.key` 权限的用户也可在工作空间中自助创建并命名密钥，之后可重命名。新密钥和轮换后的密钥只在操作成功时返回并显示一次；数据库仅保存 SHA-256 摘要，列表不会显示密钥内容。每个用户只能管理自己的密钥。原先直接写入 `bearer_tokens` 表的令牌仍可用于兼容部署。

创建的密钥用于 WebSocket 握手请求的 `Authorization: Bearer <密钥>` 请求头。

号池数据存放在 `number_pool` 表中。每行必须有唯一的 `uuid`，`token`、`password` 和 `cookie-user-id` 可为空；连接时随机选一行，Cookie 以 `token=<token>; cookie-user-id=<cookie-user-id>` 形式注入（`cookie-user-id` 为空时兼容使用 `uuid`）。可用数据库 SQL 增删号池记录。启动时会用 token 请求 CCW 学生详情接口验证账号；token 无效时，密码账号会尝试重新登录，仅 token 账号则直接标记无效。号池管理页面会显示验证状态和登录失败信息。若随机选中记录的 `token` 为空，代理会用账号密码调用 CCW 登录接口并查询学生 OID，随后将 token 和 `cookie-user-id` 保存到号池记录。登录生成的完整 Cookie 按 `uuid:password` 在内存缓存 30 分钟。

上游会收到客户端的普通请求头（不包括客户端的 Bearer 授权头和 Cookie），WebSocket 握手头由代理重建。设置 `WS_PROXY_HEADERS` 可用 JSON 对象增加或替换普通上游请求头，例如 `{"x-client-type":"proxy"}`；Cookie 始终由号池生成，协议/连接类请求头不允许覆盖。

HTTP 请求与 WebSocket 共用 Bearer 密钥验证、号池 Cookie 注入和 `WS_PROXY_HEADERS` 上游请求头配置；每个 HTTP 请求固定扣除 1 分钟费用，WebSocket 连接仍按连接时长计费。

## 目录

- `src/frontend`：Vite + React 前端
- `src/backend`：Express 后端及其构建脚本
