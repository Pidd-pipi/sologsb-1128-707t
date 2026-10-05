import 'fake-indexeddb/auto';
import { db } from '../src/db/index';
import { submitCall, submitPickup, getStorageSummary } from '../src/db/storage';
import { emptyCallDraft } from '../src/types/call';
import type { CallDraft } from '../src/types/call';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

async function seed(): Promise<void> {
  await db.ports.put({
    id: 'p1',
    name: '测试港',
    level: '一级渔港',
    longitude: 121,
    latitude: 29,
    berthCount: 3,
    berthDepth: 5,
    wharfLength: 200,
    shelterLevel: 10,
    supply: { fuel: false, ice: true, water: true },
    coldStorageKg: 1000,
    manager: '测试站',
    createdAt: new Date().toISOString(),
  });
  for (const no of ['B01', 'B02', 'B03']) {
    await db.berths.put({
      id: `p1-${no}`,
      portId: 'p1',
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: 5,
    });
  }
  await db.vessels.bulkPut([
    {
      id: 'v1', name: '渔船甲', vesselNo: 'A1', homePort: '测试', length: 20, beam: 5,
      grossTonnage: 80, enginePower: 100, operationType: '拖网', hullMaterial: '钢质',
      owner: '甲', certificateExpiry: '2027-01-01', createdAt: new Date().toISOString(),
    },
    {
      id: 'v2', name: '渔船乙', vesselNo: 'A2', homePort: '测试', length: 20, beam: 5,
      grossTonnage: 80, enginePower: 100, operationType: '拖网', hullMaterial: '钢质',
      owner: '乙', certificateExpiry: '2027-01-01', createdAt: new Date().toISOString(),
    },
  ]);
}

function inbound(vesselId: string, vesselName: string, berthNo: string, unloadKg: number): CallDraft {
  return { ...emptyCallDraft(berthNo), vesselId, unloadKg, visaStatus: '已签证' };
}

async function main(): Promise<void> {
  await seed();

  console.log('1. 进港 600kg：泊位 + 冷库批次同一笔写入');
  const r1 = await submitCall(inbound('v1', '渔船甲', 'B01', 600), '渔船甲', 'p1');
  assert(r1.status === 'success', '600kg 进港成功');
  if (r1.status === 'success') {
    assert(r1.batch !== null && r1.batch.remainingKg === 600, '生成 600kg 库存批次');
    assert(r1.summary.occupiedKg === 600 && r1.summary.freeKg === 400, '占用 600 / 余量 400');
  }
  const berth1 = await db.berths.get('p1-B01');
  assert(berth1?.status === '占用' && berth1.vesselId === 'v1', 'B01 已被渔船甲占用');
  const call1 = await db.calls.toCollection().first();
  assert(Boolean(call1?.portId && call1.storageBatchId), '流水带 portId 与批次 id');

  console.log('2. 再进港 500kg：容量不足，整笔拒绝并回缺口');
  const before = {
    calls: await db.calls.count(),
    batches: await db.storageBatches.count(),
  };
  const r2 = await submitCall(inbound('v2', '渔船乙', 'B02', 500), '渔船乙', 'p1');
  assert(r2.status === 'capacity', '返回 capacity 拒绝');
  if (r2.status === 'capacity') {
    assert(r2.shortageKg === 100, '缺口 = 500 - 400 = 100kg');
    assert(r2.latest?.freeKg === 400, '失败结果带最新余量 400kg');
  }
  assert((await db.calls.count()) === before.calls, '没有写入流水');
  assert((await db.storageBatches.count()) === before.batches, '没有写入批次');
  const berth2 = await db.berths.get('p1-B02');
  assert(berth2?.status === '空闲', 'B02 仍空闲（整笔回滚）');
  assert((await db.locks.count()) === 0, '失败后锁已释放');

  console.log('3. 两台电脑同时提交同一渔港：只允许一笔成功');
  const pair = await Promise.all([
    submitCall(inbound('v2', '渔船乙', 'B02', 100), '渔船乙', 'p1'),
    submitCall(
      { ...inbound('v2', '渔船乙', 'B03', 200), time: '' },
      '渔船乙',
      'p1',
    ),
  ]);
  const okCount = pair.filter((r) => r.status === 'success').length;
  const conflictCount = pair.filter((r) => r.status === 'conflict').length;
  assert(okCount === 1 && conflictCount === 1, `成功 1 笔 / 冲突 1 笔（实际 ${okCount}/${conflictCount}）`);
  for (const r of pair) {
    if (r.status === 'conflict') assert(Boolean(r.latest), '冲突失败方带最新余量');
  }

  console.log('4. 提货出库：按批次减少并立即释放容量');
  const summaryBeforePickup = await getStorageSummary('p1');
  const batch = await db.storageBatches.where('portId').equals('p1').first();
  assert(Boolean(batch), '存在在库批次');
  if (batch) {
    const rp = await submitPickup(batch.id, 200);
    assert(rp.status === 'success', '提货 200kg 成功');
    if (rp.status === 'success') {
      assert(rp.batch.remainingKg === 400 && rp.batch.pickedKg === 200, '批次剩余 400 / 已提 200');
      assert((await db.storagePickups.count()) === 1, '写入一条提货流水');
    }
    const rpOver = await submitPickup(batch.id, 9999);
    assert(rpOver.status === 'capacity', '超量提货被拒绝');
    const after = await getStorageSummary('p1');
    assert(after.occupiedKg === summaryBeforePickup.occupiedKg - 200, '占用量立即下降 200kg');
  }

  console.log('5. 出港只结束航次：释放泊位但不清库存');
  const occBeforeOut = (await getStorageSummary('p1')).occupiedKg;
  const outDraft: CallDraft = { ...emptyCallDraft('B01'), vesselId: 'v1', type: '出港', visaStatus: '已签证', unloadKg: 0 };
  const r5 = await submitCall(outDraft, '渔船甲', 'p1');
  assert(r5.status === 'success', '渔船甲出港成功');
  const berth1After = await db.berths.get('p1-B01');
  assert(berth1After?.status === '空闲', 'B01 释放为空闲');
  assert((await getStorageSummary('p1')).occupiedKg === occBeforeOut, '冷库占用量不变');

  console.log('6. 出港携带卸货量：拒绝');
  await db.berths.put({ ...(await db.berths.get('p1-B02'))!, status: '占用', vesselId: 'v2', vesselName: '渔船乙', berthAt: new Date().toISOString(), leaveAt: null });
  const r6 = await submitCall(
    { ...emptyCallDraft('B02'), vesselId: 'v2', type: '出港', unloadKg: 50 },
    '渔船乙',
    'p1',
  );
  assert(r6.status === 'invalid', '出港带卸货量被拒绝');

  console.log('7. 旧流水（无 portId）不占用冷库');
  await db.calls.put({
    id: 'legacy1', vesselId: 'v1', vesselName: '渔船甲', type: '进港',
    time: new Date().toISOString(), berthNo: 'X9', iceKg: 0, fuelL: 0,
    unloadKg: 99999, visaStatus: '已签证', createdAt: new Date().toISOString(),
  });
  const s7 = await getStorageSummary('p1');
  assert(s7.occupiedKg < 1000, '待盘点旧流水的 99999kg 未占用冷库');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
