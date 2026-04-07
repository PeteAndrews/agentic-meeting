import { API_BASE_URL } from '../config/api'

export class ApiError extends Error {
  status: number
  bodyText?: string

  constructor(message: string, status: number, bodyText?: string) {
    super(message)
    this.status = status
    this.bodyText = bodyText
  }
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function resolveApiUrl(path: string): string {
  if (!API_BASE_URL) return path
  if (isAbsoluteUrl(path)) return path

  if (path.startsWith('/')) return `${API_BASE_URL}${path}`
  return `${API_BASE_URL}/${path}`
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  if (API_BASE_URL) headers.set('ngrok-skip-browser-warning', 'true')

  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers,
  })

  if (!res.ok) {
    const bodyText = await res.text().catch(() => undefined)
    throw new ApiError(`Request failed: ${res.status}`, res.status, bodyText)
  }

  return (await res.json()) as T
}

