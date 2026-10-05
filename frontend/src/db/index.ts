import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { StorageBatch, StoragePickup } from '../types/storage';
import { buildBerthRecords } from './berth';
import { DEFAULT_COLD_STORAGE_KG } from './seed';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 新增冷库批次 / 提货流水 / 渔港级操作锁，calls 增加 portId 索引，旧渔港补默认冷库容量。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  storageBatches!: Table<StorageBatch, string>;
  storagePickups!: Table<StoragePickup, string>;
  /** key = 渔港 id 的互斥锁，保证两台电脑同时提交同一渔港只有一笔成功 */
  locks!: Table<{ id: string; owner: string; leasedAt: string }, string>;

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
        // calls 补 portId 索引（旧流水 portId 缺失，查不到即「待盘点」，不自动占用冷库）
        calls: 'id, vesselId, type, time, portId',
        storageBatches: 'id, portId, vesselId, callId',
        storagePickups: 'id, batchId, portId, time',
        locks: 'id',
      })
      .upgrade(async (tx) => {
        // 旧渔港补默认冷库容量；旧流水没有港口归属，一律不生成批次、不占用冷库
        await tx
          .table<FishingPort, string>('ports')
          .toCollection()
          .modify((port) => {
            if (typeof port.coldStorageKg !== 'number' || !Number.isFinite(port.coldStorageKg)) {
              port.coldStorageKg = DEFAULT_COLD_STORAGE_KG;
            }
          });
      });
  }
}

export const db = new FishPortDatabase();
