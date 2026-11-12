/**
 * The load limit in one unit everywhere: the load itself (the 1-minute load average), the number the
 * Load chart draws, its dashed line, the footer's meter, the queue's reasons and the setting. Pure, no
 * node modules: the page imports it too.
 */

/** The key of the load limit: an absolute 1-minute load, the number the Load chart draws. */
export const LOAD_KEY = 'load_above'
/** The key of how many run at once: what the Waiting chart is about. */
export const MOST_KEY = 'most'

/** The load above which new runs wait when the person said nothing: three quarters of the cores. */
export const autoLoad = (cores: number) => Math.round(Math.max(1, Math.floor(cores)) * 0.75 * 100) / 100

/** A load as every place shows it: one decimal at most, "9" rather than "9.0". */
export const loadText = (load: number) => String(Math.round(load * 10) / 10)

/** The sentence the load limit's setting, the chart and the footer share: "Pause new runs when the load is above 9 (of 12 cores)". */
export const loadLimitSaid = (above: number, cores: number) => `Pause new runs when the load is above ${loadText(above)} (of ${cores} cores)`

