/**
 * 冷库 / 泊位并发操作的业务错误。
 * 冲突时携带冲突点的最新余量，登记失败页据此显示「最新余量」。
 */
export interface StorageConflictInfo {
  portId: string;
  portName: string;
  /** 最新容量 kg */
  capacityKg: number;
  /** 最新已占用 kg */
  usedKg: number;
  /** 最新余量 kg */
  freeKg: number;
  /** 本笔申请占用 kg */
  requiredKg: number;
  /** 缺口 kg（申请量 - 最新余量，容量足够时为 0） */
  shortageKg: number;
  /** 冲突后台账版本号 */
  version: number;
}

export class StorageCapacityError extends Error {
  readonly info: StorageConflictInfo;

  constructor(info: StorageConflictInfo) {
    super(
      `冷库容量不足：${info.portName}当前余量 ${info.freeKg} kg，本笔需占用 ${info.requiredKg} kg，缺口 ${info.shortageKg} kg`,
    );
    this.name = 'StorageCapacityError';
    this.info = info;
  }
}

/** 并发提交同一渔港时，后提交者版本号过期 */
export class StorageConflictError extends Error {
  readonly info: StorageConflictInfo;

  constructor(info: StorageConflictInfo) {
    super(`该渔港冷库台账刚被其他登记更新，请按最新余量重新提交`);
    this.name = 'StorageConflictError';
    this.info = info;
  }
}

/** 提货量超过该批次剩余未提量 */
export class PickupExceedError extends Error {
  readonly batchId: string;
  readonly remainingKg: number;

  constructor(batchId: string, remainingKg: number, requestedKg: number) {
    super(`该批次仅剩 ${remainingKg} kg 未提，本次申请提货 ${requestedKg} kg`);
    this.name = 'PickupExceedError';
    this.batchId = batchId;
    this.remainingKg = remainingKg;
  }
}

/** 泊位并发冲突（两台电脑同时抢同一泊位） */
export class BerthConflictError extends Error {
  constructor(berthNo: string, occupier: string | null) {
    super(`泊位 ${berthNo} 刚被${occupier ? `「${occupier}」` : '其他登记'}占用，请刷新后重新选择`);
    this.name = 'BerthConflictError';
  }
}
