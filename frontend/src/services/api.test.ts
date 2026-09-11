import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, request } from './api'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  delete (globalThis as { __GAVIA_TOKEN__?: string }).__GAVIA_TOKEN__
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('request', () => {
  it('parses a JSON body', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }))
    await expect(request('/api/thing')).resolves.toEqual({ ok: true })
  })

  it('passes the method and body through', async () => {
    fetchMock.mockResolvedValue(json({}))
    const body = new FormData()
    await request('/api/thing', { method: 'POST', body })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(body)
  })

  it('returns undefined for a 204 rather than trying to parse it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(request('/api/thing')).resolves.toBeUndefined()
  })
})

describe('the auth token', () => {
  it('is omitted when the shell has not set one', async () => {
    fetchMock.mockResolvedValue(json({}))
    await request('/api/thing')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).has('X-Gavia-Token')).toBe(false)
  })

  it('is sent when the desktop shell injects one', async () => {
    // The packaged app generates a token per launch so that nothing else on
    // the machine can drive the sidecar.
    ;(globalThis as { __GAVIA_TOKEN__?: string }).__GAVIA_TOKEN__ = 'launch-token'
    fetchMock.mockResolvedValue(json({}))

    await request('/api/thing')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).get('X-Gavia-Token')).toBe('launch-token')
  })

  it('does not clobber headers the caller supplied', async () => {
    ;(globalThis as { __GAVIA_TOKEN__?: string }).__GAVIA_TOKEN__ = 'launch-token'
    fetchMock.mockResolvedValue(json({}))

    await request('/api/thing', { headers: { 'X-Request-Id': 'abc' } })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('X-Request-Id')).toBe('abc')
    expect(headers.get('X-Gavia-Token')).toBe('launch-token')
  })
})

describe('error handling', () => {
  it('turns the backend envelope into a typed error', async () => {
    fetchMock.mockResolvedValue(
      json(
        { error: { code: 'IMAGE_TOO_LARGE', message: 'Too big.', requestId: 'req-1' } },
        413,
      ),
    )

    const error = await request('/api/detect').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'IMAGE_TOO_LARGE',
      message: 'Too big.',
      status: 413,
      requestId: 'req-1',
    })
  })

  it('distinguishes an unreachable backend from a rejected request', async () => {
    // "the app is still starting" needs a different fix from "that image is
    // no good", so they must not collapse into one message.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(request('/api/thing')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    })
  })

  it('copes with an error body that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))

    await expect(request('/api/thing')).rejects.toMatchObject({
      code: 'UNKNOWN',
      status: 502,
    })
  })

  it('copes with an error body missing the envelope', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'something else' }, 400))
    await expect(request('/api/thing')).rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('is an Error, so it survives normal error handling', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'X', message: 'y' } }, 500))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('ApiError')
  })
})
