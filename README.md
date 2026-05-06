# 文字云存储

一个轻量的文字信息存储系统，适合保存笔记、会议记录、灵感、摘要等纯文本内容。当前版本使用 Node.js 内置模块实现，无需安装依赖，数据保存在本地 JSON 文件中；部署到云服务器时，把项目放到服务器并设置持久化磁盘即可运行。

## 启动

```bash
npm start
```

默认访问地址：

```text
http://127.0.0.1:3000
```

可通过环境变量调整端口和数据目录：

```bash
PORT=8080 DATA_DIR=/path/to/persistent/data npm start
```

## 功能

- 新增、编辑、删除文字信息
- 标题、内容、标签搜索
- JSON 文件持久化存储
- REST API，便于后续接入移动端、桌面端或云数据库

## API

```text
GET    /api/health
GET    /api/items?q=关键词
POST   /api/items
GET    /api/items/:id
PUT    /api/items/:id
DELETE /api/items/:id
```

`POST /api/items` 和 `PUT /api/items/:id` 的请求体：

```json
{
  "title": "标题",
  "content": "文字内容",
  "tags": "项目, 工作"
}
```

## 云端部署建议

- 小规模个人使用：部署到任意 Node.js 云服务器，挂载持久化磁盘，并把 `DATA_DIR` 指向持久化目录。
- 多人协作或生产环境：把 `server.js` 的 `readItems/writeItems` 换成 PostgreSQL、MySQL、MongoDB 或对象存储。
- 对外开放前：增加登录认证、HTTPS、访问频率限制和自动备份。
