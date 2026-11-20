import type { Before } from 'kehikot-module-protocol/serve'

import { CLI_TOKEN, ASK, leases, mcp, queue } from '../doors.ts'
import { cliDoor } from './cli-door.ts'
import { holdDoor } from './hold-door.ts'

const CLI = cliDoor({ queue, leases, token: CLI_TOKEN, ask: () => ASK.options, mcp: (rpc, query, tick) => mcp(rpc, query, queue(), tick) })
const HOLD = holdDoor({ queue })

/**
 * The CLI's door and the fence in front of `/mcp`, and the host's hold for an app restart (protocol
 * 2.110.0), as mounted on both servers (`vite.config.ts`, `serve.ts`).
 */
export const QUEUE_DOOR: Before = async (request, context) => (await HOLD(request, context)) ?? CLI(request, context)
