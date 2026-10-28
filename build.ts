#!/usr/bin/env bun
import { buildModule } from 'kehikot-module-protocol/build'

/**
 * The page, compiled ahead of time for `serve.ts`, and stamped with the commit (`dist/.kehikot-built`).
 * An edited checkout's build is not stamped, and `run.sh` keeps Vite for it.
 */
const built = await buildModule({ dir: import.meta.dirname, page: { title: 'Test runs' } })
if (!built.stamped) process.exitCode = 2
