import type { MethodsUnder } from './context.js'

const refuse = async (): Promise<never> => {
  throw Object.assign(new Error('This method is available only through the client door.'), { wireCode: 'clientDoorOnly' })
}

export const clientMethods = {
  'client/hello': refuse,
  'client/subscribe': refuse,
} satisfies MethodsUnder<'client/'>
