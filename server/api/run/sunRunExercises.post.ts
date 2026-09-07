import { TotoroApiWrapper } from '../../../src/wrappers/TotoroApiWrapper'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<Record<string, unknown>>(event)
    const res = await TotoroApiWrapper.sunRunExercises(body)
    return res
  } catch (e) {
    return { message: (e as Error).message }
  }
})