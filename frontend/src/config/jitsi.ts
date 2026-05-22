const DEFAULT_JITSI_DOMAIN = 'meet.uib-study.com'

function normalizeJitsiDomain(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_JITSI_DOMAIN
  const trimmed = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
  return trimmed || DEFAULT_JITSI_DOMAIN
}

/** Self-hosted Jitsi domain (no protocol). Override with VITE_JITSI_DOMAIN. */
export const JITSI_DOMAIN = normalizeJitsiDomain(import.meta.env.VITE_JITSI_DOMAIN)

export function jitsiExternalApiScriptUrl(domain: string = JITSI_DOMAIN): string {
  return `https://${domain}/external_api.js`
}
