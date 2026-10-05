/**
 * 渔港冷库模型：
 * - StorageLedger：每个渔港一条冷库占用台账（容量冗余 + 已占用 + 乐观版本号），并发登记靠版本号互斥
 * - StorageBatch：进港卸货产生的入库批次，按批次提货出库，提完即释放容量
 * - StoragePickup：提货出库流水
 */

/** 冷库占用台账（每渔港一条） */
export interface StorageLedger {
  /** 与渔港 id 相同（主键） */
  portId: string;
  /** 渔港名（冗余，便于提示） */
  portName: string;
  /** 冷库容量 kg（与 FishingPort.coldStorageKg 同步） */
  capacityKg: number;
  /** 已占用 kg（权威库存，所有有效批次剩余量之和） */
  usedKg: number;
  /** 乐观版本号：每笔占用 / 释放 / 提货成功 +1，并发提交时用于互斥 */
  version: number;
  updatedAt: string;
}

/** 冷库入库批次（一次进港卸货至多生成一个批次） */
export interface StorageBatch {
  id: string;
  /** 所属渔港 */
  portId: string;
  /** 来源进港流水 id */
  callId: string;
  vesselId: string;
  vesselName: string;
  /** 本批入库量 kg */
  inflowKg: number;
  /** 已提走 kg */
  pickedKg: number;
  /** 入库时间（ISO 字符串） */
  storedAt: string;
  /** 最近提货时间（ISO 字符串） */
  lastPickedAt: string | null;
  /** 批次状态：在库 / 已提完（已提完记录保留作台账，不占容量） */
  status: '在库' | '已提完';
  createdAt: string;
}

/** 提货出库流水 */
export interface StoragePickup {
  id: string;
  portId: string;
  batchId: string;
  vesselId: string;
  vesselName: string;
  /** 本次提货量 kg */
  amountKg: number;
  time: string;
  createdAt: string;
}

/** 冷库库存聚合（台账 + 批次汇总，页面统一读这一份） */
export interface StorageSummary {
  portId: string;
  capacityKg: number;
  usedKg: number;
  /** 余量 kg */
  freeKg: number;
  /** 占用率 0-1 */
  usageRate: number;
  /** 在库批次数（未提完） */
  batchCount: number;
}
