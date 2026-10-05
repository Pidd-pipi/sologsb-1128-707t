/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 进出港记录 */
export interface PortCall {
  id: string;
  /**
   * 所属渔港 id。
   * 旧流水没有港口归属时为 null（或缺失），统一列为「待盘点」，不自动占用冷库。
   */
  portId: string | null;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余，便于流水展示） */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /** 泊位号 */
  berthNo: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg（进港时对应冷库入库批次，出港不清冷库） */
  unloadKg: number;
  /** 进港卸货生成的冷库批次 id；旧流水 / 待盘点流水为 null */
  batchId: string | null;
  /** 签证状态 */
  visaStatus: VisaStatus;
  createdAt: string;
}

/** 进出港登记表单模型 */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  time: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
}

export function emptyCallDraft(berthNo = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: '',
    berthNo,
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
  };
}
