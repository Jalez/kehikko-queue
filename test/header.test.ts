import { describe, expect, test } from 'bun:test'

import { SCOPE_IS_THE_PERSONS, headerItems, pressed, showingOf } from '../src/header.ts'
import { MANIFEST } from '../doors.ts'

/*
 * Which runs show is the container's scope (protocol 2.29.0), not a switch of
 * its own: This computer (the default) is every project's runs, Project the
 * open project's. The person picks it in the host; the header declares nothing.
 */
describe('the scope, and the header', () => {
  test('two scopes, This computer first, each saying what it shows', () => {
    expect(MANIFEST.modes.map((mode) => mode.scope)).toEqual(['machine', 'project'])
    for (const mode of MANIFEST.modes) expect((mode.scopeSays ?? '').length).toBeGreaterThan(0)
  })

  test('the runs shown follow the scope: every project’s, or the open project’s', () => {
    expect(showingOf('machine', '/p')).toBe('all')
    expect(showingOf(undefined, '/p')).toBe('all')
    expect(showingOf('project', '/p')).toBe('here')
    /* At Project with no project open there is nothing to narrow to. */
    expect(showingOf('project', null)).toBe('all')
  })

  test('the header declares nothing: the old switch was the scope', () => {
    expect(headerItems()).toEqual([])
  })

  test('a press of the old switch says the scope is the person’s; anything else is not there', () => {
    expect(pressed('show', 'all')).toBe(SCOPE_IS_THE_PERSONS)
    expect(pressed('other', 'all')).toContain('nothing called')
  })
})
