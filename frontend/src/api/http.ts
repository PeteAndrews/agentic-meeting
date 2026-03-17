export class ApiError extends Error {
  status: number
  bodyText?: string

  constructor(message: string, status: number, bodyText?: string) {
    super(message)
    this.status = status
    this.bodyText = bodyText
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!res.ok) {
    const bodyText = await res.text().catch(() => undefined)
    throw new ApiError(`Request failed: ${res.status}`, res.status, bodyText)
  }

  return (await res.json()) as T
}

