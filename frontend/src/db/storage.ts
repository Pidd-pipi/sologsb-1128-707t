import { db } from './index';
import type { FishingPort } from '../types/port';
import type { PortCall, CallDraft } from '../types/call';
import type { StorageBatch, StorageLedger, StoragePickup, StorageSummary } from '../types/storage';
import { toPlain, uid } from '../utils/format';
import {
  BerthConflictError,
  PickupExceedError,
  StorageCapacityError,
  StorageConflictError,
  type StorageConflictInfo,
} from './errors';

/** 进港登记事务的提交参数 */
export interface RegisterCallParams {
  draft: CallDraft;
  vesselName: string;
  portId: string;
  /**
   * 页面打开 / 选中渔港时读到的台账版本号（乐观锁基线）。
   * 两台登记终端同时提交同一渔港：先拿到渔港级互斥锁的终端提交成功，
   * 后到终端在锁内重读发现版本号已变，整笔拒绝并返回最新余量。
   * null 表示不校验版本（仅保留事务内容量校验）。
   */
  expectedVersion: number | null;
}

/** 进港 / 出港登记结果（事务提交后的最新数据） */
export interface RegisterCallResult {
  call: PortCall;
  batch: StorageBatch | null;
  ledger: StorageLedger;
}

function toConflictInfo(ledger: StorageLedger, requiredKg: number): StorageConflictInfo {
  const freeKg = Math.max(0, ledger.capacityKg - ledger.usedKg);
  return {
    portId: ledger.portId,
    portName: ledger.portName,
    capacityKg: ledger.capacityKg,
    usedKg: ledger.usedKg,
    freeKg,
    requiredKg,
    shortageKg: Math.max(0, requiredKg - freeKg),
    version: ledger.version,
  };
}

/**
 * 渔港级互斥锁：同一渔港的冷库 / 泊位写操作排队执行。
 * Web Locks 对同浏览器多标签页生效（早班 / 晚班两台终端同机登记的场景）；
 * 不支持 Web Locks 时退化为直接执行（必须 return fn()，否则调用方拿不到事务结果）。
 */
async function withPortLock<T>(portId: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    return locks.request(`gbfishport:storage:${portId}`, fn);
  }
  return fn();
}

/** 读取渔港冷库最新台账（并发失败页显示最新余量时使用） */
export async function getLedger(portId: string): Promise<StorageLedger | undefined> {
  return db.storageLedgers.get(portId);
}

/** 渔港冷库库存聚合（渔港详情 / 地图摘要 / 渔船档案读同一份） */
export function summarizeStorage(ledger: StorageLedger | null | undefined): StorageSummary | null {
  if (!ledger) return null;
  const freeKg = Math.max(0, ledger.capacityKg - ledger.usedKg);
  return {
    portId: ledger.portId,
    capacityKg: ledger.capacityKg,
    usedKg: ledger.usedKg,
    freeKg,
    usageRate: ledger.capacityKg > 0 ? Math.min(1, ledger.usedKg / ledger.capacityKg) : 0,
    batchCount: 0,
  };
}

export async function storageSummaryOf(portId: string): Promise<StorageSummary | null> {
  const ledger = await db.storageLedgers.get(portId);
  if (!ledger) return null;
  const summary = summarizeStorage(ledger)!;
  summary.batchCount = await db.storageBatches
    .where('portId')
    .equals(portId)
    .and((b) => b.status === '在库')
    .count();
  return summary;
}

export async function batchesOfPort(portId: string): Promise<StorageBatch[]> {
  const list = await db.storageBatches.where('portId').equals(portId).toArray();
  return list.sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime());
}

export async function pickupsOfBatch(batchId: string): Promise<StoragePickup[]> {
  const list = await db.storagePickups.where('batchId').equals(batchId).toArray();
  return list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

export async function pickupsOfPort(portId: string): Promise<StoragePickup[]> {
  const list = await db.storagePickups.where('portId').equals(portId).toArray();
  return list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

/**
 * 事务内读取台账；历史渔港缺台账时就地补建（与所在登记同事务）。
 * 注意：必须在 db.transaction 回调中调用，db.xxx 在事务作用域内自动入事务。
 */
async function ensureLedgerInTx(port: FishingPort): Promise<StorageLedger> {
  const existing = await db.storageLedgers.get(port.id);
  if (existing) return existing;
  const created: StorageLedger = {
    portId: port.id,
    portName: port.name,
    capacityKg: port.coldStorageKg,
    usedKg: 0,
    version: 0,
    updatedAt: new Date().toISOString(),
  };
  await db.storageLedgers.put(toPlain(created));
  return created;
}

/**
 * 进港登记：保存流水、占用泊位、占用冷库空间在同一笔 IndexedDB 事务里完成。
 * - 冷库容量不足 → 整笔回滚拒绝，抛 StorageCapacityError（带缺口与最新余量）
 * - 两台电脑并发提交同一渔港 → 台账版本号互斥，后到者整笔拒绝
 * - 卸货量为 0 不生成批次、不占容量，但仍参与同渔港并发互斥
 */
export async function registerInboundCall(params: RegisterCallParams): Promise<RegisterCallResult> {
  const { draft, vesselName, portId, expectedVersion } = params;
  const unloadKg = Number(draft.unloadKg) || 0;
  const nowIso = new Date().toISOString();
  const callId = uid('c');
  const batchId = unloadKg > 0 ? uid('b') : null;

  try {
    return await withPortLock(portId, async () => {
      const result = await db.transaction(
        'rw',
        [db.calls, db.berths, db.storageLedgers, db.storageBatches, db.ports],
        async () => {
          const port = await db.ports.get(portId);
          if (!port) throw new Error('未找到该渔港，请刷新后重试');

          // 泊位必须在本事务内读取并改写：两台电脑同时抢同一泊位时后到者必然失败
          const berth = await db.berths.get(`${portId}-${draft.berthNo}`);
          if (!berth) throw new Error(`渔港 ${port.name} 没有泊位 ${draft.berthNo}`);
          if (berth.status !== '空闲') {
            throw new BerthConflictError(berth.berthNo, berth.vesselName);
          }

          const ledger = await ensureLedgerInTx(port);

          // 乐观版本号：本终端填表期间台账已被另一终端提交过 → 整笔拒绝（即使容量恰好还够）
          if (expectedVersion !== null && ledger.version !== expectedVersion) {
            throw new StorageConflictError(toConflictInfo(ledger, unloadKg));
          }

          const freeKg = Math.max(0, ledger.capacityKg - ledger.usedKg);
          // 容量校验与占用、泊位占用、流水写入同生共死
          if (unloadKg > freeKg) {
            throw new StorageCapacityError(toConflictInfo(ledger, unloadKg));
          }

          const call: PortCall = {
            id: callId,
            portId,
            vesselId: draft.vesselId,
            vesselName,
            type: '进港',
            time: draft.time ? new Date(draft.time).toISOString() : nowIso,
            berthNo: draft.berthNo,
            iceKg: Number(draft.iceKg) || 0,
            fuelL: Number(draft.fuelL) || 0,
            unloadKg,
            batchId,
            visaStatus: draft.visaStatus,
            createdAt: nowIso,
          };

          let batch: StorageBatch | null = null;
          if (unloadKg > 0) {
            batch = {
              id: batchId!,
              portId,
              callId,
              vesselId: draft.vesselId,
              vesselName,
              inflowKg: unloadKg,
              pickedKg: 0,
              storedAt: call.time,
              lastPickedAt: null,
              status: '在库',
              createdAt: nowIso,
            };
            await db.storageBatches.put(toPlain(batch));
          }

          const nextLedger: StorageLedger = {
            ...ledger,
            portName: port.name,
            capacityKg: port.coldStorageKg,
            usedKg: ledger.usedKg + unloadKg,
            version: ledger.version + 1,
            updatedAt: nowIso,
          };
          await db.storageLedgers.put(toPlain(nextLedger));

          await db.calls.put(toPlain(call));

          await db.berths.put(
            toPlain({
              ...berth,
              status: '占用' as const,
              vesselId: draft.vesselId,
              vesselName,
              berthAt: call.time,
              leaveAt: null,
            }),
          );

          return { call, batch, ledger: nextLedger };
        },
      );
      return result;
    });
  } catch (error) {
    throw await mapTxError(error, portId, unloadKg);
  }
}

/**
 * 出港登记：只结束航次（释放泊位、写流水），不清冷库批次、不释放冷库容量——
 * 尚未提走的货继续在库占用。同一渔港并发提交同样受台账版本号互斥。
 */
export async function registerOutboundCall(params: RegisterCallParams): Promise<RegisterCallResult> {
  const { draft, vesselName, portId, expectedVersion } = params;
  const nowIso = new Date().toISOString();
  const callId = uid('c');

  try {
    return await withPortLock(portId, async () =>
      db.transaction('rw', [db.calls, db.berths, db.storageLedgers, db.ports], async () => {
        const port = await db.ports.get(portId);
        if (!port) throw new Error('未找到该渔港，请刷新后重试');

        const berth = await db.berths.get(`${portId}-${draft.berthNo}`);
        if (!berth) throw new Error(`渔港 ${port.name} 没有泊位 ${draft.berthNo}`);
        if (berth.status !== '占用') {
          throw new BerthConflictError(berth.berthNo, berth.vesselName);
        }

        const ledger = await ensureLedgerInTx(port);
        // 并发互斥：同渔港有其他终端先提交时，本笔出港同样整笔拒绝
        if (expectedVersion !== null && ledger.version !== expectedVersion) {
          throw new StorageConflictError(toConflictInfo(ledger, 0));
        }

        // 仅推进版本号，保证同渔港并发登记只有一笔成功；绝不动 usedKg / 批次
        const nextLedger: StorageLedger = {
          ...ledger,
          portName: port.name,
          capacityKg: port.coldStorageKg,
          version: ledger.version + 1,
          updatedAt: nowIso,
        };
        await db.storageLedgers.put(toPlain(nextLedger));

        const call: PortCall = {
          id: callId,
          portId,
          vesselId: draft.vesselId,
          vesselName,
          type: '出港',
          time: draft.time ? new Date(draft.time).toISOString() : nowIso,
          berthNo: draft.berthNo,
          iceKg: Number(draft.iceKg) || 0,
          fuelL: Number(draft.fuelL) || 0,
          unloadKg: 0,
          batchId: null,
          visaStatus: draft.visaStatus,
          createdAt: nowIso,
        };
        await db.calls.put(toPlain(call));

        await db.berths.put(
          toPlain({
            ...berth,
            status: '空闲' as const,
            vesselId: null,
            vesselName: null,
            berthAt: null,
            leaveAt: call.time,
          }),
        );

        return { call, batch: null, ledger: nextLedger };
      }),
    );
  } catch (error) {
    throw await mapTxError(error, portId, 0);
  }
}

export interface PickupParams {
  batchId: string;
  amountKg: number;
  time?: string;
}

export interface PickupResult {
  pickup: StoragePickup;
  batch: StorageBatch;
  ledger: StorageLedger;
}

/**
 * 渔船提货出库：按批次核减剩余量并立即释放等量冷库容量。
 * 提货量超过批次剩余量时整笔拒绝。与同渔港登记共用同一把渔港锁。
 */
export async function registerPickup(params: PickupParams): Promise<PickupResult> {
  const amountKg = Number(params.amountKg) || 0;
  if (!(amountKg > 0)) throw new Error('提货量必须大于 0');
  const nowIso = new Date().toISOString();

  // 先拿到批次归属港口，再进该港口的互斥锁，保证与登记 / 容量调整串行
  const batch = await db.storageBatches.get(params.batchId);
  if (!batch) throw new Error('未找到该入库批次');

  return withPortLock(batch.portId, () =>
    db.transaction('rw', [db.storageBatches, db.storagePickups, db.storageLedgers], async () => {
      const latestBatch = await db.storageBatches.get(params.batchId);
      if (!latestBatch) throw new Error('未找到该入库批次');
      if (latestBatch.status === '已提完') throw new PickupExceedError(latestBatch.id, 0, amountKg);

      const remainingKg = latestBatch.inflowKg - latestBatch.pickedKg;
      if (amountKg > remainingKg) {
        throw new PickupExceedError(latestBatch.id, remainingKg, amountKg);
      }

      const ledger = await db.storageLedgers.get(latestBatch.portId);
      if (!ledger) throw new Error('该渔港冷库台账缺失，无法提货');

      const nextPicked = latestBatch.pickedKg + amountKg;
      const nextBatch: StorageBatch = {
        ...latestBatch,
        pickedKg: nextPicked,
        lastPickedAt: nowIso,
        status: nextPicked >= latestBatch.inflowKg ? '已提完' : '在库',
      };
      await db.storageBatches.put(toPlain(nextBatch));

      const pickup: StoragePickup = {
        id: uid('k'),
        portId: latestBatch.portId,
        batchId: latestBatch.id,
        vesselId: latestBatch.vesselId,
        vesselName: latestBatch.vesselName,
        amountKg,
        time: params.time ? new Date(params.time).toISOString() : nowIso,
        createdAt: nowIso,
      };
      await db.storagePickups.put(toPlain(pickup));

      const nextUsed = Math.max(0, ledger.usedKg - amountKg);
      const nextLedger: StorageLedger = {
        ...ledger,
        usedKg: nextUsed,
        version: ledger.version + 1,
        updatedAt: nowIso,
      };
      await db.storageLedgers.put(toPlain(nextLedger));

      return { pickup, batch: nextBatch, ledger: nextLedger };
    }),
  );
}

/**
 * 渔港冷库容量调整：同步台账容量并推进版本号，让进行中的并发登记按新版本失败。
 * 与登记 / 提货共用同一把渔港锁。
 */
export async function updateLedgerCapacity(port: FishingPort): Promise<void> {
  const nowIso = new Date().toISOString();
  await withPortLock(port.id, () =>
    db.transaction('rw', [db.ports, db.storageLedgers], async () => {
      await db.ports.put(toPlain(port));
      const ledger = await db.storageLedgers.get(port.id);
      if (ledger) {
        await db.storageLedgers.put(
          toPlain({
            ...ledger,
            portName: port.name,
            capacityKg: port.coldStorageKg,
            version: ledger.version + 1,
            updatedAt: nowIso,
          } satisfies StorageLedger),
        );
      } else {
        await db.storageLedgers.put(
          toPlain({
            portId: port.id,
            portName: port.name,
            capacityKg: port.coldStorageKg,
            usedKg: 0,
            version: 0,
            updatedAt: nowIso,
          } satisfies StorageLedger),
        );
      }
    }),
  );
}

/**
 * 事务拒绝后的错误兜底：业务错误（容量不足 / 并发冲突 / 泊位冲突）直接透传；
 * 其余 IndexedDB 异常若事后读台账发现确实容量不足，补判为容量不足并带最新余量。
 */
async function mapTxError(error: unknown, portId: string, requiredKg: number): Promise<never> {
  if (
    error instanceof StorageCapacityError ||
    error instanceof StorageConflictError ||
    error instanceof BerthConflictError
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const latest = await db.storageLedgers.get(portId);
  if (latest && requiredKg > 0) {
    const freeKg = Math.max(0, latest.capacityKg - latest.usedKg);
    if (requiredKg > freeKg) {
      throw new StorageCapacityError(toConflictInfo(latest, requiredKg));
    }
  }
  throw new Error(message);
}
