import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { StorageBatch, StorageLedger, StoragePickup } from '../types/storage';
import { buildBerthRecords } from './berth';

/** 旧版本渔港没有冷库容量字段时，迁移使用的默认容量 kg */
export const DEFAULT_COLD_STORAGE_KG = 20000;

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录。
 * v4：渔港增加冷库容量；calls 增加 portId / batchId 索引（旧流水 portId 留空，列为待盘点，不占冷库）；
 *     新增 storageLedgers / storageBatches / storagePickups 三张冷库表。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  storageLedgers!: Table<StorageLedger, string>;
  storageBatches!: Table<StorageBatch, string>;
  storagePickups!: Table<StoragePickup, string>;

  constructor() {
    super('gbfishport-db');

    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });

    this.version(2)
      .stores({
        calls: 'id, vesselId, type, time',
      })
      .upgrade(async (tx) => {
        // v2 迁移：新增 calls 表与 vesselId 索引，回填历史记录的冗余字段
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.vesselName) call.vesselName = '';
            if (!call.visaStatus) call.visaStatus = '待签证';
          });
      });

    this.version(3)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // v3 迁移：新增 berths 表，并按每个渔港登记的泊位数生成初始泊位记录
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const berthTable = tx.table<Berth, string>('berths');
        for (const port of ports) {
          const existing = await berthTable.where('portId').equals(port.id).count();
          if (existing === 0) {
            await berthTable.bulkPut(buildBerthRecords(port));
          }
        }
      });

    this.version(4)
      .stores({
        // 新增 portId / batchId 索引；旧记录 portId 缺失（null 不进索引），查询时全表过滤
        calls: 'id, vesselId, type, time, portId, batchId',
        // 第一项即主键（入站主键 portId，与渔港 id 一致）；version 为普通索引
        storageLedgers: 'portId, version',
        storageBatches: 'id, portId, vesselId, status, callId',
        storagePickups: 'id, portId, batchId, time',
      })
      .upgrade(async (tx) => {
        // 旧渔港补冷库容量；旧流水一律不补 portId（列为待盘点，绝不自动占用冷库）
        await tx
          .table<FishingPort, string>('ports')
          .toCollection()
          .modify((port) => {
            if (typeof port.coldStorageKg !== 'number' || !Number.isFinite(port.coldStorageKg)) {
              port.coldStorageKg = DEFAULT_COLD_STORAGE_KG;
            }
          });

        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            // v4 升级时库内流水均为旧结构，直接补港口归属与批次 id；
            // 旧流水 portId 一律置 null（待盘点），绝不替它归属渔港或追溯占用冷库
            call.portId = null;
            call.batchId = null;
          });

        // 为每个渔港建立冷库台账基线（usedKg 为 0；历史卸货量不追溯入库，避免冷库凭空超量）
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const ledgerTable = tx.table<StorageLedger, string>('storageLedgers');
        const now = new Date().toISOString();
        for (const port of ports) {
          const exists = await ledgerTable.get(port.id);
          if (!exists) {
            await ledgerTable.put({
              portId: port.id,
              portName: port.name,
              capacityKg: port.coldStorageKg,
              usedKg: 0,
              version: 0,
              updatedAt: now,
            });
          }
        }
      });
  }
}

export const db = new FishPortDatabase();
