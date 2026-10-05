<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { usePortStore } from '../../stores/portStore';
import { PickupExceedError } from '../../db/errors';
import { formatDateTime, formatNumber } from '../../utils/format';

const props = defineProps<{ portId: string; compact?: boolean }>();

const portStore = usePortStore();

const port = computed(() => portStore.portById(props.portId));
const storage = computed(() => portStore.storageOf(props.portId));
const batches = computed(() => portStore.batchesOfPort(props.portId));
const activeBatches = computed(() => batches.value.filter((b) => b.status === '在库'));
const finishedBatches = computed(() => batches.value.filter((b) => b.status === '已提完'));

const progressColor = computed(() => {
  const rate = storage.value?.usageRate ?? 0;
  if (rate >= 1) return '#f56c6c';
  if (rate >= 0.8) return '#e6a23c';
  if (rate >= 0.5) return '#409eff';
  return '#67c23a';
});

const dialogVisible = ref(false);
const submitting = ref(false);
const pickupForm = reactive({ batchId: '', amountKg: 0 });

const activeBatch = computed(() => activeBatches.value.find((b) => b.id === pickupForm.batchId));
const activeRemaining = computed(() =>
  activeBatch.value ? activeBatch.value.inflowKg - activeBatch.value.pickedKg : 0,
);

function openPickup(batchId?: string): void {
  const first = batchId ?? activeBatches.value[0]?.id ?? '';
  pickupForm.batchId = first;
  const target = activeBatches.value.find((b) => b.id === first);
  pickupForm.amountKg = target ? target.inflowKg - target.pickedKg : 0;
  dialogVisible.value = true;
}

async function submitPickup(): Promise<void> {
  if (!pickupForm.batchId) {
    ElMessage.warning('请选择入库批次');
    return;
  }
  if (!(pickupForm.amountKg > 0)) {
    ElMessage.warning('提货量必须大于 0');
    return;
  }
  submitting.value = true;
  try {
    const result = await portStore.pickup({
      batchId: pickupForm.batchId,
      amountKg: pickupForm.amountKg,
    });
    ElMessage.success(
      `已提货出库 ${formatNumber(result.pickup.amountKg, 0)} kg，冷库释放等量容量`,
    );
    dialogVisible.value = false;
  } catch (error) {
    if (error instanceof PickupExceedError) {
      ElMessage.error(`提货被拒绝：${error.message}`);
      pickupForm.amountKg = error.remainingKg;
    } else {
      ElMessage.error(`提货失败：${(error as Error).message}`);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-card shadow="never" class="detail-card storage-card" data-testid="storage-card">
    <template #header>
      <div class="storage-card__head">
        <span class="card-title">冷库库存{{ port ? ` · ${port.name}` : '' }}</span>
        <el-button
          v-if="activeBatches.length"
          type="primary"
          size="small"
          data-testid="open-pickup-dialog"
          @click="openPickup()"
        >
          渔船提货出库
        </el-button>
      </div>
    </template>

    <template v-if="storage">
      <div class="storage-card__progress">
        <span class="storage-card__label">
          容量占用 {{ formatNumber(storage.usedKg, 0) }} / {{ formatNumber(storage.capacityKg, 0) }} kg
        </span>
        <el-progress
          :percentage="Number((storage.usageRate * 100).toFixed(1))"
          :color="progressColor"
          :stroke-width="14"
          :status="storage.usageRate >= 1 ? 'exception' : undefined"
        />
      </div>
      <div class="storage-card__stats">
        <span>余量 <b :class="{ 'is-over': storage.freeKg <= 0 }">{{ formatNumber(storage.freeKg, 0) }} kg</b></span>
        <span>已占用 <b>{{ formatNumber(storage.usedKg, 0) }} kg</b></span>
        <span>在库批次 <b>{{ storage.batchCount }}</b></span>
      </div>

      <template v-if="!compact">
        <el-table
          :data="activeBatches"
          size="small"
          border
          class="storage-card__table"
          empty-text="当前没有在库货物"
          data-testid="storage-batches"
        >
          <el-table-column prop="vesselName" label="渔船" min-width="120" />
          <el-table-column label="入库时间" min-width="140">
            <template #default="scope">{{ formatDateTime(scope.row.storedAt) }}</template>
          </el-table-column>
          <el-table-column label="入库 kg" width="100">
            <template #default="scope">{{ formatNumber(scope.row.inflowKg, 0) }}</template>
          </el-table-column>
          <el-table-column label="已提 kg" width="100">
            <template #default="scope">{{ formatNumber(scope.row.pickedKg, 0) }}</template>
          </el-table-column>
          <el-table-column label="在库 kg" width="100">
            <template #default="scope">
              <b>{{ formatNumber(scope.row.inflowKg - scope.row.pickedKg, 0) }}</b>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="92">
            <template #default="scope">
              <el-button text type="primary" size="small" data-testid="pickup-row" @click="openPickup(scope.row.id)">
                提货
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-collapse v-if="finishedBatches.length" class="storage-card__finished">
          <el-collapse-item title="已提完批次（不占容量）" :name="`finished-${portId}`">
            <el-table :data="finishedBatches" size="small" border>
              <el-table-column prop="vesselName" label="渔船" min-width="120" />
              <el-table-column label="入库时间" min-width="140">
                <template #default="scope">{{ formatDateTime(scope.row.storedAt) }}</template>
              </el-table-column>
              <el-table-column label="最近提货" min-width="140">
                <template #default="scope">{{ formatDateTime(scope.row.lastPickedAt) }}</template>
              </el-table-column>
              <el-table-column label="入库 kg" width="100">
                <template #default="scope">{{ formatNumber(scope.row.inflowKg, 0) }}</template>
              </el-table-column>
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </template>
    </template>
    <p v-else class="storage-card__empty">该渔港尚未建立冷库台账</p>

    <el-dialog v-model="dialogVisible" title="渔船提货出库" width="480px" data-testid="pickup-dialog">
      <el-form label-width="100px">
        <el-form-item label="入库批次">
          <el-select v-model="pickupForm.batchId" placeholder="选择在库批次" style="width: 100%" data-testid="pickup-batch">
            <el-option
              v-for="b in activeBatches"
              :key="b.id"
              :label="`${b.vesselName} · 剩 ${formatNumber(b.inflowKg - b.pickedKg, 0)} kg`"
              :value="b.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="提货量 kg">
          <el-input-number
            v-model="pickupForm.amountKg"
            :min="0"
            :max="activeRemaining || undefined"
            :step="100"
            style="width: 100%"
            data-testid="pickup-amount"
          />
        </el-form-item>
        <p v-if="activeBatch" class="storage-card__hint">
          {{ activeBatch.vesselName }} 本批入库 {{ formatNumber(activeBatch.inflowKg, 0) }} kg，
          已提 {{ formatNumber(activeBatch.pickedKg, 0) }} kg，剩余 {{ formatNumber(activeRemaining, 0) }} kg。
          提货保存后立即释放等量冷库容量。
        </p>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" data-testid="submit-pickup" @click="submitPickup">
          确认提货
        </el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.storage-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.storage-card__progress {
  margin-bottom: 10px;
}
.storage-card__label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #5b6b7b;
}
.storage-card__stats {
  display: flex;
  gap: 18px;
  font-size: 13px;
  color: #5b6b7b;
  flex-wrap: wrap;
}
.storage-card__stats b {
  color: #17324d;
}
.storage-card__stats b.is-over {
  color: #f56c6c;
}
.storage-card__table {
  margin-top: 12px;
}
.storage-card__finished {
  margin-top: 8px;
}
.storage-card__hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #7b8a99;
}
.storage-card__empty {
  margin: 0;
  font-size: 13px;
  color: #9aa9b6;
}
</style>
