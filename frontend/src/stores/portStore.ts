import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import type { StorageBatch, StorageLedger, StoragePickup, StorageSummary } from '../types/storage';
import {
  registerInboundCall,
  registerOutboundCall,
  registerPickup,
  summarizeStorage,
  updateLedgerCapacity,
  type PickupParams,
  type PickupResult,
  type RegisterCallParams,
  type RegisterCallResult,
} from '../db/storage';
import { buildBerthRecords } from '../db/berth';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  coldStorageKg: number;
  supply: SupplyCapability;
  manager: string;
}

/** 跨标签页 / 终端的数据同步频道名 */
const SYNC_CHANNEL = 'gbfishport:sync';

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const ledgers = ref<StorageLedger[]>([]);
  const batches = ref<StorageBatch[]>([]);
  const pickups = ref<StoragePickup[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  /** 旧流水没有港口归属（portId 为 null）→ 待盘点，不占冷库、不进任何港口流水 */
  const pendingCalls = computed(() => callsSorted.value.filter((c) => !c.portId));

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfPort(portId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.portId === portId);
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  function ledgerOf(portId: string): StorageLedger | undefined {
    return ledgers.value.find((l) => l.portId === portId);
  }

  /** 统一库存出口：渔港详情、地图摘要、渔船档案都读这一份 */
  function storageOf(portId: string): StorageSummary | null {
    const ledger = ledgerOf(portId);
    const summary = summarizeStorage(ledger);
    if (!summary) return null;
    summary.batchCount = batches.value.filter((b) => b.portId === portId && b.status === '在库').length;
    return summary;
  }

  function batchesOfPort(portId: string): StorageBatch[] {
    return batches.value
      .filter((b) => b.portId === portId)
      .sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime());
  }

  function batchById(id: string): StorageBatch | undefined {
    return batches.value.find((b) => b.id === id);
  }

  function batchOfCall(callId: string): StorageBatch | undefined {
    return batches.value.find((b) => b.callId === callId);
  }

  /** 某渔船在某渔港尚未提完的冷库批次（出港前提示、渔船档案展示用） */
  function activeBatchesOfVessel(vesselId: string, portId?: string): StorageBatch[] {
    return batches.value
      .filter((b) => b.status === '在库' && b.vesselId === vesselId && (!portId || b.portId === portId))
      .sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime());
  }

  function pickupsOfBatch(batchId: string): StoragePickup[] {
    return pickups.value
      .filter((p) => p.batchId === batchId)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c, l, sb, pk] = await Promise.all([
        db.ports.toArray(),
        db.berths.toArray(),
        db.calls.toArray(),
        db.storageLedgers.toArray(),
        db.storageBatches.toArray(),
        db.storagePickups.toArray(),
      ]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
      ledgers.value = l;
      batches.value = sb;
      pickups.value = pk;
    } finally {
      loading.value = false;
    }
  }

  /** 写完数据后通知本页其他模块与其他标签页重读同一份库存 */
  function notifySync(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        syncChannel.postMessage({ at: Date.now() });
      } catch {
        // 跨源或通道关闭时忽略
      }
    }
  }

  const syncChannel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SYNC_CHANNEL) : (null as unknown as BroadcastChannel);

  function startSyncListener(): void {
    if (syncChannel) {
      syncChannel.onmessage = () => {
        void loadAll();
      };
    }
    // 不支持 BroadcastChannel 时退回 storage 事件（同机不同标签页 localStorage 桥）
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key && event.key.startsWith('gbfishport:')) void loadAll();
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void loadAll();
      });
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      coldStorageKg: Number(input.coldStorageKg) || 0,
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 港口、泊位、冷库台账在一笔事务里建立
    await db.transaction('rw', [db.ports, db.berths, db.storageLedgers], async () => {
      await db.ports.put(toPlain(port));
      const records = buildBerthRecords(port, []);
      await db.berths.bulkPut(toPlain(records));
      await db.storageLedgers.put(
        toPlain({
          portId: port.id,
          portName: port.name,
          capacityKg: port.coldStorageKg,
          usedKg: 0,
          version: 0,
          updatedAt: new Date().toISOString(),
        } satisfies StorageLedger),
      );
      berths.value = [...berths.value, ...records];
    });
    ports.value = [...ports.value, port];
    ledgers.value = [
      ...ledgers.value,
      {
        portId: port.id,
        portName: port.name,
        capacityKg: port.coldStorageKg,
        usedKg: 0,
        version: 0,
        updatedAt: new Date().toISOString(),
      },
    ];
    notifySync();
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (berthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    const hit = berths.value.find((b) => b.id === berthId);
    if (!hit) return;
    const next: Berth = {
      ...hit,
      status,
      vesselId: status === '占用' ? hit.vesselId : null,
      vesselName: status === '占用' ? hit.vesselName : null,
      berthAt: status === '占用' ? hit.berthAt ?? new Date().toISOString() : hit.berthAt,
      leaveAt: status === '空闲' ? new Date().toISOString() : null,
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
    notifySync();
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    if ('coldStorageKg' in patch) {
      // 容量变更必须同步台账并推进版本号，使进行中的并发登记失败
      await updateLedgerCapacity(next);
      const ledger = await db.storageLedgers.get(portId);
      if (ledger) ledgers.value = ledgers.value.map((l) => (l.portId === portId ? ledger : l));
    } else {
      await db.ports.put(toPlain(next));
    }
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
    notifySync();
  }

  /**
   * 登记进出港：流水、泊位占用、冷库占用 / 版本号在同一笔事务里提交。
   * 容量不足或并发冲突时整笔拒绝（错误类型见 db/errors），由页面展示缺口与最新余量。
   */
  async function registerCall(params: RegisterCallParams): Promise<RegisterCallResult> {
    const result =
      params.draft.type === '进港' ? await registerInboundCall(params) : await registerOutboundCall(params);
    await loadAll();
    notifySync();
    return result;
  }

  /** 渔船提货出库：按批次核减并立即释放容量（同事务）。 */
  async function pickup(params: PickupParams): Promise<PickupResult> {
    const result = await registerPickup(params);
    await loadAll();
    notifySync();
    return result;
  }

  /**
   * 盘点旧流水：把没有港口归属的流水人工归档到具体渔港。
   * 只补归属用于展示，绝不追溯占用冷库容量。
   */
  async function assignPendingCall(callId: string, portId: string): Promise<void> {
    const hit = calls.value.find((c) => c.id === callId);
    if (!hit || hit.portId) return;
    const next: PortCall = { ...hit, portId };
    await db.calls.put(toPlain(next));
    calls.value = calls.value.map((c) => (c.id === callId ? next : c));
    notifySync();
  }

  return {
    ports,
    berths,
    calls,
    ledgers,
    batches,
    pickups,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    pendingCalls,
    portById,
    berthsOf,
    callsOfPort,
    callsOfVessel,
    ledgerOf,
    storageOf,
    batchesOfPort,
    batchById,
    batchOfCall,
    activeBatchesOfVessel,
    pickupsOfBatch,
    resetFilter,
    loadAll,
    startSyncListener,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
    pickup,
    assignPendingCall,
  };
});
