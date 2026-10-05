/* eslint-disable no-console */
// 冷库 / 泊位事务逻辑的运行时验证（fake-indexeddb），不参与产品打包。
import 'fake-indexeddb/auto';
import { db } from '../src/db/index';
import {
  registerInboundCall,
  registerOutboundCall,
  registerPickup,
  storageSummaryOf,
  batchesOfPort,
} from '../src/db/storage';
import { StorageCapacityError, StorageConflictError, BerthConflictError, PickupExceedError } from '../src/db/errors';
import type { CallDraft } from '../src/types/call';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

function draft(over: Partial<CallDraft> = {}): CallDraft {
  return {
    vesselId: 'v-1',
    type: '进港',
    time: '2026-10-05T08:00',
    berthNo: 'B01',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 100,
    visaStatus: '待签证',
    ...over,
  };
}

async function seedPort(capacity = 1000, berthCount = 2): Promise<void> {
  await db.ports.put({
    id: 'p-1',
    name: '测试港',
    level: '一级渔港',
    longitude: 121.9,
    latitude: 29.5,
    berthCount,
    berthDepth: 4.5,
    wharfLength: 200,
    shelterLevel: 10,
    coldStorageKg: capacity,
    supply: { fuel: false, ice: false, water: false },
    manager: '测试管理站',
    createdAt: new Date().toISOString(),
  });
  for (let i = 1; i <= berthCount; i++) {
    const no = `B0${i}`;
    await db.berths.put({
      id: `p-1-${no}`,
      portId: 'p-1',
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: 4.5,
    });
  }
}

async function main(): Promise<void> {
  // ---------- 1. 进港同事务占用泊位 + 冷库 ----------
  await resetDb();
  await seedPort(1000);
  const r1 = await registerInboundCall({ draft: draft({ unloadKg: 300 }), vesselName: '测试船A', portId: 'p-1', expectedVersion: 0 });
  let summary = await storageSummaryOf('p-1');
  check('进港后台账已占用 300', summary?.usedKg === 300, `used=${summary?.usedKg}`);
  check('进港后余量 700', summary?.freeKg === 700, `free=${summary?.freeKg}`);
  check('台账版本推进到 1', r1.ledger.version === 1, `v=${r1.ledger.version}`);
  const berth = await db.berths.get('p-1-B01');
  check('同笔事务占用泊位', berth?.status === '占用' && berth?.vesselId === 'v-1');
  const call = await db.calls.get(r1.call.id);
  check('流水带港口归属与批次 id', call?.portId === 'p-1' && call?.batchId === r1.batch?.id);
  const batches = await batchesOfPort('p-1');
  check('生成在库批次，剩余 300', batches.length === 1 && batches[0].inflowKg - batches[0].pickedKg === 300);

  // ---------- 2. 容量不足整笔拒绝，泊位流水均不落库 ----------
  await resetDb();
  await seedPort(500);
  let threw: unknown = null;
  try {
    await registerInboundCall({ draft: draft({ unloadKg: 800 }), vesselName: '测试船A', portId: 'p-1', expectedVersion: 0 });
  } catch (e) {
    threw = e;
  }
  check('容量不足抛 StorageCapacityError', threw instanceof StorageCapacityError);
  if (threw instanceof StorageCapacityError) {
    check('错误带缺口 300', threw.info.shortageKg === 300, `gap=${threw.info.shortageKg}`);
    check('错误带最新余量 500', threw.info.freeKg === 500, `free=${threw.info.freeKg}`);
  }
  check('拒绝后泊位仍空闲', (await db.berths.get('p-1-B01'))?.status === '空闲');
  check('拒绝后流水数为 0', (await db.calls.count()) === 0);
  check('拒绝后批次为 0', (await db.storageBatches.count()) === 0);
  // 台账是事务内 ensureLedgerInTx 补建的，整笔回滚后台账插入也应一并消失（或保持 used=0）
  const rolledBackLedger = await db.storageLedgers.get('p-1');
  check('拒绝后台账未被污染（无记录或占用为 0）', !rolledBackLedger || rolledBackLedger.usedKg === 0);

  // ---------- 3. 乐观版本号：同渔港并发（相同基线版本）只有一笔成功 ----------
  await resetDb();
  await seedPort(10000, 2);
  // B01 / B02 两条同时进港，都以版本 0 为基线 → 后到者冲突
  const pA = registerInboundCall({ draft: draft({ unloadKg: 100, berthNo: 'B01' }), vesselName: '船A', portId: 'p-1', expectedVersion: 0 })
    .then(() => 'A-ok')
    .catch((e) => (e instanceof StorageConflictError ? 'A-conflict' : `A-other:${(e as Error).message}`));
  const pB = registerInboundCall({ draft: draft({ unloadKg: 200, berthNo: 'B02' }), vesselName: '船B', portId: 'p-1', expectedVersion: 0 })
    .then(() => 'B-ok')
    .catch((e) => (e instanceof StorageConflictError ? 'B-conflict' : `B-other:${(e as Error).message}`));
  const [ra, rb] = await Promise.all([pA, pB]);
  const okCount = [ra, rb].filter((r) => r.endsWith('-ok')).length;
  const conflictCount = [ra, rb].filter((r) => r.endsWith('-conflict')).length;
  check('并发两笔恰有一笔成功、一笔冲突', okCount === 1 && conflictCount === 1, `got=${ra},${rb}`);
  summary = await storageSummaryOf('p-1');
  // 锁是串行执行的：先成功的占 100 或 200；失败的整笔回滚
  check('冲突笔整笔回滚（占用量只含成功笔）', summary?.usedKg === 100 || summary?.usedKg === 200, `used=${summary?.usedKg}`);
  check('冲突后版本只推进一次', (await db.storageLedgers.get('p-1'))?.version === 1);
  const occupiedBerths = await db.berths.where('status').equals('占用').count();
  check('只有成功笔的泊位被占用', occupiedBerths === 1, `occupied=${occupiedBerths}`);

  // ---------- 4. 冲突失败方读到的 info 是最新余量 ----------
  await resetDb();
  await seedPort(300, 2);
  // 先成功占 250
  await registerInboundCall({ draft: draft({ unloadKg: 250, berthNo: 'B01' }), vesselName: '船A', portId: 'p-1', expectedVersion: 0 });
  threw = null;
  try {
    // 另一终端还拿着旧版本 0 提交 100
    await registerInboundCall({ draft: draft({ unloadKg: 100, berthNo: 'B02' }), vesselName: '船B', portId: 'p-1', expectedVersion: 0 });
  } catch (e) {
    threw = e;
  }
  check('旧版本提交被冲突拒绝', threw instanceof StorageConflictError);
  if (threw instanceof StorageConflictError) {
    check('冲突 info 反映最新已占用 250 / 余量 50', threw.info.usedKg === 250 && threw.info.freeKg === 50, `used=${threw.info.usedKg}`);
    check('冲突 info 版本为最新 1', threw.info.version === 1);
  }

  // ---------- 5. 同泊位并发：后到者即使不带版本校验也失败 ----------
  await resetDb();
  await seedPort(10000, 1);
  const qA = registerInboundCall({ draft: draft({ unloadKg: 10, berthNo: 'B01' }), vesselName: '船A', portId: 'p-1', expectedVersion: 0 })
    .then(() => 'ok')
    .catch((e) => (e instanceof BerthConflictError ? 'berth' : `other:${(e as Error).message}`));
  const qB = registerInboundCall({ draft: draft({ unloadKg: 10, berthNo: 'B01' }), vesselName: '船B', portId: 'p-1', expectedVersion: 0 })
    .then(() => 'ok')
    .catch((e) => (e instanceof BerthConflictError ? 'berth' : (e instanceof StorageConflictError ? 'conflict' : `other:${(e as Error).message}`)));
  const [qa, qb] = await Promise.all([qA, qB]);
  check('同泊位并发恰有一笔成功', [qa, qb].includes('ok') && !(qa === 'ok' && qb === 'ok'), `${qa},${qb}`);

  // ---------- 6. 提货按批次减少占用并立即释放容量 ----------
  await resetDb();
  await seedPort(1000);
  const inb = await registerInboundCall({ draft: draft({ unloadKg: 400 }), vesselName: '船A', portId: 'p-1', expectedVersion: 0 });
  const pk1 = await registerPickup({ batchId: inb.batch!.id, amountKg: 150 });
  check('提货后批次已提 150', pk1.batch.pickedKg === 150);
  summary = await storageSummaryOf('p-1');
  check('提货后占用降到 250（容量立即释放）', summary?.usedKg === 250, `used=${summary?.usedKg}`);
  check('提货后余量 750', summary?.freeKg === 750, `free=${summary?.freeKg}`);
  // 再进港 700：250 + 700 = 950，容量足够（证明释放的容量立刻可用）
  await registerInboundCall({ draft: draft({ unloadKg: 700, berthNo: 'B02' }), vesselName: '船B', portId: 'p-1', expectedVersion: 2 });
  summary = await storageSummaryOf('p-1');
  check('释放的容量立即可用（再占 700 → 950）', summary?.usedKg === 950, `used=${summary?.usedKg}`);

  // 超量提货被拒
  threw = null;
  try {
    await registerPickup({ batchId: inb.batch!.id, amountKg: 999 });
  } catch (e) {
    threw = e;
  }
  check('提货超剩余量抛 PickupExceedError', threw instanceof PickupExceedError);
  if (threw instanceof PickupExceedError) check('错误带剩余 250', threw.remainingKg === 250, `rem=${threw.remainingKg}`);
  check('超量提货不释放容量', (await storageSummaryOf('p-1'))?.usedKg === 950);

  // 整批提完 → 状态已提完、不占容量
  await registerPickup({ batchId: inb.batch!.id, amountKg: 250 });
  const finishedBatch = await db.storageBatches.get(inb.batch!.id);
  check('整批提完状态置为已提完', finishedBatch?.status === '已提完');
  summary = await storageSummaryOf('p-1');
  check('提完后占用只剩第二批 700', summary?.usedKg === 700, `used=${summary?.usedKg}`);

  // ---------- 7. 出港只结束航次，不清未提走的货 ----------
  await resetDb();
  await seedPort(1000);
  const inb2 = await registerInboundCall({ draft: draft({ unloadKg: 300 }), vesselName: '船A', portId: 'p-1', expectedVersion: 0 });
  await registerOutboundCall({ draft: draft({ type: '出港', unloadKg: 0 }), vesselName: '船A', portId: 'p-1', expectedVersion: 1 });
  const afterOutBerth = await db.berths.get('p-1-B01');
  check('出港释放泊位', afterOutBerth?.status === '空闲' && afterOutBerth?.vesselId === null);
  const afterOutBatch = await db.storageBatches.get(inb2.batch!.id);
  check('出港后冷库批次仍在库、货仍占用', afterOutBatch?.status === '在库' && afterOutBatch.pickedKg === 0);
  summary = await storageSummaryOf('p-1');
  check('出港后冷库占用仍为 300', summary?.usedKg === 300, `used=${summary?.usedKg}`);
  const outCall = await db.calls.where('type').equals('出港').first();
  check('出港流水无卸货量无批次', outCall?.unloadKg === 0 && outCall?.batchId === null);

  // ---------- 8. 旧流水（portId 缺失）不占冷库 ----------
  await resetDb();
  await seedPort(1000);
  await db.storageLedgers.put({
    portId: 'p-1', portName: '测试港', capacityKg: 1000, usedKg: 0, version: 0, updatedAt: new Date().toISOString(),
  });
  await db.calls.put({
    id: 'old-1',
    vesselId: 'vx',
    vesselName: '旧船',
    type: '进港',
    time: new Date().toISOString(),
    berthNo: 'B09',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 9999,
    visaStatus: '待签证',
    createdAt: new Date().toISOString(),
  });
  summary = await storageSummaryOf('p-1');
  check('无归属旧流水不占用冷库', summary?.usedKg === 0, `used=${summary?.usedKg}`);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
