import { api } from '../../api';
import type { components } from '../../generated/api';

export type Asset = Omit<components['schemas']['AssetRecord'], 'data'> & { data: Record<string, any> }
export type Job = Omit<components['schemas']['JobRecord'], 'data' | 'result'> & { data: Record<string, any>; result: Record<string, any> }
export type Toast = (message: string) => void
export const request = <T,>(url: string, body?: unknown, method = 'POST') => api<T>(`/api/v1${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }, 300000)
export const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
export const jobNames: Record<string, string> = { queued: '排队中', running: '进行中', paused: '已暂停', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消' }
export const bytes = (n?: number | null) => n === undefined || n === null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
