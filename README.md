# Risk Detection Dashboard

一个用于识别 risk 玩家行为的 dashboard。上传订单 CSV 后，系统会按 `user_id` 聚合投注、派彩、净赢、RTP、active 时间、IP 分布、策略、子弹等级、鱼值和投注时段，并生成可筛选、可排序、可点击查看玩家明细的页面。

## 启动

```bash
npm start
```

默认访问：

```text
http://127.0.0.1:3000
```

可通过环境变量调整端口和数据目录：

```bash
PORT=8080 DATA_DIR=/path/to/persistent/data npm start
```

## CSV 字段

Dashboard 会使用这些字段：

- `user_id`
- `user_name`
- `nick_name`
- `duration`
- `bet`
- `payout`
- `profit`
- `ip`
- `event_timestamp`
- `strategy_name`
- `bullet_level`
- `multiplier`
- `fish_value`

没有投注记录的用户也会展示在排行中，并标记为 `无投注记录`。

## API

```text
GET  /api/health
GET  /api/dashboard-data
POST /api/upload-dashboard-data
```

`POST /api/upload-dashboard-data` 使用 `multipart/form-data`：

- `dataFile`: CSV 文件
- `lookupIps`: 可选，值为 `on` 时会调用 `ip-api.com` 解析 risk IP 地区

## 部署

项目包含 Docker 和 Render Blueprint 配置：

- `Dockerfile`
- `requirements.txt`
- `render.yaml`

部署到 Render 时，`render.yaml` 会创建 web service 和 `/app/data` 持久磁盘，用于保存上传 CSV、生成后的 dashboard JSON 和 IP 查询缓存。
