<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import type { StorageConflictInfo } from '../db/errors';
import { BerthConflictError, StorageCapacityError, StorageConflictError } from '../db/errors';
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
/** 最近一次提交失败的冲突信息（失败页展示缺口与最新余量） */
const failure = ref<StorageConflictInfo | null>(null);
const failureKind = ref<'capacity' | 'conflict' | 'berth' | ''>('');
const failureMessage = ref('');

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
    failure.value = null;
    failureKind.value = '';
  },
});

const focusBerths = computed<Berth[]>(() =>
  focusPortId.value ? portStore.berthsOf(focusPortId.value) : [],
);

const berthRef = computed(() => portStore.berths);
const { summary } = useBerthStatus(berthRef, computed(() => focusPortId.value));

/** 选中渔港的冷库实时余量（与渔港详情 / 地图 / 渔船档案读同一份台账） */
const focusStorage = computed(() => (focusPortId.value ? portStore.storageOf(focusPortId.value) : null));
const focusPort = computed(() => (focusPortId.value ? portStore.portById(focusPortId.value) : undefined));

/** 该渔船尚未提走的冷库批次（出港时提示货仍在库，出港不会清掉） */
const selectedVesselCargo = computed(() =>
  form.value.vesselId ? portStore.activeBatchesOfVessel(form.value.vesselId, form.value.portId || undefined) : [],
);

const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time) && c.portId));

const pendingCalls = computed(() => portStore.pendingCalls);

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
    // 出港不允许填卸货量：只结束航次，冷库货物按批次提货单独出库
    if (type === '出港') form.value.unloadKg = 0;
  },
);

watch(
  () => form.value.unloadKg,
  () => {
    // 修改卸货量后，上次容量不足的失败提示作废，等待重新提交校验
    if (failureKind.value === 'capacity') {
      failure.value = null;
      failureKind.value = '';
    }
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
  failure.value = null;
  failureKind.value = '';
  failureMessage.value = '';
  try {
    const payload: CallDraft = {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      berthNo: form.value.berthNo,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: form.value.type === '进港' ? Number(form.value.unloadKg) || 0 : 0,
      visaStatus: form.value.visaStatus,
    };
    // 乐观锁基线：提交时按当前页读到的台账版本号；另一终端已先提交则本笔被整笔拒绝
    const expectedVersion = portStore.ledgerOf(form.value.portId)?.version ?? null;
    const result = await portStore.registerCall({
      draft: payload,
      vesselName: selectedVessel.value.name,
      portId: form.value.portId,
      expectedVersion,
    });
    if (result.batch) {
      ElMessage.success(
        `已登记 ${result.call.vesselName} 进港 · 泊位 ${result.call.berthNo} · 冷库占用 ${formatNumber(
          result.batch.inflowKg,
          0,
        )} kg，余量 ${formatNumber(result.ledger.capacityKg - result.ledger.usedKg, 0)} kg`,
      );
    } else {
      ElMessage.success(`已登记 ${result.call.vesselName} ${result.call.type} · 泊位 ${result.call.berthNo}`);
    }
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      portId: '',
      time: nowLocalInputValue(),
    });
    focusPortId.value = '';
  } catch (error) {
    // 失败后立即重读：失败页展示的余量 / 版本号必须是最新值
    await portStore.loadAll();
    if (error instanceof StorageCapacityError) {
      failureKind.value = 'capacity';
      failure.value = error.info;
      failureMessage.value = error.message;
    } else if (error instanceof StorageConflictError) {
      failureKind.value = 'conflict';
      failure.value = error.info;
      failureMessage.value = error.message;
    } else if (error instanceof BerthConflictError) {
      failureKind.value = 'berth';
      failureMessage.value = error.message;
    } else {
      failureKind.value = '';
      failureMessage.value = (error as Error).message;
      ElMessage.error(`登记失败：${failureMessage.value}`);
    }
  } finally {
    submitting.value = false;
  }
}

/** 容量不足被拒后，按最新余量把卸货量改成能装下的值，便于直接重提 */
function applyMaxUnload(): void {
  if (!failure.value) return;
  form.value.unloadKg = failure.value.freeKg;
}

/** 待盘点流水人工归档：只补港口归属，绝不追溯占用冷库 */
async function assignPending(callId: string): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请输入该流水归属的渔港名称（系统按名称匹配）', '盘点旧流水', {
      confirmButtonText: '归档',
      cancelButtonText: '取消',
      inputPlaceholder: '如：石浦中心渔港',
    });
    const port = portStore.ports.find((p) => p.name === String(value).trim());
    if (!port) {
      ElMessage.warning('未找到该渔港，请先登记渔港');
      return;
    }
    await portStore.assignPendingCall(callId, port.id);
    ElMessage.success(`已归档到 ${port.name}（不追溯占用冷库）`);
  } catch {
    // 用户取消
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
          进港卸货与泊位占用、冷库占用在同一笔操作保存：冷库容量不足整笔拒绝；出港只结束航次，未提走的货继续在库
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

    <!-- 提交失败页：容量缺口 / 并发冲突都在此显示最新余量 -->
    <el-alert
      v-if="failure"
      type="error"
      show-icon
      :closable="false"
      class="failure-alert"
      data-testid="register-failure"
    >
      <template #title>
        {{ failureKind === 'capacity' ? '冷库容量不足，本笔登记已整笔拒绝（泊位与流水均未保存）' : '同一渔港刚被另一终端登记，本笔已拒绝' }}
      </template>
      <div class="failure-body">
        <p class="failure-line">{{ failureMessage }}</p>
        <el-descriptions :column="3" size="small" border class="failure-desc">
          <el-descriptions-item label="渔港">{{ failure.portName }}</el-descriptions-item>
          <el-descriptions-item label="冷库容量">{{ formatNumber(failure.capacityKg, 0) }} kg</el-descriptions-item>
          <el-descriptions-item label="已占用">{{ formatNumber(failure.usedKg, 0) }} kg</el-descriptions-item>
          <el-descriptions-item label="最新余量">
            <b class="failure-free">{{ formatNumber(failure.freeKg, 0) }} kg</b>
          </el-descriptions-item>
          <el-descriptions-item label="本笔申请">
            {{ formatNumber(failure.requiredKg, 0) }} kg
          </el-descriptions-item>
          <el-descriptions-item label="缺口">
            <b class="failure-gap">{{ formatNumber(failure.shortageKg, 0) }} kg</b>
          </el-descriptions-item>
        </el-descriptions>
        <div class="failure-actions">
          <el-button v-if="failureKind === 'capacity'" type="primary" size="small" @click="applyMaxUnload">
            卸货量改为余量 {{ formatNumber(failure.freeKg, 0) }} kg 后重填
          </el-button>
          <span class="failure-hint">台账版本 {{ failure.version }} · 请按最新余量调整后重新提交</span>
        </div>
      </div>
    </el-alert>
    <el-alert
      v-else-if="failureKind === 'berth'"
      type="error"
      show-icon
      :closable="false"
      class="failure-alert"
      data-testid="register-failure"
      :title="failureMessage"
    />

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

            <el-alert
              v-if="focusStorage && form.type === '进港'"
              :type="focusStorage.freeKg <= 0 ? 'error' : focusStorage.usageRate >= 0.8 ? 'warning' : 'success'"
              show-icon
              :closable="false"
              class="storage-hint"
              data-testid="storage-hint"
            >
              <template #title>
                {{ focusPort?.name }} 冷库余量 {{ formatNumber(focusStorage.freeKg, 0) }} /
                {{ formatNumber(focusStorage.capacityKg, 0) }} kg
                （已占用 {{ formatNumber(focusStorage.usedKg, 0) }} kg）
              </template>
              <template #default>
                卸货量超过余量时，泊位占用与流水将整笔回滚，不会出现船已靠泊但冷库爆仓。
              </template>
            </el-alert>
            <el-alert
              v-if="form.type === '出港' && selectedVesselCargo.length"
              type="warning"
              show-icon
              :closable="false"
              class="storage-hint"
              data-testid="cargo-left-hint"
            >
              <template #title>
                {{ selectedVessel?.name }} 还有 {{ selectedVesselCargo.length }} 批共
                {{ formatNumber(selectedVesselCargo.reduce((s, b) => s + (b.inflowKg - b.pickedKg), 0), 0) }}
                kg 货未提走
              </template>
              <template #default>
                出港只结束航次并释放泊位，冷库货物继续在库占用容量，请到渔港详情办理提货出库。
              </template>
            </el-alert>

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
            <p v-if="form.type === '出港'" class="field-hint">出港不登记卸货量；冷库提货按批次在渔港详情中办理。</p>

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
              泊位占用网格{{ focusPortId ? ` · ${focusPort?.name ?? ''}` : '（选择泊位后聚焦对应渔港）' }}
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
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="渔港" min-width="130">
          <template #default="scope">{{ portStore.portById(scope.row.portId)?.name ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="泊位号" width="90" />
        <el-table-column label="卸货 kg" min-width="110">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证状态" width="110" />
      </el-table>
    </el-card>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <span class="card-title">待盘点旧流水（{{ pendingCalls.length }} 条 · 无港口归属，不占冷库）</span>
      </template>
      <el-table :data="pendingCalls" size="small" border empty-text="没有待盘点流水" data-testid="pending-calls">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="原泊位号" width="90" />
        <el-table-column label="卸货 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default>
            <el-tag size="small" type="warning" effect="plain">待盘点</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="scope">
            <el-button text type="primary" size="small" data-testid="assign-pending" @click="assignPending(scope.row.id)">
              盘点归档
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="detail-hint">
        旧流水缺少港口归属，系统不会据此自动占用冷库；人工归档仅补归属用于查询，历史卸货量不追溯入库。
      </p>
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
.failure-alert {
  border-radius: 10px;
}
.failure-body {
  margin-top: 6px;
}
.failure-line {
  margin: 0 0 8px;
  font-size: 13px;
}
.failure-desc {
  margin-bottom: 10px;
}
.failure-free {
  color: #17324d;
}
.failure-gap {
  color: #f56c6c;
}
.failure-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.failure-hint {
  font-size: 12px;
  color: #9aa9b6;
}
.storage-hint {
  margin-bottom: 14px;
}
.field-hint {
  margin: -6px 0 14px 110px;
  font-size: 12px;
  color: #9aa9b6;
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
</style>
