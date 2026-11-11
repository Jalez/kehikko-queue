import { useEffect, useMemo } from 'react'

import { pickedParts } from 'kehikot-module-protocol'
import { useHost, type Host as ProtocolHost } from 'kehikot-module-protocol/client/react'
import type { HostEvents } from 'kehikot-module-protocol/client'

import { hideTip } from '@/lib/one-tip'
import { ID } from '../../manifest.ts'

/**
 * What the screen needs from the host: the protocol's `useHost` — which has
 * already put the theme on <html> and flattened the context — and the parts
 * picked, by name. A plain object, so a screen renders in a test without a host.
 */
export interface Host
  extends Pick<ProtocolHost, 'where' | 'project' | 'projectPath' | 'projectId' | 'epic' | 'parts' | 'theme' | 'header' | 'activity' | 'request'>,
    Partial<Pick<ProtocolHost, 'workingScope' | 'visible' | 'footer' | 'drawsFooter' | 'ready'>> {
  /** The names of the parts of the epic picked in the host's bar. Empty is the whole epic. */
  picked: string[]
}

export function useKehikot(events: HostEvents = {}): Host {
  const host = useHost(ID, events)
  /* Off screen (`kehikot.visible` false): no chart tooltip is left standing for when it comes back. */
  useEffect(() => {
    if (!host.visible) hideTip()
  }, [host.visible])
  const picked = useMemo(() => pickedParts(host.parts).map((part) => part.heading || part.id), [host.parts])
  return useMemo(() => ({ ...host, picked }), [host, picked])
}
