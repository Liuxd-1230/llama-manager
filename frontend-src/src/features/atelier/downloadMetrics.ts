export interface DownloadFileProgress { size?: number | null; bytes_done?: number; speed?: number }
export function downloadMetrics(files: DownloadFileProgress[], running: boolean) {
  const done = files.reduce((sum, file) => sum + Math.max(0, file.bytes_done || 0), 0)
  const known = files.length > 0 && files.every(file => file.size != null && file.size >= 0)
  const total = known ? files.reduce((sum, file) => sum + file.size!, 0) : null
  const speed = running ? files.reduce((sum, file) => sum + Math.max(0, file.speed || 0), 0) : 0
  const remaining = total == null ? null : files.reduce((sum,file)=>sum+Math.max(0,(file.size || 0)-(file.bytes_done || 0)),0)
  return {done,total,speed,percent:total && total>0 ? Math.min(100,done/total*100) : null,eta:remaining != null && speed>0 ? Math.ceil(remaining/speed) : null}
}
export const duration = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.ceil(seconds % 3600 / 60)} 分` : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
