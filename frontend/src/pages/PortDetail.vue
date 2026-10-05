<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useBerthStatus } from '../hooks/useBerthStatus';
import PortCard from '../components/common/PortCard.vue';
import BerthGrid from '../components/common/BerthGrid.vue';
import MapPanel from '../components/common/MapPanel.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import type { StorageBatch } from '../types/storage';
import { formatDateTime, formatNumber, percentText } from '../utils/format';
import { supplyText } from '../types/port';

const route = useRoute();
const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();

const portId = computed(() => String(route.params.id ?? ''));
const port = computed(() => portStore.portById(portId.value));
const berthsRef = computed(() => portStore.berths);
const { summary, summaryOf, inPortVessels } = useBerthStatus(berthsRef, portId);
const portBerths = computed(() => portStore.berthsOf(portId.value));

/** 与地图摘要、渔船档案读同一份库存缓存（liveQuery 保证多标签页一致） */
const storage = computed(() => portStore.storageSummary(portId.value));
const batches = computed<StorageBatch[]>(() => portStore.batchesOfPort(portId.value));
const activeBatches = computed(() => batches.value.filter((b) => b.remainingKg > 0));

const pickupVisible = ref(false);
const pickupSubmitting = ref(false);
const pickupBatch = ref<StorageBatch | null>(null);
const pickupQty = ref(0);
const pickupError = ref('');

function openPickup(batch: StorageBatch): void {
  pickupBatch.value = batch;
  pickupQty.value = batch.remainingKg;
  pickupError.value = '';
  pickupVisible.value = true;
}

async function submitPickup(): Promise<void> {
  if (!pickupBatch.value) return;
  pickupSubmitting.value = true;
  pickupError.value = '';
  try {
    const result = await portStore.pickup(pickupBatch.value.id, pickupQty.value);
    if (result.status !== 'success') {
      pickupError.value = result.shortageKg
        ? `${result.message}（缺口 ${formatNumber(result.shortageKg, 0)} kg）`
        : result.message;
      return;
    }
    ElMessage.success(
      `提货 ${formatNumber(result.pickup.quantityKg, 0)} kg，冷库余量恢复至 ${formatNumber(result.summary.freeKg, 0)} kg`,
    );
    pickupVisible.value = false;
  } finally {
    pickupSubmitting.value = false;
  }
}

const activeBerthId = ref('');
const berthDialogVisible = ref(false);
const activeBerth = computed<Berth | null>(
  () => portStore.berths.find((b) => b.id === activeBerthId.value) ?? null,
);
const activeVessel = computed(() =>
  activeBerth.value?.vesselId ? vesselStore.vesselById(activeBerth.value.vesselId) : undefined,
);

const addBerthVisible = ref(false);
const addBerthForm = reactive({ berthNo: '', designDepth: 4.5 });

/** 近日流水严格按港口归属过滤（旧流水没有 portId 不会混进来） */
const recentCalls = computed(() => portStore.callsOfPort(portId.value).slice(0, 8));

const supply = computed(() => (port.value ? supplyText(port.value.supply) : '—'));

const loaded = ref(false);

async function bootstrap(): Promise<void> {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  loaded.value = true;
}

onMounted(bootstrap);
watch(portId, bootstrap);

function openBerth(berth: Berth): void {
  activeBerthId.value = berth.id;
  berthDialogVisible.value = true;
}

async function markMaintenance(): Promise<void> {
  const berth = activeBerth.value;
  if (!berth) return;
  await portStore.setBerthStatus(berth.id, '维修');
  ElMessage.success(`${berth.berthNo} 已置为维修`);
}

async function releaseBerth(): Promise<void> {
  const berth = activeBerth.value;
  if (!berth) return;
  await portStore.setBerthStatus(berth.id, '空闲');
  ElMessage.success(`${berth.berthNo} 已释放为空闲`);
}

async function submitBerth(): Promise<void> {
  const no = addBerthForm.berthNo.trim();
  if (!no) {
    ElMessage.warning('请填写泊位号，如 B09');
    return;
  }
  const created = await portStore.addBerth(portId.value, no, addBerthForm.designDepth);
  if (!created) {
    ElMessage.warning('该泊位号已存在');
    return;
  }
  addBerthVisible.value = false;
  addBerthForm.berthNo = '';
  ElMessage.success(`已新增泊位 ${created.berthNo}`);
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}

function onMapSelect(selectedPortId: string): void {
  if (selectedPortId === portId.value) {
    ElMessage.info('当前即为该渔港');
    return;
  }
  void router.push(`/ports/${selectedPortId}`);
}
</script>

<template>
  <section class="page">
    <el-breadcrumb separator="/">
      <el-breadcrumb-item :to="{ path: '/' }">渔港一览</el-breadcrumb-item>
      <el-breadcrumb-item>{{ port ? port.name : '渔港详情' }}</el-breadcrumb-item>
    </el-breadcrumb>

    <template v-if="port">
      <header class="page__head">
        <div>
          <h1>{{ port.name }}</h1>
          <p class="page__sub">{{ port.level }} · 管理单位：{{ port.manager }}</p>
        </div>
        <div class="page__head-actions">
          <el-button data-testid="open-berth-dialog" @click="addBerthVisible = true">新增泊位</el-button>
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </div>
      </header>

      <el-row :gutter="16">
        <el-col :lg="10" :md="24">
          <PortCard :port="port" :summary="summaryOf(port.id)" :clickable="false" />
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">基本信息与补给能力</span></template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="经纬度">
                {{ formatNumber(port.longitude, 4) }}°E / {{ formatNumber(port.latitude, 4) }}°N
              </el-descriptions-item>
              <el-descriptions-item label="泊位数">{{ port.berthCount }} 个</el-descriptions-item>
              <el-descriptions-item label="泊位水深">{{ formatNumber(port.berthDepth) }} m</el-descriptions-item>
              <el-descriptions-item label="码头长度">{{ formatNumber(port.wharfLength, 0) }} m</el-descriptions-item>
              <el-descriptions-item label="避风能力">{{ port.shelterLevel }} 级</el-descriptions-item>
              <el-descriptions-item label="补给能力">{{ supply }}</el-descriptions-item>
              <el-descriptions-item label="冷库容量">
                {{ formatNumber(port.coldStorageKg, 0) }} kg
              </el-descriptions-item>
            </el-descriptions>
            <p class="detail-hint">
              当前占用率 {{ percentText(summary.occupancyRate) }}（占用 {{ summary.occupied }} / 空闲 {{ summary.free }} / 维修 {{ summary.maintenance }}）
            </p>
            <p class="detail-hint" data-testid="port-storage-line">
              冷库占用 {{ formatNumber(storage.occupiedKg, 0) }} / {{ formatNumber(storage.capacityKg, 0) }} kg ·
              余量 <b :class="{ 'gap-text': storage.freeKg <= 0 }">{{ formatNumber(storage.freeKg, 0) }} kg</b> ·
              在库批次 {{ storage.batchCount }} 个
            </p>
          </el-card>
        </el-col>

        <el-col :lg="14" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">渔港分布（地图 / 网格）</span></template>
            <MapPanel
              :ports="portStore.ports"
              :berths="portStore.berths"
              :focused-port-id="port.id"
              :height="300"
              @select-port="onMapSelect"
            />
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">泊位网格（点击泊位查看占用船舶）</span>
        </template>
        <BerthGrid v-if="portBerths.length" :berths="portBerths" @select="openBerth" />
        <EmptyState v-else title="该渔港暂无泊位记录" description="点击右上角「新增泊位」为该渔港建立泊位清单。">
          <el-button type="primary" @click="addBerthVisible = true">新增泊位</el-button>
        </EmptyState>
      </el-card>

      <el-card shadow="never" class="detail-card" data-testid="cold-storage-card">
        <template #header>
          <span class="card-title">冷库库存（按进港批次）</span>
        </template>
        <el-progress
          :percentage="Number((storage.usageRate * 100).toFixed(1))"
          :stroke-width="14"
          :status="storage.usageRate >= 1 ? 'exception' : storage.usageRate >= 0.9 ? 'warning' : ''"
        />
        <div class="storage-stat-row">
          <span>容量 <b>{{ formatNumber(storage.capacityKg, 0) }} kg</b></span>
          <span>在库 <b>{{ formatNumber(storage.occupiedKg, 0) }} kg</b></span>
          <span>余量 <b :class="{ 'gap-text': storage.freeKg <= 0 }">{{ formatNumber(storage.freeKg, 0) }} kg</b></span>
        </div>
        <el-table :data="activeBatches" size="small" border empty-text="冷库当前无在库批次（待盘点旧流水不占容量）" class="storage-table">
          <el-table-column prop="vesselName" label="渔船" min-width="120" />
          <el-table-column label="入库时间" min-width="150">
            <template #default="scope">{{ formatDateTime(scope.row.storedAt) }}</template>
          </el-table-column>
          <el-table-column label="入库 kg" width="100">
            <template #default="scope">{{ formatNumber(scope.row.totalKg, 0) }}</template>
          </el-table-column>
          <el-table-column label="剩余 kg" width="100">
            <template #default="scope">
              <b>{{ formatNumber(scope.row.remainingKg, 0) }}</b>
            </template>
          </el-table-column>
          <el-table-column label="已提 kg" width="100">
            <template #default="scope">{{ formatNumber(scope.row.pickedKg, 0) }}</template>
          </el-table-column>
          <el-table-column label="最近提货" min-width="150">
            <template #default="scope">{{ formatDateTime(scope.row.lastPickupAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="scope">
              <el-button text type="primary" size="small" data-testid="pickup-btn" @click="openPickup(scope.row)">
                提货出库
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <p class="detail-hint">提货按批次扣减并立即释放容量；出港只结束航次，不会清掉这里尚未提走的货。</p>
      </el-card>

      <el-row :gutter="16">
        <el-col :lg="12" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">在港船舶（{{ inPortVessels.length }} 艘）</span></template>
            <el-table :data="inPortVessels" size="small" border empty-text="当前无在港船舶">
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column prop="berthNo" label="泊位号" width="90" />
              <el-table-column label="靠泊时间" min-width="150">
                <template #default="scope">{{ formatDateTime(scope.row.berthAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="100">
                <template #default="scope">
                  <el-button
                    text
                    type="primary"
                    size="small"
                    :disabled="!scope.row.vesselId"
                    @click="openVessel(scope.row.vesselId)"
                  >
                    档案
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>

        <el-col :lg="12" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">近日流水</span></template>
            <el-table :data="recentCalls" size="small" border empty-text="暂无进出港流水">
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column prop="type" label="类型" width="80" />
              <el-table-column label="时间" min-width="150">
                <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
              </el-table-column>
              <el-table-column prop="berthNo" label="泊位号" width="90" />
              <el-table-column label="卸货 kg" min-width="100">
                <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>
    </template>

    <EmptyState
      v-else-if="loaded"
      title="未找到该渔港"
      description="该渔港可能尚未登记，返回一览页登记后再查看。"
    >
      <el-button type="primary" @click="router.push('/')">返回渔港一览</el-button>
    </EmptyState>

    <el-dialog v-model="berthDialogVisible" title="泊位占用详情" width="520px" data-testid="berth-dialog">
      <template v-if="activeBerth">
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="泊位号">{{ activeBerth.berthNo }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="activeBerth.status === '占用' ? 'warning' : activeBerth.status === '维修' ? 'info' : 'success'">
              {{ activeBerth.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="设计水深">{{ formatNumber(activeBerth.designDepth) }} m</el-descriptions-item>
          <el-descriptions-item label="占用渔船">
            <template v-if="activeBerth.vesselName">
              <el-link type="primary" data-testid="berth-vessel-link" @click="activeBerth.vesselId && openVessel(activeBerth.vesselId)">
                {{ activeBerth.vesselName }}
              </el-link>
            </template>
            <template v-else>—</template>
          </el-descriptions-item>
          <el-descriptions-item label="靠泊时间">{{ formatDateTime(activeBerth.berthAt) }}</el-descriptions-item>
          <el-descriptions-item label="离泊时间">{{ formatDateTime(activeBerth.leaveAt) }}</el-descriptions-item>
          <el-descriptions-item label="主机功率">
            {{ activeVessel ? `${formatNumber(activeVessel.enginePower, 0)} kW` : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="总吨位">
            {{ activeVessel ? `${formatNumber(activeVessel.grossTonnage)} t` : '—' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="berthDialogVisible = false">关闭</el-button>
        <el-button type="warning" data-testid="berth-maintenance" @click="markMaintenance">置为维修</el-button>
        <el-button type="success" data-testid="berth-release" @click="releaseBerth">释放为空闲</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="addBerthVisible" title="新增泊位" width="420px">
      <el-form label-width="90px">
        <el-form-item label="泊位号">
          <el-input id="berth-no" v-model="addBerthForm.berthNo" placeholder="如：B09" />
        </el-form-item>
        <el-form-item label="设计水深 m">
          <el-input-number id="berth-depth" v-model="addBerthForm.designDepth" :min="1" :max="30" :step="0.1" :precision="1" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addBerthVisible = false">取消</el-button>
        <el-button type="primary" data-testid="submit-berth" @click="submitBerth">保存泊位</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pickupVisible" title="渔船提货出库" width="460px" data-testid="pickup-dialog">
      <template v-if="pickupBatch">
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="渔船">{{ pickupBatch.vesselName }}</el-descriptions-item>
          <el-descriptions-item label="入库时间">{{ formatDateTime(pickupBatch.storedAt) }}</el-descriptions-item>
          <el-descriptions-item label="批次剩余">
            {{ formatNumber(pickupBatch.remainingKg, 0) }} kg（入库 {{ formatNumber(pickupBatch.totalKg, 0) }} kg，已提 {{ formatNumber(pickupBatch.pickedKg, 0) }} kg）
          </el-descriptions-item>
        </el-descriptions>
        <el-form label-width="100px" style="margin-top: 12px">
          <el-form-item label="提货量 kg">
            <el-input-number
              v-model="pickupQty"
              :min="1"
              :max="pickupBatch.remainingKg"
              :step="100"
              style="width: 100%"
              data-testid="pickup-qty"
            />
          </el-form-item>
        </el-form>
        <el-alert v-if="pickupError" type="error" show-icon :closable="false" :title="pickupError" />
      </template>
      <template #footer>
        <el-button @click="pickupVisible = false">取消</el-button>
        <el-button type="primary" :loading="pickupSubmitting" data-testid="submit-pickup" @click="submitPickup">
          确认提货并释放容量
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.page__head-actions {
  display: flex;
  gap: 8px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.gap-text {
  color: #f56c6c;
}
.storage-stat-row {
  display: flex;
  gap: 20px;
  margin-top: 10px;
  font-size: 13px;
  color: #5b6b7b;
  flex-wrap: wrap;
}
.storage-stat-row b {
  color: #17324d;
}
.storage-table {
  margin-top: 12px;
}
</style>
