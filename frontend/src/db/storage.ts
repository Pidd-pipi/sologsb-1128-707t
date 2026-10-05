import { db } from './index';
import { uid } from '../utils/format';
import type { CallDraft, PortCall } from '../types/call';
import type { RegisterResult, StorageBatch, StoragePickup, StorageSummary } from '../types/storage';

/** 锁租约：持锁标签页崩溃时，超过该时长允许其他提交者接管 */
const LOCK_TTL_MS = 15000;

export class TxReject extends Error {
  constructor(
    public code: 'capacity' | 'invalid' | 'conflict',
    message: string,
    public shortageKg = 0,
  ) {
    super(message);
    this.name = 'TxReject';
  }
}

function summarize(capacityKg: number, batches: StorageBatch[]): StorageSummary {
  const occupiedKg = batches.reduce((sum, b) => sum + b.remainingKg, 0);
  const freeKg = capacityKg - occupiedKg;
  return {
    portId: '',
    capacityKg,
    occupiedKg,
    freeKg,
    usageRate: capacityKg > 0 ? Math.min(1, occupiedKg / capacityKg) : occupiedKg > 0 ? 1 : 0,
    batchCount: batches.filter((b) => b.remainingKg > 0).length,
  };
}

/** 直接读库计算某渔港最新冷库余量（失败页要展示「最新余量」时用它） */
export async function getStorageSummary(portId: string): Promise<StorageSummary> {
  const [port, batches] = await Promise.all([
    db.ports.get(portId),
    db.storageBatches.where('portId').equals(portId).toArray(),
  ]);
  return { ...summarize(port?.coldStorageKg ?? 0, batches), portId };
}

/**
 * 获取渔港级互斥锁（一次性，不排队）。两台电脑同时提交同一渔港时只有一笔成功；
 * 锁行用 IndexedDB 唯一键的 add 原子性保证。持锁页崩溃超过租约则允许接管。
 */
async function acquireLock(portId: string, owner: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    await db.locks.add({ id: portId, owner, leasedAt: nowIso });
    return true;
  } catch (error) {
    if ((error as DOMException).name !== 'ConstraintError') throw error;
    const existing = await db.locks.get(portId);
    if (!existing) {
      // 持锁者刚好释放 / 事务回滚清锁：视为竞争窗口，本笔仍判失败，由页面按最新余量重试
      return false;
    }
    const age = Date.now() - new Date(existing.leasedAt).getTime();
    if (Number.isFinite(age) && age > LOCK_TTL_MS) {
      const updated = await db.locks.update(portId, { owner, leasedAt: nowIso });
      return updated > 0;
    }
    return false;
  }
}

async function releaseLock(portId: string, owner: string): Promise<void> {
  const existing = await db.locks.get(portId);
  if (existing?.owner === owner) await db.locks.delete(portId);
}

export interface CallSuccess {
  call: PortCall;
  batch: StorageBatch | null;
  summary: StorageSummary;
}

/**
 * 登记进出港——一笔 Dexie 事务里同时完成：
 * - 进港：校验泊位空闲 + 冷库余量，写流水、占泊位、写库存批次（三者同生共死）
 * - 出港：只结束航次、释放泊位，绝不触碰尚未提走的库存
 * 容量 / 泊位不满足时整笔回滚，由调用方按结果渲染缺口与最新余量。
 */
export async function submitCall(
  draft: CallDraft,
  vesselName: string,
  portId: string,
): Promise<RegisterResult<CallSuccess>> {
  if (!portId) return { status: 'invalid', message: '请先选择渔港泊位' };
  if (!draft.vesselId) return { status: 'invalid', message: '请选择渔船' };

  const owner = uid('lock');
  const locked = await acquireLock(portId, owner);
  if (!locked) {
    return {
      status: 'conflict',
      message: '另一台电脑正在提交该渔港，请以后台最新余量为准后重试',
      latest: await getStorageSummary(portId),
    };
  }

  const callId = uid('c');
  const time = draft.time ? new Date(draft.time).toISOString() : new Date().toISOString();
  const unloadKg = Math.max(0, Number(draft.unloadKg) || 0);

  try {
    const result = await db.transaction('rw', [db.calls, db.berths, db.ports, db.storageBatches], async () => {
      const port = await db.ports.get(portId);
      if (!port) throw new TxReject('invalid', '渔港不存在或已被删除');
      const berth = await db.berths.get(`${portId}-${draft.berthNo}`);
      if (!berth) throw new TxReject('invalid', `泊位 ${draft.berthNo} 不存在`);

      let batch: StorageBatch | null = null;
      if (draft.type === '进港') {
        if (berth.status !== '空闲') {
          throw new TxReject('conflict', `泊位 ${draft.berthNo} 已被 ${berth.vesselName ?? '其他渔船'} 占用，请改选空闲泊位`);
        }
        const liveBatches = await db.storageBatches.where('portId').equals(portId).toArray();
        const occupiedKg = liveBatches.reduce((sum, b) => sum + b.remainingKg, 0);
        const freeKg = port.coldStorageKg - occupiedKg;
        if (unloadKg > freeKg) {
          throw new TxReject(
            'capacity',
            `冷库容量不足：本次卸货 ${unloadKg} kg，仅剩 ${freeKg} kg`,
            unloadKg - freeKg,
          );
        }

        if (unloadKg > 0) {
          batch = {
            id: uid('b'),
            portId,
            portName: port.name,
            vesselId: draft.vesselId,
            vesselName,
            callId,
            storedAt: time,
            totalKg: unloadKg,
            remainingKg: unloadKg,
            pickedKg: 0,
            createdAt: new Date().toISOString(),
            lastPickupAt: null,
          };
          await db.storageBatches.put(batch);
        }

        await db.berths.put(
          toPlainBerth({
            ...berth,
            status: '占用',
            vesselId: draft.vesselId,
            vesselName,
            berthAt: time,
            leaveAt: null,
          }),
        );
      } else {
        // 出港只结束航次：不登记卸货，也绝不清库存
        if (unloadKg > 0) throw new TxReject('invalid', '出港不登记卸货量，冷库货物须通过提货出库释放');
        if (berth.status !== '占用') {
          throw new TxReject('conflict', `泊位 ${draft.berthNo} 当前并非占用状态，可能已在另一台电脑上释放`);
        }
        await db.berths.put(
          toPlainBerth({
            ...berth,
            status: '空闲',
            vesselId: null,
            vesselName: null,
            berthAt: null,
            leaveAt: time,
          }),
        );
      }

      const call: PortCall = {
        id: callId,
        vesselId: draft.vesselId,
        vesselName,
        portId,
        type: draft.type,
        time,
        berthNo: draft.berthNo,
        iceKg: Math.max(0, Number(draft.iceKg) || 0),
        fuelL: Math.max(0, Number(draft.fuelL) || 0),
        unloadKg,
        storageBatchId: batch?.id,
        visaStatus: draft.visaStatus,
        createdAt: new Date().toISOString(),
      };
      await db.calls.put(call);

      const finalBatches = await db.storageBatches.where('portId').equals(portId).toArray();
      return { call, batch, summary: { ...summarize(port.coldStorageKg, finalBatches), portId } };
    });
    return { status: 'success', ...result };
  } catch (error) {
    if (error instanceof TxReject) {
      return {
        status: error.code,
        message: error.message,
        shortageKg: error.shortageKg,
        latest: await getStorageSummary(portId),
      };
    }
    throw error;
  } finally {
    await releaseLock(portId, owner);
  }
}

/** 写库的泊位对象脱代理（事务内 spread 出来的对象仍是普通对象，这里统一过一遍 JSON 安全化） */
function toPlainBerth<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface PickupSuccess {
  batch: StorageBatch;
  pickup: StoragePickup;
  summary: StorageSummary;
}

/**
 * 渔船提货出库：按批次扣减 remainingKg 并立即释放冷库容量。
 * 整笔事务更新批次 + 写提货流水；提货量超过批次剩余时整笔拒绝。
 */
export async function submitPickup(batchId: string, quantityKg: number): Promise<RegisterResult<PickupSuccess>> {
  const quantity = Math.floor(Number(quantityKg) || 0);
  if (!(quantity > 0)) return { status: 'invalid', message: '提货量必须为大于 0 的整数 kg' };

  const batch0 = await db.storageBatches.get(batchId);
  if (!batch0) return { status: 'invalid', message: '库存批次不存在' };
  const portId = batch0.portId;

  const owner = uid('lock');
  const locked = await acquireLock(portId, owner);
  if (!locked) {
    return {
      status: 'conflict',
      message: '另一台电脑正在操作该渔港冷库，请刷新最新余量后重试',
      latest: await getStorageSummary(portId),
    };
  }

  try {
    const result = await db.transaction(
      'rw',
      [db.storageBatches, db.storagePickups],
      async () => {
        const batch = await db.storageBatches.get(batchId);
        if (!batch) throw new TxReject('invalid', '库存批次不存在');
        if (batch.remainingKg <= 0) throw new TxReject('invalid', '该批次已全部提走');
        if (quantity > batch.remainingKg) {
          throw new TxReject(
            'capacity',
            `提货量超出批次余量：本次 ${quantity} kg，批次仅剩 ${batch.remainingKg} kg`,
            quantity - batch.remainingKg,
          );
        }
        const next: StorageBatch = {
          ...batch,
          remainingKg: batch.remainingKg - quantity,
          pickedKg: batch.pickedKg + quantity,
          lastPickupAt: new Date().toISOString(),
        };
        await db.storageBatches.put(next);
        const pickup: StoragePickup = {
          id: uid('pk'),
          batchId,
          portId,
          vesselId: batch.vesselId,
          vesselName: batch.vesselName,
          quantityKg: quantity,
          remainingKg: next.remainingKg,
          time: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        await db.storagePickups.put(pickup);
        return pickup;
      },
    );

    const [port, batches] = await Promise.all([
      db.ports.get(portId),
      db.storageBatches.where('portId').equals(portId).toArray(),
    ]);
    const updatedBatch = batches.find((b) => b.id === batchId);
    if (!port || !updatedBatch) throw new Error('提货后读取库存失败');
    return {
      status: 'success',
      batch: updatedBatch,
      pickup: result,
      summary: { ...summarize(port.coldStorageKg, batches), portId },
    };
  } catch (error) {
    if (error instanceof TxReject) {
      return {
        status: error.code,
        message: error.message,
        shortageKg: error.shortageKg,
        latest: await getStorageSummary(portId),
      };
    }
    throw error;
  } finally {
    await releaseLock(portId, owner);
  }
}

/** 计算同步数据（Pinia 缓存）下的冷库余量，供三处页面读同一份库存 */
export function storageSummaryOf(portId: string, capacityKg: number, batches: StorageBatch[]): StorageSummary {
  return {
    ...summarize(
      capacityKg,
      batches.filter((b) => b.portId === portId),
    ),
    portId,
  };
}
