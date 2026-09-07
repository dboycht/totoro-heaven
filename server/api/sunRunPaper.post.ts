import { TotoroApiWrapper } from '../../src/wrappers/TotoroApiWrapper'

/**
 * 获取阳光跑「试卷」（跑步任务）。
 * ifHasRun === "0" 说明还没跑过可继续；否则返回“你已经跑过了”。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)
  try {
    const paper = await TotoroApiWrapper.getSunRunPaper(body)
    if (paper.ifHasRun === '0') {
      return { message: '登录成功', paper }
    } else {
      return { message: '你已经跑过了', paper: null }
    }
  } catch (error) {
    console.log(error)
    return { message: '龙猫服务器错误', paper: null }
  }
})