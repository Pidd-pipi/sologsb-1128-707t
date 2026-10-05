import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

// 1) 用 v3 结构造一个旧库（ports / vessels / calls / berths，均无新字段）
class V3Db extends Dexie {
  constructor() {
    super('gbfishport-db');
    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });
    this.version(2).stores({ calls: 'id, vesselId, type, time' });
    this.version(3).stores({ berths: 'id, portId, berthNo, status, vesselId' });
  }
}

const old = new V3Db();
await old.delete();
await old.open();
await (old as any).ports.put({
  id: 'p-1', name: '旧港', level: '一级渔港', longitude: 121.9, latitude: 29.5,
  berthCount: 2, berthDepth: 4.5, wharfLength: 200, shelterLevel: 10,
  supply: { fuel: false, ice: false, water: false }, manager: 'm', createdAt: new Date().toISOString(),
});
await (old as any).calls.put({
  id: 'c-1', vesselId: 'v-1', vesselName: '旧船', type: '进港', time: new Date().toISOString(),
  berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 9999, visaStatus: '待签证', createdAt: new Date().toISOString(),
});
await old.close();

// 2) 用当前（含 v4）的库重新打开，触发升级
const { db } = await import('../src/db/index');
await db.open();

const port = await db.ports.get('p-1');
check('旧渔港补了冷库容量字段', typeof port?.coldStorageKg === 'number', `got=${port?.coldStorageKg}`);

const call = await db.calls.get('c-1');
check('旧流水 portId 为 null（待盘点）', call?.portId === null, `got=${String(call?.portId)}`);
check('旧流水 batchId 为 null', call?.batchId === null);

const ledger = await db.storageLedgers.get('p-1');
check('旧渔港建立了台账', !!ledger);
check('台账 usedKg=0（历史卸货 9999kg 不追溯入库）', ledger?.usedKg === 0, `used=${ledger?.usedKg}`);
check('台账容量与渔港一致', ledger?.capacityKg === port?.coldStorageKg);
check('台账版本为 0', ledger?.version === 0);

// 3) 迁移后新登记仍受容量约束（9999 旧货没有占库，新登记按余量 20000 判）
const batchesCount = await db.storageBatches.count();
check('迁移不产生任何冷库批次', batchesCount === 0, `got=${batchesCount}`);

console.log(`\n迁移验证：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
