# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、渔船技术档案与进出港动态集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率与吨位的渔船档案、记录进出港与泊位占用。

## 一键启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21828>

停止：

```bash
docker compose down
```

## 技术栈

| 分类 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 |
| UI | Element Plus 2 |
| 状态 | Pinia |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbfishport-db`）+ localStorage（表单草稿） |
| 并发控制 | 进港流水 / 泊位占用 / 冷库占用同一 IndexedDB 事务提交；渔港级 Web Lock + 台账乐观版本号互斥 |
| 地图 | 高德地图 JS API（`VITE_AMAP_KEY`），未配置 key 时降级为本地 SVG 网格视图 |
| 托管 | nginx:alpine（gzip + 前端路由回退） |

## 目录结构

```
sologsb-1128/
├── docker-compose.yml          # 无 version 字段；顶层 name: gbfishport
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / storage.ts（冷库台账、批次、提货流水）
│       ├── stores/             # portStore.ts（冷库库存统一出口）/ vesselStore.ts / uiStore.ts
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / storage.ts（冷库事务）/ errors.ts / seed.ts
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / EmptyState
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / MapView
│       ├── router/index.ts
│       └── utils/              # tonnage.ts / geo.ts / format.ts
└── README.md
```

## 页面与路由

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数、泊位占用率与冷库余量，支持按等级与避风能力筛选 | FishingPort、Berth、PortCall、StorageLedger |
| `/ports/:id` | 渔港详情：基本信息与补给能力、冷库库存与提货出库、SVG 泊位网格、在港船舶与本港流水 | 全部模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期、进出港时间线与冷库在库货物 | FishingVessel、PortCall、StorageBatch |
| `/calls` | 进出港登记：进港卸货同事务占用泊位与冷库（容量不足整笔拒绝并显示缺口），出港只结束航次；待盘点旧流水在此人工归档 | PortCall、Berth、FishingVessel、Storage* |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记 / SVG 降级网格，点选弹出泊位与冷库摘要 | FishingPort、Berth、StorageLedger |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：渔港增加 `coldStorageKg`；`calls` 增加 `portId` / `batchId` 索引；新增冷库三表 `storageLedgers`（每渔港一条台账）、`storageBatches`（入库批次）、`storagePickups`（提货流水）
- **冷库容量与进出港流水的一致性规则**：
  - **进港**：写流水、占用泊位、占用冷库空间在**同一笔 Dexie 事务**里完成；容量不足时整笔回滚（泊位与流水都不落库），错误信息带最新余量与缺口。
  - **提货出库**：按批次核减剩余量并立即释放等量容量（同事务）；提货超过批次剩余量整笔拒绝；批次提完后置为「已提完」，保留台账但不占容量。
  - **出港**：只结束航次、释放泊位；**不清冷库批次、不释放容量**，未提走的货继续在库，需在渔港详情办理提货。
  - **并发**：同一渔港的登记 / 提货 / 容量调整共用渔港级 Web Lock 串行化，叠加台账 `version` 乐观版本号——两台终端同时提交同一渔港时只有一笔成功，失败者重读台账并在失败页展示最新余量。
  - **同一份库存**：冷库余量只认 `storageLedgers.usedKg`（与在库批次剩余量之和一致），渔港详情、渔港一览卡片、地图摘要、渔船档案均经 `portStore.storageOf()` 读取。
  - **待盘点旧流水**：没有 `portId` 归属的旧流水（含演示数据）统一列为「待盘点」，**绝不自动占用冷库**；可在进出港登记页人工归档（仅补归属，历史卸货量不追溯入库）。
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`，提交成功后自动清空。
- **跨标签页同步**：写完数据后经 `BroadcastChannel`（不支持时退回 storage 事件 / 页面重新可见时重读）通知另一标签页的早班 / 晚班终端刷新同一份库存。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条待盘点进出港流水与对应泊位），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。
- 纯前端架构下数据只存在各终端本地，Web Lock 覆盖同一台电脑多个标签页 / 窗口的并发；真正的两台物理电脑之间要共享同一份库存，仍需引入后端服务。

## 高德地图 Key（可选）

`VITE_AMAP_KEY` 留空时**不会**请求任何外部地图服务，`useAmapLoader()` 立即返回降级标记，页面渲染本地 SVG 网格视图（可点选查看泊位占用）。需要真实底图时，在 `.env` 中填入 key 后重新构建：

```bash
VITE_AMAP_KEY=your-key docker compose up -d --build
```

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev
```

构建校验（类型检查 + 打包）：`npm run build`（等价于 `vue-tsc -b && vite build`）。

冷库事务 / 并发 / 迁移验证（基于 fake-indexeddb，无需浏览器）：

```bash
npm run verify:storage
```

覆盖：进港同事务占用、容量不足整笔拒绝与缺口、同渔港并发乐观版本号互斥、同泊位竞争、
提货按批次释放容量、出港不清冷库、旧流水不占冷库，以及 Dexie v3→v4 升级迁移。
