import type { Role } from '../store/sessionSlice'

/** HA User A (delegating attendee) uses the Agent Console, not Jitsi. */
export function destinationForRole(role: Role): '/meeting' | '/agent-console' {
  if (role === 'proxy') {
    return '/agent-console'
  }
  return '/meeting'
}

export function isProxyRole(role: Role): boolean {
  return role === 'proxy'
}
