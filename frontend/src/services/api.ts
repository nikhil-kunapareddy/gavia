/**
 * The one place that knows how to talk to the backend.
 *
 * In development Vite proxies `/api` to the local FastAPI process; in the
 * packaged desktop app the shell serves the frontend and the sidecar on the
 * same origin. Either way a relative URL is correct, so there is no base URL
 * to configure.
 */

export interface ApiErrorBody {
  error?: { code?: string; message?: string; requestId?: string }
}

/** An error the backend described, with the code it gave us. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The token the desktop shell injects so that only it can drive the sidecar.
 * Absent in development, where the backend runs without one.
 */
function authToken(): string | undefined {
  return (globalThis as { __GAVIA_TOKEN__?: string }).__GAVIA_TOKEN__
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = authToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('X-Gavia-Token', token)

  let response: Response
  try {
    response = await fetch(path, { ...init, headers })
  } catch {
    // fetch only rejects when the request never completed — the backend is
    // down or still starting. Worth distinguishing, because the fix is
    // "restart the app", not "try another image".
    throw new ApiError('NETWORK_ERROR', 'Could not reach the detection service.', 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody = {}
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    // A non-JSON error body means something upstream of our handlers failed.
  }

  return new ApiError(
    body.error?.code ?? 'UNKNOWN',
    body.error?.message ?? `Request failed with status ${response.status}.`,
    response.status,
    body.error?.requestId,
  )
}
