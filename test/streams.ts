import type { Api } from '../src/wire/api.ts'

/**
 * The page's two streams, played as the server plays them: each says so once as it opens, and a
 * test sends more with `tell`/`tellOutput`. What is open is in `open`; a stopped one is taken out.
 */
export function streams() {
  const open = { runs: [] as Array<() => void>, output: new Map<string, Array<() => void>>() }
  const take = (list: Array<() => void>, one: () => void) => () => void list.splice(list.indexOf(one), 1)
  const api: Pick<Api, 'changes' | 'outputChanges'> = {
    changes: (onChange) => {
      open.runs.push(onChange)
      onChange()
      return take(open.runs, onChange)
    },
    outputChanges: (id, onChange) => {
      const list = open.output.get(id) ?? []
      open.output.set(id, list)
      list.push(onChange)
      onChange()
      return take(list, onChange)
    },
  }
  return {
    api,
    open,
    tell: () => [...open.runs].forEach((one) => one()),
    tellOutput: (id: string) => [...(open.output.get(id) ?? [])].forEach((one) => one()),
  }
}
