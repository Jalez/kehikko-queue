import { CLI_TOKEN, ASK, queue } from '../doors.ts'
import { cliDoor } from './cli-door.ts'

/** The CLI's door and the fence in front of `/mcp`, as mounted on both servers (`vite.config.ts`, `serve.ts`). */
export const QUEUE_DOOR = cliDoor({ queue, token: CLI_TOKEN, ask: () => ASK.options })
