import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import type { BasicReq } from '~/src/wrappers/TotoroApiWrapper'

export interface FreeRunRecord {
  recordId: string
  distance: string
  duration: string
  calorie: string
  avgSpeed: string
  steps?: string
  startTime: string
  endTime: string
  evaluateDate?: string
  status?: string
  mac?: string
  phoneInfo?: string
  routeId?: string
  runType?: string
  usedTime?: string
  [key: string]: unknown
}

const CACHE_DURATION = 5 * 60 * 1000

/**
 * 自由跑记录管理（带 5 分钟内存缓存）
 */
export class RecordManager {
  private cache = new Map<string, FreeRunRecord[]>()
  private cacheExpiry = new Map<string, number>()

  private generateCacheKey(req: unknown, filters?: unknown): string {
    return JSON.stringify({ req, filters })
  }

  private isCacheValid(key: string): boolean {
    const expiry = this.cacheExpiry.get(key)
    return expiry !== undefined && expiry > Date.now()
  }

  async getFreeRunRecords(req: BasicReq, filters?: { startDate?: string; endDate?: string; minDistance?: number; maxDistance?: number; status?: string; limit?: number }) {
    const key = this.generateCacheKey(req, filters)
    if (this.isCacheValid(key)) {
      const cached = this.cache.get(key)
      if (cached) return this.filterRecords(cached, filters)
    }
    try {
      const { data } = await TotoroApiWrapper.getFreeRunRecords(req, {
        startDate: filters?.startDate,
        endDate: filters?.endDate,
        limit: filters?.limit,
      })
      const list = data as FreeRunRecord[]
      this.cache.set(key, list)
      this.cacheExpiry.set(key, Date.now() + CACHE_DURATION)
      return this.filterRecords(list, filters)
    } catch (err) {
      console.error('Failed to fetch free run records:', err)
      throw err
    }
  }

  async getFreeRunDetail(recordId: string, req: BasicReq) {
    try {
      const { data } = await TotoroApiWrapper.getFreeRunDetail(recordId, req)
      return data as FreeRunRecord
    } catch (err) {
      console.error('Failed to fetch free run detail:', err)
      throw err
    }
  }

  filterRecords(list: FreeRunRecord[], filters?: { minDistance?: number; maxDistance?: number; status?: string; startDate?: string; endDate?: string }) {
    if (!filters) return list
    return list.filter((a) => {
      if (a.runType !== '1') return false
      if (filters.minDistance !== undefined && parseFloat(a.distance) < filters.minDistance) return false
      if (filters.maxDistance !== undefined && parseFloat(a.distance) > filters.maxDistance) return false
      if (filters.status && a.status !== filters.status) return false
      if (filters.startDate) {
        if (new Date(a.startTime) < new Date(filters.startDate)) return false
      }
      if (filters.endDate) {
        if (new Date(a.startTime) > new Date(filters.endDate)) return false
      }
      return true
    })
  }

  calculateStats(list: FreeRunRecord[]) {
    const completed = list.filter((r) => r.status === 'completed')
    const totalDistance = completed.reduce((s, r) => s + parseFloat(r.distance), 0)
    const totalTime = completed.reduce((s, r) => s + parseFloat(r.duration), 0)
    const totalCalories = completed.reduce((s, r) => s + parseFloat(r.calorie), 0)
    const avgSpeed = completed.length > 0 ? completed.reduce((s, r) => s + parseFloat(r.avgSpeed), 0) / completed.length : 0
    return {
      totalRuns: list.length,
      totalDistance,
      totalTime,
      avgSpeed,
      totalCalories,
      completedRuns: completed.length,
      failedRuns: list.filter((r) => r.status === 'failed').length,
    }
  }

  clearCache() {
    this.cache.clear()
    this.cacheExpiry.clear()
  }

  exportRecords(list: FreeRunRecord[]): string {
    return JSON.stringify(list, null, 2)
  }

  searchRecords(list: FreeRunRecord[], query: string): FreeRunRecord[] {
    if (!query.trim()) return list
    const q = query.toLowerCase()
    return list.filter((n) => {
      const r = n.recordId.toLowerCase()
      const s = n.startTime?.toLowerCase() || ''
      const e = n.endTime?.toLowerCase() || ''
      return r.includes(q) || s.includes(q) || e.includes(q)
    })
  }
}