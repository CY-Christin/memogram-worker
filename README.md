# Memogram Worker

基于 Cloudflare Workers 的 Telegram 机器人集成，用于把消息/图片同步到 Memos。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<YOUR_GIT_REPO_URL>)

说明：需要公开的 GitHub 或 GitLab 仓库；发布后把 `<YOUR_GIT_REPO_URL>` 换成你的仓库地址。

## 接口

- `POST /telegram/webhook` Telegram webhook 接收入口
- `POST /telegram/setup` 设置 webhook 与 bot 菜单
- `GET /healthz` 健康检查

## 必需 Secrets

- `BOT_TOKEN` Telegram Bot Token
- `MEMOS_TOKEN` Memos Access Token

## 环境变量

- `MEMOS_BASE_URL` 你的 Memos 公网地址，例如 `https://memos.example.com`
- `PAGE_SIZE` 列表页大小，默认 `8`
- `SHOW_MEDIA` 设为 `1` 时，详情用相册展示图片
- `WEBHOOK_URL` 可选，手动指定 webhook 地址

## KV

`MEDIA_GROUPS` 存 `media_group_id -> memo name`，用来保证相册只创建一个 memo（TTL 1 小时）。

## 部署流程

1. 创建 Telegram 机器人  
在 Telegram 里找 `@BotFather` 创建机器人并获取 `BOT_TOKEN`。

2. 获取 Memos Access Token  
在 Memos 中生成一个 Access Token，作为 `MEMOS_TOKEN`。

3. 创建 KV 并绑定  
执行下面命令创建 namespace，然后把返回的 id 写进 `wrangler.toml` 的 `MEDIA_GROUPS`。
```bash
wrangler kv:namespace create media-groups
```

4. 准备本地配置  
从示例文件复制一份正式配置（不要提交）。
```bash
cp wrangler.toml.example wrangler.toml
```
在 `wrangler.toml` 里填写真实 `MEMOS_BASE_URL` 和 KV id。

5. 写入 Secrets  
```bash
wrangler secret put BOT_TOKEN
wrangler secret put MEMOS_TOKEN
```

6. 部署  
```bash
wrangler deploy
```

7. 调用 setup 接口  
部署后执行一次，用于设置 Telegram webhook 和 bot 菜单。
```bash
curl -X POST "https://<你的-worker-域名>/telegram/setup"
```
