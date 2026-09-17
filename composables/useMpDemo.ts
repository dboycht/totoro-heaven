/**
 * 【跑步机 + 演示数据注入】小程序线三页流程的共享状态与跑步模拟
 *
 * ⚠️ 这个 composable 名字叫 Demo，但**它同时是真实链路的跑步引擎**：
 *    `useMpReal` 通过 `setTask` / `setLines` 把**真实任务与真实线路**注入进来，
 *    计时、轨迹生成（`generateCorridorRoute`）、拟合度、结算自检都由本文件提供。
 *
 * **1.1.3 起演示改为「按需功能」**：
 *   - 默认 `demoMode=false`、`task=null`、`lines=[]`、`records=[]` —— **默认界面没有任何假数据**；
 *   - 只有显式调用 `enableDemo()` 才载入 `src/mp/demo.ts` 的假任务/假线路/假开关（用于试界面与报文）；
 *   - 真实链路进入时请调用 `disableDemo()`。
 *
 * 跑步过程是**真实计算**的：轨迹由 `generateCorridorRoute` 生成、拟合度由
 * `calculateRouteSimilarity` 计算、里程/配速/自洽校验由 `buildRunStats` 产出 —— 只是
 * 位置推进用「模拟倍速」代替真实 GPS，因此可以在几十秒内跑完 3km。
 * 真实提交（`sunRunExercises` 等）在 `composables/useMpReal.ts`，本文件的 `finish()` 只生成本地报文预览。
 * （本次结构整理后 `finish()` 已搬到 `demo/runner.ts`，语义不变。）
 */
import { useDemoRecords } from './demo/records'
import { useDemoRunner } from './demo/runner'
import { useDemoState } from './demo/state'

// 文件级导出保持不变：原先直接在本文件声明的常量/类型现在住在 `demo/state.ts`，这里再导出 ——
// 调用方（含 `pages/run.vue` 的显式 import）继续能 `from '~/composables/useMpDemo'` 取到它们。
export { DEMO_STEP_M, REAL_STEP_M } from './demo/state'
export type { DemoRunResult, DemoRunState, RunStatus } from './demo/state'

/**
 * ⚠️ 本次结构整理：本文件是**组装器**，只做两件事：
 *   ① 调用 `demo/state.ts`（共享状态 + 演示模式装配）、`demo/records.ts`（成绩记录）、
 *      `demo/runner.ts`（跑步机：计时/轨迹/拟合度/结算）；
 *   ② 把三者的返回值**逐字段合并**后返回 —— **对外键集合、顺序与语义逐字不变**，页面无需改动。
 * 共享状态由 `demo/state.ts` 统一声明（Nuxt 的 `useState('mpDemoXxx')` 是**跨文件同一个引用**，
 * 所以拆分不需要单例/工厂）。依赖方向：本文件 → {`demo/state`, `demo/records`, `demo/runner`}
 * → `demo/state.ts`（单向）；`demo/runner.ts` 可依赖 `demo/records.ts`（`finish()` 要写记录），反之不行。
 */
export function useMpDemo() {
  /**
   * ⚠️ 这两个动作是注入给 `demo/state.ts` 的 `clearLocalData`（清记录）与 `logout`（停计时器）用的：
   *    它们分别属于下面两行构造出来的 records / runner，而那两个 composable 反过来要读 state 的 ref
   *    （`records` 要 `demoMode`、`runner` 要 `task`/`lines`/`run`）—— 若由 state 直接 import 就会成环。
   *    这里传的是**闭包**：只在用户真正点「清空本机数据 / 退出登录」时才求值，
   *    那时 `records` / `runner` 早已构造完毕（不会踩到"暂时性死区"）。
   */
  const state = useDemoState({
    resetRecords: () => records.resetRecords(),
    stopRunTimer: () => runner.stopTimer(),
  })
  const records = useDemoRecords(state.demoMode)
  const runner = useDemoRunner(state, records)

  return {
    // 状态
    session: state.session,
    isLoggedIn: state.isLoggedIn,
    demoMode: state.demoMode,
    task: state.task,
    lines: state.lines,
    switches: state.switches,
    run: state.run,
    records: records.records,
    term: records.term,
    stats: records.stats,
    progress: runner.progress,
    paceText: runner.paceText,
    // 动作
    logout: state.logout,
    enableDemo: state.enableDemo,
    disableDemo: state.disableDemo,
    clearLocalData: state.clearLocalData,
    setTask: state.setTask,
    setLines: state.setLines,
    start: runner.start,
    pause: runner.pause,
    resume: runner.resume,
    finish: runner.finish,
    reset: runner.reset,
    resetRecords: records.resetRecords,
    stopTimer: runner.stopTimer,
    refreshFitDegree: runner.refreshFitDegree,
  }
}
