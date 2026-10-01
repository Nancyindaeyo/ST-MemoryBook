/**
 * 可复制的安全诊断。只留阶段、HTTP、开关和短原因。
 * 正文、密钥、接口地址一律不进剪贴板。
 */
import { ApiError } from '@/api/client';
import { reactive } from 'vue';

export type DiagnosticStage = '摘要' | '总结' | '召回' | '补结构化';

export const diagnosticState = reactive({
  stage: '' as DiagnosticStage | '',
  httpStatus: null as number | null,
  stream: null as boolean | null,
  prefill: null as boolean | null,
  retries: 0,
  dropped: [] as string[],
  message: '',
});

export function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[地址]')
    .replace(/bearer\s+\S+/gi, 'Bearer [密钥]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[密钥]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function statusOf(error: unknown): number | null {
  if (error instanceof ApiError && typeof error.status === 'number') return error.status;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(/\((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

export function noteFailure(input: {
  stage: DiagnosticStage;
  error: unknown;
  retries: number;
  stream: boolean | null;
  prefill: boolean | null;
}): void {
  const raw = input.error instanceof Error ? input.error.message : String(input.error ?? '');
  diagnosticState.stage = input.stage;
  diagnosticState.httpStatus = statusOf(input.error);
  diagnosticState.stream = input.stream;
  diagnosticState.prefill = input.prefill;
  diagnosticState.retries = Math.max(0, input.retries | 0);
  diagnosticState.message = sanitizeDiagnosticMessage(raw);
}

/** 最近一次摘要实际丢掉的字段类。空数组表示这次没有丢掉。 */
export function noteDrops(dropped: string[]): void {
  diagnosticState.dropped = dropped.slice(0, 12);
}

function flag(value: boolean | null): string {
  if (value === null) return '未知';
  return value ? '开' : '关';
}

export function formatDiagnostic(): string {
  const lines = [
    '柏宝书诊断',
    `阶段: ${diagnosticState.stage || '无'}`,
    `HTTP: ${diagnosticState.httpStatus ?? '无'}`,
    `流式: ${flag(diagnosticState.stream)}`,
    `预填充: ${flag(diagnosticState.prefill)}`,
    `重试: ${diagnosticState.retries}`,
    `丢掉: ${diagnosticState.dropped.length ? diagnosticState.dropped.join('、') : '无'}`,
    `原因: ${diagnosticState.message || '无'}`,
  ];
  return lines.join('\n');
}

export async function copyDiagnostic(): Promise<boolean> {
  const text = formatDiagnostic();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 下面用临时文本框再试一次 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
