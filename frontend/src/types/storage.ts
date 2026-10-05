/**
 * 冷库库存：按「进港卸货批次」占用容量，按提货批次（pickup）释放容量。
 * 出港不会动库存——只有 pickup 会把 remainingKg 往下减。
 */

/** 库存批次（一次进港卸货 = 一个批次） */
export interface StorageBatch {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 所属渔港名（冗余，便于跨港盘点展示） */
  portName: string;
  /** 卸货渔船 id */
  vesselId: string;
  /** 卸货渔船名 */
  vesselName: string;
  /** 来源进港流水 id */
  callId: string;
  /** 批次入库时间（ISO 字符串，取进港时间） */
  storedAt: string;
  /** 初始入库量 kg */
  totalKg: number;
  /** 当前剩余占用量 kg（提货后递减，归零即该批次完全释放） */
  remainingKg: number;
  /** 已提货量 kg */
  pickedKg: number;
  createdAt: string;
  /** 最后一次提货时间 */
  lastPickupAt: string | null;
}

/** 提货流水（每次渔船提货出库写一条，立即释放对应容量） */
export interface StoragePickup {
  id: string;
  /** 被提货的库存批次 id */
  batchId: string;
  /** 渔港 id（冗余，便于按港查询） */
  portId: string;
  vesselId: string;
  vesselName: string;
  /** 本次提货量 kg */
  quantityKg: number;
  /** 提货后批次剩余量 kg */
  remainingKg: number;
  time: string;
  createdAt: string;
}

/** 渔港级冷库余量聚合 */
export interface StorageSummary {
  portId: string;
  /** 容量（渔港档案登记） */
  capacityKg: number;
  /** 当前占用 = 各批次剩余量之和（不含待盘点流水） */
  occupiedKg: number;
  /** 剩余可用容量 */
  freeKg: number;
  /** 占用率 0-1 */
  usageRate: number;
  /** 在库批次数 */
  batchCount: number;
}

/** 登记进港 / 提货的事务结果 */
export type RegisterResultStatus = 'success' | 'capacity' | 'conflict' | 'invalid';

export interface RegisterFailure {
  status: Exclude<RegisterResultStatus, 'success'>;
  message: string;
  /** 失败时读取到的最新冷库余量（容量不足 / 并发冲突时回显） */
  latest?: StorageSummary;
  /** 容量不足时的缺口 kg */
  shortageKg?: number;
}

export type RegisterResult<T> = ({ status: 'success' } & T) | RegisterFailure;
