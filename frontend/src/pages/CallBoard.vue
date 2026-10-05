<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import { CALL_TYPES, VISA_STATUSES, emptyCallDraft, type CallDraft, type CallType } from '../types/call';
import { formatDateTime, formatNumber, isToday, nowLocalInputValue, toPlain } from '../utils/format';

interface CallForm extends CallDraft {
  portId: string;
}

const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();

const { draft, restored, savedAt, storageKey, persist, restore, clearDraft } = useLocalDraft<CallForm>('call-board', () => ({
  ...emptyCallDraft(),
  portId: '',
  time: nowLocalInputValue(),
}));
const form = draft;

const formRef = ref<FormInstance>();
const submitting = ref(false);
const focusPortId = ref('');

/** 提交失败回显：容量不足 / 并发冲突时展示缺口与最新余量 */
const failurePanel = ref<{
  kind: 'capacity' | 'conflict' | 'invalid';
  message: string;
  shortageKg?: number;
  portName: string;
  latest?: { capacityKg: number; occupiedKg: number; freeKg: number };
} | null>(null);

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
};

const vesselOptions = computed(() => vesselStore.vessels);

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));

/** 进港只能选空闲泊位；出港只能选已占用泊位 */
const berthOptions = computed(() => {
  const wanted = form.value.type === '进港' ? '空闲' : '占用';
  return portStore.berths
    .filter((b) => b.status === wanted)
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
      portId: b.portId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
});

const berthKey = computed({
  get: () => (form.value.portId && form.value.berthNo ? `${form.value.portId}|${form.value.berthNo}` : ''),
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    form.value.portId = portId ?? '';
    form.value.berthNo = berthNo ?? '';
    focusPortId.value = portId ?? '';
  },
});

const focusBerths = computed<Berth[]>(() =>
  focusPortId.value ? portStore.berthsOf(focusPortId.value) : [],
);

const berthRef = computed(() => portStore.berths);
const { summary } = useBerthStatus(berthRef, computed(() => focusPortId.value));

/** 选中渔港的最新冷库余量（与渔港详情 / 地图 / 渔船档案读同一份库存） */
const focusStorage = computed(() =>
  focusPortId.value ? portStore.storageSummary(focusPortId.value) : null,
);

/** 本次卸货后的预计余量，容量不足时整笔提交会被拒绝 */
const projectedFreeKg = computed(() => {
  const s = focusStorage.value;
  if (!s) return null;
  return s.freeKg - (Number(form.value.unloadKg) || 0);
});

const todayCalls = computed(() =>
  portStore.callsSorted.filter((c) => isToday(c.time) && Boolean(c.portId)),
);

/** 旧流水没有港口归属：列为待盘点，不自动占用冷库 */
const pendingCalls = computed(() => portStore.pendingCalls);

async function assignPending(callId: string, portId: string): Promise<void> {
  await portStore.assignCallPort(callId, portId);
  ElMessage.success('已补录港口归属（仅作台账标注，未追补冷库占用）');
}

const todayStats = computed(() => ({
  inbound: todayCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayCalls.value.filter((c) => c.type === '出港').length,
  ice: todayCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function hasContent(value: CallForm): boolean {
  return (
    Boolean(value.vesselId) ||
    Boolean(value.berthNo) ||
    Number(value.iceKg) > 0 ||
    Number(value.fuelL) > 0 ||
    Number(value.unloadKg) > 0
  );
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (restore()) {
    if (hasContent(form.value)) {
      ElMessage.info(`已恢复本地草稿（保存于 ${formatDateTime(savedAt.value)}）`);
    } else {
      // 空草稿没有恢复价值，直接清掉，避免误报「已恢复草稿」
      clearDraft();
    }
  }
  if (form.value.portId) focusPortId.value = form.value.portId;
});

watch(
  () => toPlain(form.value),
  (value) => {
    // 只有存在有效输入时才落草稿；提交后表单被重置，草稿同步清空
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

watch(
  () => form.value.type,
  (type: CallType) => {
    const valid = berthOptions.value.some((opt) => opt.value === berthKey.value);
    if (!valid) berthKey.value = '';
    // 出港只结束航次，不能登记卸货（冷库货物须走提货出库）
    if (type === '出港') form.value.unloadKg = 0;
  },
);

function selectBerth(berth: Berth): void {
  berthKey.value = `${berth.portId}|${berth.berthNo}`;
  ElMessage.info(`已选择 ${berth.berthNo}`);
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  submitting.value = true;
  failurePanel.value = null;
  try {
    const payload: CallDraft = {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      berthNo: form.value.berthNo,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: Number(form.value.unloadKg) || 0,
      visaStatus: form.value.visaStatus,
    };
    const result = await portStore.registerCall(payload, selectedVessel.value.name, form.value.portId);
    if (result.status !== 'success') {
      // 整笔已被拒绝（泊位 / 冷库 / 锁），页面停留在失败态并展示最新余量
      const portName = portStore.portById(form.value.portId)?.name ?? form.value.portId;
      failurePanel.value = {
        kind: result.status,
        message: result.message,
        shortageKg: result.shortageKg,
        portName,
        latest: result.latest
          ? {
              capacityKg: result.latest.capacityKg,
              occupiedKg: result.latest.occupiedKg,
              freeKg: result.latest.freeKg,
            }
          : undefined,
      };
      ElMessage.error('登记被拒绝，整笔操作未写入');
      return;
    }
    const { call, batch } = result;
    ElMessage.success(
      batch
        ? `已登记 ${call.vesselName} 进港 · 泊位 ${call.berthNo} · 冷库入库 ${formatNumber(batch.totalKg, 0)} kg`
        : `已登记 ${call.vesselName} ${call.type} · 泊位 ${call.berthNo}`,
    );
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      portId: '',
      time: nowLocalInputValue(),
    });
    focusPortId.value = '';
  } catch (error) {
    ElMessage.error(`登记失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          选择渔船与进出港类型，填写泊位号、加冰量、加油量与卸货量，提交后自动同步泊位占用状态
        </p>
      </div>
    </header>

    <el-alert
      v-if="restored"
      type="info"
      show-icon
      :closable="false"
      title="已从浏览器本地草稿恢复未提交的表单"
      data-testid="draft-alert"
      class="draft-alert"
    >
      <template #default>
        草稿保存在 localStorage（键 {{ storageKey }}），提交成功后会清空。
      </template>
    </el-alert>

    <el-alert
      v-if="failurePanel"
      :type="failurePanel.kind === 'capacity' ? 'error' : 'warning'"
      show-icon
      :closable="true"
      class="draft-alert"
      data-testid="submit-failure"
      @close="failurePanel = null"
    >
      <template #title>
        {{ failurePanel.kind === 'capacity' ? '冷库容量不足，整笔登记已拒绝' : failurePanel.kind === 'conflict' ? '并发冲突，本笔未提交' : '登记被拒绝' }}
      </template>
      <div class="failure-box">
        <p>{{ failurePanel.message }}</p>
        <p v-if="failurePanel.shortageKg" class="failure-box__gap" data-testid="capacity-shortage">
          冷库缺口：<b>{{ formatNumber(failurePanel.shortageKg, 0) }} kg</b>
        </p>
        <div v-if="failurePanel.latest" class="failure-box__latest" data-testid="latest-storage">
          <span>{{ failurePanel.portName }} 冷库最新余量（另一台电脑提交后已刷新）</span>
          <el-descriptions :column="3" size="small" border>
            <el-descriptions-item label="容量">{{ formatNumber(failurePanel.latest.capacityKg, 0) }} kg</el-descriptions-item>
            <el-descriptions-item label="已占用">{{ formatNumber(failurePanel.latest.occupiedKg, 0) }} kg</el-descriptions-item>
            <el-descriptions-item label="剩余可用">
              <b :class="{ 'gap-text': failurePanel.latest.freeKg <= 0 }">
                {{ formatNumber(failurePanel.latest.freeKg, 0) }} kg
              </b>
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
    </el-alert>

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">登记表单</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" data-testid="call-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select id="call-vessel" v-model="form.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
                <el-option
                  v-for="v in vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
                  :value="v.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item label="进出港类型" prop="type">
              <el-radio-group v-model="form.type" data-testid="call-type">
                <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="时间" prop="time">
              <el-date-picker
                id="call-time"
                v-model="form.time"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                placeholder="选择时间"
                style="width: 100%"
              />
            </el-form-item>

            <el-form-item label="泊位号" prop="portId">
              <el-select
                id="call-berth"
                v-model="berthKey"
                :placeholder="form.type === '进港' ? '选择空闲泊位' : '选择已占用泊位'"
                style="width: 100%"
                data-testid="call-berth"
              >
                <el-option v-for="opt in berthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>

            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="加冰 kg" prop="iceKg">
                  <el-input-number id="call-ice" v-model="form.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="加油 L" prop="fuelL">
                  <el-input-number id="call-fuel" v-model="form.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="卸货量 kg" prop="unloadKg">
                  <el-input-number
                    id="call-unload"
                    v-model="form.unloadKg"
                    :min="0"
                    :max="200000"
                    :step="100"
                    :disabled="form.type === '出港'"
                    style="width: 100%"
                  />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item v-if="form.type === '进港' && focusStorage">
              <div class="storage-hint" data-testid="storage-hint">
                <el-progress
                  :percentage="Number((focusStorage.usageRate * 100).toFixed(1))"
                  :stroke-width="10"
                  :status="(projectedFreeKg ?? 0) < 0 ? 'exception' : focusStorage.usageRate >= 0.9 ? 'warning' : ''"
                />
                <span>
                  {{ portStore.portById(focusPortId)?.name ?? '' }} 冷库：容量 {{ formatNumber(focusStorage.capacityKg, 0) }} kg ·
                  已占用 {{ formatNumber(focusStorage.occupiedKg, 0) }} kg ·
                  剩余 <b :class="{ 'gap-text': (projectedFreeKg ?? 0) < 0 }">{{ formatNumber(focusStorage.freeKg, 0) }} kg</b>
                </span>
                <span v-if="(projectedFreeKg ?? 0) < 0" class="gap-text" data-testid="projected-shortage">
                  按当前卸货量将超 {{ formatNumber(-(projectedFreeKg ?? 0), 0) }} kg，保存会整笔拒绝
                </span>
              </div>
            </el-form-item>
            <el-form-item v-else-if="form.type === '出港'">
              <p class="field-tip">出港只结束航次并释放泊位，冷库中尚未提走的货不会被清掉，需另行办理提货出库。</p>
            </el-form-item>

            <el-form-item label="签证状态" prop="visaStatus">
              <el-select id="call-visa" v-model="form.visaStatus" style="width: 100%">
                <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :loading="submitting" data-testid="submit-call" @click="submit">保存登记</el-button>
              <el-button data-testid="clear-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空草稿</el-button>
              <el-button v-if="selectedVessel" text type="primary" @click="openVessel(selectedVessel.id)">查看渔船档案</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card v-if="focusStorage" shadow="never" class="detail-card storage-card" data-testid="focus-storage-card">
          <template #header>
            <span class="card-title">冷库余量 · {{ portStore.portById(focusPortId)?.name ?? '' }}</span>
          </template>
          <el-progress
            :percentage="Number((focusStorage.usageRate * 100).toFixed(1))"
            :stroke-width="14"
            :status="focusStorage.usageRate >= 1 ? 'exception' : focusStorage.usageRate >= 0.9 ? 'warning' : ''"
          />
          <div class="stat-row storage-stat">
            <div class="stat"><span class="stat__label">容量 kg</span><b>{{ formatNumber(focusStorage.capacityKg, 0) }}</b></div>
            <div class="stat"><span class="stat__label">在库 kg</span><b>{{ formatNumber(focusStorage.occupiedKg, 0) }}</b></div>
            <div class="stat"><span class="stat__label">余量 kg</span><b>{{ formatNumber(focusStorage.freeKg, 0) }}</b></div>
            <div class="stat"><span class="stat__label">在库批次</span><b>{{ focusStorage.batchCount }}</b></div>
          </div>
          <p class="detail-hint">卸货量在保存泊位占用的同一笔事务里入库，容量不足整笔拒绝并回显缺口。</p>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">今日统计</span>
          </template>
          <div class="stat-row">
            <div class="stat"><span class="stat__label">进港</span><b>{{ todayStats.inbound }}</b></div>
            <div class="stat"><span class="stat__label">出港</span><b>{{ todayStats.outbound }}</b></div>
            <div class="stat"><span class="stat__label">加冰 kg</span><b>{{ formatNumber(todayStats.ice, 0) }}</b></div>
            <div class="stat"><span class="stat__label">加油 L</span><b>{{ formatNumber(todayStats.fuel, 0) }}</b></div>
            <div class="stat"><span class="stat__label">卸货 kg</span><b>{{ formatNumber(todayStats.unload, 0) }}</b></div>
          </div>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">
              泊位占用网格{{ focusPortId ? ` · ${portStore.portById(focusPortId)?.name ?? ''}` : '（选择泊位后聚焦对应渔港）' }}
            </span>
          </template>
          <BerthGrid v-if="focusBerths.length" :berths="focusBerths" @select="selectBerth" />
          <EmptyState v-else title="尚未选择渔港泊位" description="在左侧表单选择泊位，或直接点击泊位网格中的方块。">
            <el-button type="primary" @click="focusPortId = portStore.ports[0]?.id ?? ''">聚焦第一座渔港</el-button>
          </EmptyState>
          <p v-if="focusBerths.length" class="detail-hint">
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 占用 {{ summary.occupied }} · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }}
          </p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">今日流水（{{ todayCalls.length }} 条）</span></template>
      <el-table :data="todayCalls" size="small" border empty-text="今日暂无进出港流水" data-testid="today-calls">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column label="渔港" min-width="120">
          <template #default="scope">
            {{ scope.row.portId ? portStore.portById(scope.row.portId)?.name ?? scope.row.portId : '待盘点' }}
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="泊位号" width="90" />
        <el-table-column label="加冰 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="110">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证状态" width="110" />
      </el-table>
    </el-card>

    <el-card v-if="pendingCalls.length" shadow="never" class="detail-card" data-testid="pending-calls-card">
      <template #header>
        <span class="card-title">待盘点流水（{{ pendingCalls.length }} 条）</span>
      </template>
      <el-alert type="warning" show-icon :closable="false" class="draft-alert">
        以下旧流水没有港口归属，<b>不会自动占用任何渔港冷库</b>。请人工核实后补录归属；补录仅作台账标注，不追补冷库占用。
      </el-alert>
      <el-table :data="pendingCalls" size="small" border class="pending-table">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="原泊位号" width="100" />
        <el-table-column label="卸货 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="补录渔港归属" min-width="220">
          <template #default="scope">
            <el-select
              :model-value="''"
              placeholder="选择实际卸货渔港"
              size="small"
              filterable
              style="width: 100%"
              :data-testid="`assign-port-${scope.row.id}`"
              @change="(portId: string) => assignPending(scope.row.id, portId)"
            >
              <el-option v-for="p in portStore.ports" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.draft-alert {
  border-radius: 10px;
}
.stat-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  color: #7b8a99;
}
.stat b {
  font-size: 18px;
  color: #17324d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.storage-hint {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  font-size: 12px;
  color: #5b6b7b;
}
.field-tip {
  margin: 0;
  font-size: 12px;
  color: #b38600;
}
.gap-text {
  color: #f56c6c;
}
.storage-card .storage-stat {
  margin-top: 10px;
}
.failure-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.failure-box__gap b {
  color: #f56c6c;
  font-size: 15px;
}
.failure-box__latest {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #6b7c8c;
}
</style>
