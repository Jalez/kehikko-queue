import { settingsDeclarationSchema, type SettingField } from 'kehikot-module-protocol'

/**
 * How much may run at once, as the person sets it in Kehikot's Settings › Modules (protocol 2.15.0).
 * Kept on this machine (`scope: 'machine'`): it is about this computer's cores, not a project. Only
 * the person changes it (`personOnly`), because it decides when commands run.
 */
export const SETTINGS: SettingField[] = settingsDeclarationSchema.parse([
  {
    key: 'most',
    label: 'Runs at once',
    description: 'How many test runs may run at the same time. 0 lets Test runs decide: one for every six cores.',
    type: 'number',
    default: 0,
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'load',
    label: 'Busy above (load per core)',
    description: 'No new run starts while the machine\'s 1-minute load is above this many per core. 0.75 on 12 cores is 9.',
    type: 'number',
    default: 0.75,
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'wait',
    label: 'Start anyway after (minutes)',
    description: 'A run that has waited this long for the load to fall starts when a slot is free, so nothing waits forever.',
    type: 'number',
    default: 10,
    scope: 'machine',
    personOnly: true,
  },
])

