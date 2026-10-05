import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { liveQuery } from 'dexie';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import type { RegisterResult, StorageBatch, StoragePickup, StorageSummary } from '../types/storage';
import { buildBerthRecords } from '../db/berth';
import {
  getStorageSummary,
  storageSummaryOf,
  submitCall,
  submitPickup,
  type CallSuccess,
  type PickupSuccess,
} from '../db/storage';
import { DEFAULT_COLD_STORAGE_KG } from '../db/seed';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  /** 冷库容量 kg */
  coldStorageKg: number;
  manager: string;
}

export type { RegisterResult };

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const batches = ref<StorageBatch[]>([]);
  const pickups = ref<StoragePickup[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());
  let liveSyncStarted = false;

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

  /** 旧流水没有港口归属 → 待盘点，不参与冷库占用 */
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

  function batchesOfPort(portId: string): StorageBatch[] {
    return batches.value
      .filter((b) => b.portId === portId)
      .sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime());
  }

  function pickupsOfBatch(batchId: string): StoragePickup[] {
    return pickups.value
      .filter((p) => p.batchId === batchId)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }

  /** 渔港详情 / 地图摘要 / 渔船档案统一从这里读同一份库存 */
  function storageSummary(portId: string): StorageSummary {
    const port = portById(portId);
    return storageSummaryOf(portId, port?.coldStorageKg ?? 0, batches.value);
  }

  /** 读库拿最新余量（并发失败页用，避免本地缓存滞后） */
  async function refreshStorageSummary(portId: string): Promise<StorageSummary> {
    return getStorageSummary(portId);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c, sb, sp] = await Promise.all([
        db.ports.toArray(),
        db.berths.toArray(),
        db.calls.toArray(),
        db.storageBatches.toArray(),
        db.storagePickups.toArray(),
      ]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
      batches.value = sb;
      pickups.value = sp;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 用 Dexie liveQuery 订阅五张表：本页提交与另一台电脑（标签页）提交后，
   * 所有页面的泊位 / 库存缓存自动刷新为同一份最新数据。
   */
  function startLiveSync(): void {
    if (liveSyncStarted) return;
    liveSyncStarted = true;
    liveQuery(() => db.ports.toArray()).subscribe((list) => {
      ports.value = list;
    });
    liveQuery(() => db.berths.toArray()).subscribe((list) => {
      berths.value = list;
    });
    liveQuery(() => db.calls.toArray()).subscribe((list) => {
      calls.value = list;
    });
    liveQuery(() => db.storageBatches.toArray()).subscribe((list) => {
      batches.value = list;
    });
    liveQuery(() => db.storagePickups.toArray()).subscribe((list) => {
      pickups.value = list;
    });
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
      supply: { ...input.supply },
      coldStorageKg: Math.max(0, Number(input.coldStorageKg) || DEFAULT_COLD_STORAGE_KG),
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
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
    const nextCount = berthsOf(portId).length + 1;
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
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
  }

  /**
   * 登记进出港：泊位占用与冷库占用在同一笔事务里提交。
   * 容量不足 / 并发冲突时整笔拒绝，结果中带缺口与最新余量，由页面渲染失败提示。
   */
  async function registerCall(
    draft: CallDraft,
    vesselName: string,
    portId: string,
  ): Promise<RegisterResult<CallSuccess>> {
    return submitCall(draft, vesselName, portId);
  }

  /** 渔船提货出库：按批次扣减，立即释放容量 */
  async function pickup(batchId: string, quantityKg: number): Promise<RegisterResult<PickupSuccess>> {
    return submitPickup(batchId, quantityKg);
  }

  /**
   * 待盘点流水人工补录港口归属。只补归属、不追补冷库批次——
   * 历史卸货量不能自动占用冷库，盘点后货权需走实际库存管理。
   */
  async function assignCallPort(callId: string, portId: string): Promise<void> {
    const hit = calls.value.find((c) => c.id === callId);
    if (!hit || !portId) return;
    await db.calls.put(toPlain({ ...hit, portId }));
  }

  return {
    ports,
    berths,
    calls,
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
    batchesOfPort,
    pickupsOfBatch,
    storageSummary,
    refreshStorageSummary,
    resetFilter,
    loadAll,
    startLiveSync,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
    pickup,
    assignCallPort,
  };
});
