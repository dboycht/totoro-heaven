import { TotoroApiWrapper } from '../../../src/wrappers/TotoroApiWrapper'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const res = await TotoroApiWrapper.sunRunExercisesDetail(body)
    return res
  } catch (e) {
    return { message: (e as Error).message }
  }
})