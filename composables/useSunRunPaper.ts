export interface RunPoint {
  pointId: string
  pointName: string
  taskId?: string
  pointList?: { longitude: string; latitude: string }[]
}

export interface SunRunPaper {
  mileage?: number
  minTime?: number
  maxTime?: number
  scantronId?: string
  ifHasRun?: string
  runPointList?: RunPoint[]
}

/**
 * 阳光跑试卷（任务）全局状态，scanned 页写入、run 页面读取
 */
export const useSunRunPaper = () => useState<SunRunPaper | null>('sunRunPaper', () => null)