# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、冷库容量、渔船技术档案与进出港动态集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率与吨位的渔船档案、记录进出港与泊位占用，并按进港批次管理冷库入库 / 提货出库。

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
| 本地存储 | IndexedDB（Dexie 4，库名 `gbfishport-db`，`liveQuery` 跨标签页同步）+ localStorage（表单草稿） |
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
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / storage.ts（5 个数据模型）
│       ├── stores/             # portStore.ts / vesselStore.ts / uiStore.ts
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / storage.ts（冷库事务与锁）/ seed.ts
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
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数、泊位占用率与冷库余量，支持按等级与避风能力筛选 | FishingPort、Berth、PortCall、StorageBatch |
| `/ports/:id` | 渔港详情：基本信息与补给能力、SVG 泊位网格、冷库批次与提货出库、在港船舶与近日流水 | 五个模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期、冷库在库批次与进出港时间线 | FishingVessel、PortCall、StorageBatch |
| `/calls` | 进出港登记：选择渔船与类型，填写泊位号、加冰量、加油量、卸货量；泊位与冷库同一事务写入，容量不足整笔拒绝；含待盘点旧流水补录 | PortCall、Berth、FishingVessel、StorageBatch |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位与冷库摘要 | FishingPort、Berth、StorageBatch |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：新增 `storageBatches`（冷库批次）、`storagePickups`（提货流水）、`locks`（渔港级互斥锁）表，`calls` 增加 `portId` 索引，旧渔港补默认冷库容量
- **冷库容量联动规则**：
  - 进港填写卸货量时，泊位占用与冷库批次写入在**同一笔 IndexedDB 事务**里提交；冷库容量不足整笔回滚，失败结果带缺口 kg 与最新余量。
  - 渔船提货按批次扣减 `remainingKg` 并立即释放容量；出港只结束航次、释放泊位，**不会**清掉尚未提走的货。
  - 两台电脑（多标签页）同时提交同一渔港时，以 `locks` 表唯一键做渔港级互斥，只有一笔成功，失败页展示后台最新余量；页面数据通过 Dexie `liveQuery` 跨标签页自动刷新。
  - 渔港详情、地图摘要弹窗、渔港卡片与渔船档案均从 store 的同一份库存缓存读取。
  - **旧流水没有 `portId` 时列为「待盘点」**，不生成批次、不自动占用冷库；可在进出港登记页人工补录归属（仅作台账标注，不追补占用）。
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条进出港流水与对应泊位），便于直接查看各页面效果。演示流水刻意不带港口归属，以展示「待盘点」行为。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

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

冷库事务逻辑（容量不足整笔回滚、同港并发只成一笔、提货释放、出港不清库存、旧流水待盘点）可用内存版 IndexedDB 验证：

```bash
npm install --no-save fake-indexeddb tsx
npx tsx scripts/storage-test.ts
```
