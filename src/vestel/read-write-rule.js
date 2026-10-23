/**
 * The registers this integration is allowed to WRITE, and the ones it only reads.
 *
 * THE RULE, IN ONE PLACE
 * Exactly two registers are written, and both are charging control rather than
 * configuration:
 *
 *   CONTROL.charging_current   the setpoint, clamped to what the device and the
 *                              cable allow
 *   FAILSAFE.alive             the heartbeat, without which a setpoint does not
 *                              survive
 *
 * Everything else is READ — the limits, the whole failsafe block, the whole
 * meter. The question this answers is a plain one: what happens when someone who
 * does not know this device presses something in Gladys? They can change how
 * much current flows, which is the feature. They cannot reconfigure the wallbox.
 */
export const WRITABLE = ['charging_current', 'alive'];

/**
 * The smallest and largest charging current this integration will fall back on
 * when the device does not answer its own limit registers.
 *
 * THE CEILING IS NOT A GUESS ABOUT YOUR WALLBOX
 * It is the smallest figure that makes sense for a home charge point. A ceiling
 * that is too high is not refused by the device — the wallbox simply charges at
 * its own maximum while Gladys reports the number it was asked for, and the user
 * reads something that is not true. So the fallback stays low on purpose, and the
 * real figure is normally read from `1104` and `1106`.
 */
export const DEFAULT_MIN_CURRENT = 6;
export const DEFAULT_MAX_CURRENT = 16;
