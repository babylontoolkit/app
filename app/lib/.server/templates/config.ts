/**
 * Template pinning configuration (SPEC §4.4).
 *
 * Pinning is ON by default — that IS the §4.4 target: new projects mount a reviewed snapshot, not
 * whatever `main` says this second. The flag exists for the one workflow the pin genuinely obstructs:
 * developing the AppTemplate starter itself, where you want every push to reach the next new project
 * without promoting first.
 *
 * A rate/flag is config, never a hardcoded constant (CLAUDE.md conventions).
 */
import { env } from '~/lib/.server/env';

export function isTemplatePinningEnabled(context?: unknown): boolean {
  const value = env(context, 'TEMPLATE_PINNING_ENABLED');

  // Unset = on. Only an explicit, deliberate "false"/"0"/"off" opts out.
  return !/^(false|0|off|no)$/i.test((value ?? '').trim());
}
