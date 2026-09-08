/** 调试模式：本地模拟会话与试卷（提交会被禁用，仅用于查看界面后续流程） */

const debugRouteCoords = [
  [116.3974, 39.9093],
  [116.4001, 39.9108],
  [116.4034, 39.9102],
  [116.4051, 39.9087],
  [116.4039, 39.9064],
  [116.4008, 39.9069],
  [116.3976, 39.9081],
]

export const createDebugSession = () => ({
  token: 'debug-token',
  code: 'debug-code',
  isDebug: true,
  stuNumber: '2026DEBUG01',
  stuName: '调试同学',
  schoolId: 'debug-school',
  schoolName: '示例大学',
  campusId: 'debug-campus',
  campusName: '示例校区',
  collegeName: '计算机学院',
  phoneNumber: '13800000000',
  data: null,
})

export const createDebugPaper = () => ({
  mileage: 3.2,
  minTime: 10,
  maxTime: 20,
  scantronId: 'debug-scantron',
  ifHasRun: '0',
  runPointList: [
    {
      pointId: 'debug-route-1',
      pointName: '调试路线·校园环路',
      taskId: 'debug-task-1',
      pointList: debugRouteCoords.map(([longitude, latitude]) => ({
        longitude: String(longitude),
        latitude: String(latitude),
      })),
    },
    {
      pointId: 'debug-route-2',
      pointName: '调试路线·操场',
      taskId: 'debug-task-2',
      pointList: [
        [116.4001, 39.9108],
        [116.4034, 39.9102],
        [116.4039, 39.9064],
        [116.4008, 39.9069],
        [116.3981, 39.9077],
      ].map(([longitude, latitude]) => ({ longitude: String(longitude), latitude: String(latitude) })),
    },
  ],
})