import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skillPath, skillTextIssue } from 'kehikot-module-protocol'

import { ASK, MANIFEST, TICKET, answer, saidNotes, servingAt } from '../doors.ts'
import { ID } from '../manifest.ts'
import type { Note } from '../store.ts'

const project = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-example-doors-')))
afterAll(() => rmSync(project, { recursive: true, force: true }))

/* A host that holds exactly one project, and no conversation with a place: the door asks it, never a real one. */
ASK.options = {
  env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:1' },
  fetch: (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname === '/host/is-project') {
      const path = url.searchParams.get('path')
      return Response.json(path === project ? { ok: true, project: true, path } : { ok: true, project: false })
    }
    return Response.json({ ok: true, place: null })
  }) as typeof fetch,
}

const none = new URLSearchParams()

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method, params }, null)
  return reply?.body as { result: { tools?: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { properties: object } }[]; content?: { text: string }[]; isError?: boolean } }
}

describe('the doors', () => {
  test('the health check says which module this is', async () => {
    const reply = await answer('GET', '/healthz', none, null, null)
    expect((reply?.body as { id: string }).id).toBe(ID)
  })

  test('a path that is not ours is left to Vite, and an unknown /api path is refused', async () => {
    expect(await answer('GET', '/src/main.tsx', none, null, null)).toBeNull()
    expect((await answer('GET', '/api/nothing', none, null, null))?.status).toBe(404)
  })

  test('only this page writes: without its ticket a write is refused, with it the note is kept', async () => {
    const body = { projectPath: project, op: 'add', text: 'Ask about the deadline', epic: 'launch', parts: ['design'] }
    expect((await answer('POST', '/api/notes', none, body, null))?.status).toBe(403)
    expect((await answer('POST', '/api/notes', none, body, 'not-the-ticket'))?.status).toBe(403)
    expect((await answer('POST', '/api/notes', none, body, TICKET))?.status).toBe(200)
    const read = await answer('GET', '/api/notes', new URLSearchParams({ projectPath: project }), null, null)
    expect((read?.body as { notes: Note[] }).notes.map((note) => note.text)).toEqual(['Ask about the deadline'])
  })

  test('a malformed edit is refused with a sentence', async () => {
    const reply = await answer('POST', '/api/notes', none, { projectPath: project, op: 'rename' }, TICKET)
    expect(reply?.status).toBe(400)
  })

  test('the MCP door lists one read-only tool that takes project and epic', async () => {
    expect((await answer('GET', '/mcp', none, null, null))?.status).toBe(405)
    const tools = (await rpc('tools/list')).result.tools!
    expect(tools.map((one) => one.name)).toEqual(['list_notes'])
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)
    expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(['project', 'epic'])
  })

  test('list_notes answers for a project the host holds, and refuses one it does not', async () => {
    const said = await rpc('tools/call', { name: 'list_notes', arguments: { project, epic: 'launch' } })
    expect(said.result.isError).toBeUndefined()
    expect(said.result.content?.[0]?.text).toContain('Ask about the deadline')
    const refused = await rpc('tools/call', { name: 'list_notes', arguments: { project: '/not/a/project' } })
    expect(refused.result.isError).toBe(true)
    const unnamed = await rpc('tools/call', { name: 'list_notes', arguments: {} })
    expect(unnamed.result.isError).toBe(true)
  })

  test('each skill is served at its path, with the origin filled in and a text a host accepts', async () => {
    /* Said once the server listens: the manifest's versions follow the origin really bound. */
    servingAt('http://127.0.0.1:9520')
    for (const skill of MANIFEST.declares.skills ?? []) {
      const reply = await answer('GET', skillPath(skill.name), none, null, null)
      const text = reply?.raw?.bytes as string
      expect(skillTextIssue(text, skill.name)).toBeNull()
      expect(text).not.toContain('{{origin}}')
      expect(text).toContain('http://127.0.0.1:9520')
      expect(text).toContain(`[skill ${skill.version}]`)
    }
  })

  test('the answer says each note as text, with its state and parts', () => {
    const note: Note = { id: '1', text: 'Check <b>this</b>', epic: 'e', parts: ['p'], done: false, at: '2026-01-01T00:00:00Z' }
    expect(saidNotes([note], 'e', [])).toBe('- [open] "Check <b>this</b>" (parts: p) — epic e')
    expect(saidNotes([note], 'other', [])).toBe('No notes are kept for the epic other.')
  })
})
