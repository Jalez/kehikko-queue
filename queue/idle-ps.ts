import { execFile } from 'node:child_process'

import { treeOf, type Sampler } from './idle.ts'

/** The real one: one `ps` for every run. */
export const psSampler: Sampler = (roots) =>
  new Promise((done) => {
    if (!roots.length) return done(new Map())
    execFile('ps', ['-axo', 'pid=,ppid=,pgid=,cputime='], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, out) => {
      if (error) return done(null)
      done(new Map(roots.map((root) => [root, treeOf(out, root)])))
    })
  })
