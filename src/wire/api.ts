import { answered, ask } from 'kehikot-module-protocol/client'

import type { Edit, Note } from '../../store.ts'

/**
 * This module's own `/api`, as the page calls it. `ask` carries the write ticket
 * and turns every failure into one sentence: the server stopped, the server said
 * no (in its own words), or this page is older than its server.
 */
export interface Api {
  read(projectPath: string): Promise<Note[]>
  edit(projectPath: string, edit: Edit): Promise<Note[]>
}

export const api: Api = {
  async read(projectPath) {
    return answered(await ask<{ notes?: Note[] }>('./api/notes', { query: { projectPath } })).notes ?? []
  },
  async edit(projectPath, edit) {
    return answered(await ask<{ notes?: Note[] }>('./api/notes', { body: { projectPath, ...edit } })).notes ?? []
  },
}
