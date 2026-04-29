import { chromium } from 'playwright-core'
import { NextResponse } from 'next/server'

import { client } from '@/lib/api/client'

/**
 * POST /api/browser-use/refresh-profile
 *
 * Seeds BROWSER_USE_PROFILE_ID with auth state by opening a raw browser via CDP
 * and writing localStorage directly — no AI cost, completes in seconds.
 *
 * Body (optional JSON): pass your full localStorage snapshot to override defaults.
 * The tokenId inside `user` is always replaced with TEST_AUTH_TOKEN so it's fresh.
 *
 * Example body:
 * {
 *   "user": "{\"refreshToken\":\"...\",\"tokenId\":\"ignored\",\"userId\":4032,...}",
 *   "merchant": "{\"id\":120,\"name\":\"Xeno Dev\",...}",
 *   "navBarData": "[...]",
 *   "userDetails": "{...}"
 * }
 */
export async function POST(request: Request) {
  const profileId = process.env.BROWSER_USE_PROFILE_ID
  if (!profileId) {
    return NextResponse.json({ error: 'BROWSER_USE_PROFILE_ID is not set' }, { status: 400 })
  }

  const tokenId = process.env.TEST_AUTH_TOKEN
  if (!tokenId) {
    return NextResponse.json({ error: 'TEST_AUTH_TOKEN is not set' }, { status: 400 })
  }

  const refreshToken = process.env.TEST_REFRESH_TOKEN
  if (!refreshToken) {
    return NextResponse.json({ error: 'TEST_REFRESH_TOKEN is not set' }, { status: 400 })
  }

  // Accept a full localStorage snapshot from the request body
  let bodySnapshot: Record<string, string> = {}
  try {
    const text = await request.text()
    if (text) bodySnapshot = JSON.parse(text) as Record<string, string>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Merge: body snapshot wins, but always inject fresh tokenId + refreshToken into user
  const userBase = bodySnapshot.user
    ? (JSON.parse(bodySnapshot.user) as Record<string, unknown>)
    : { userId: 4032, merchantId: 120 }

  const lsd: Record<string, string> = {
    // Defaults for required keys (overridden by body if provided)
    navBarData:
      '[{"slug":"customer_360","enabled":true,"config":{},"children":[{"slug":"persona","enabled":true,"children":[]},{"slug":"offers","enabled":true,"children":[]},{"slug":"orders","enabled":true,"children":[]},{"slug":"loyalty","enabled":true,"children":[]},{"slug":"communication","enabled":true,"children":[]},{"slug":"otp","enabled":true,"children":[]},{"slug":"events","enabled":true,"children":[]},{"slug":"edit","enabled":true,"children":[]}]}]',
    merchant: JSON.stringify({ id: 120, name: 'Xeno Dev', currencyCode: 'INR' }),
    userDetails: JSON.stringify({
      id: 4032,
      phone: '9582382346',
      name: 'Xeno Test Suite',
      email: 'xeno-testsuite@xeno.in',
    }),
    // Spread the full body snapshot on top of defaults
    ...bodySnapshot,
    // Always override user with fresh tokens
    user: JSON.stringify({ ...userBase, tokenId, refreshToken }),
  }

  // Create a raw browser session (no AI) with the profile attached
  const createRes = await client.POST('/browsers', {
    body: {
      profileId,
      proxyCountryCode: null,
      timeout: 10,
      allowResizing: false,
      enableRecording: false,
    },
  })

  if (!createRes.data) {
    return NextResponse.json({ error: JSON.stringify(createRes.error) }, { status: 500 })
  }

  const { id: browserId } = createRes.data

  // Poll until cdpUrl is available
  let cdpUrl: string | null = null
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2_000))
    const pollRes = await client.GET('/browsers/{session_id}', {
      params: { path: { session_id: browserId } },
    })
    if (pollRes.data?.cdpUrl) {
      cdpUrl = pollRes.data.cdpUrl
      break
    }
  }

  if (!cdpUrl) {
    return NextResponse.json({ error: 'Browser did not become ready in time' }, { status: 500 })
  }

  try {
    const browser = await chromium.connectOverCDP(cdpUrl)
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = await context.newPage()

    await page.goto('https://ai.xeno.in', { waitUntil: 'networkidle', timeout: 30_000 })

    await page.evaluate((payload) => {
      Object.entries(payload).forEach(([key, value]) => {
        localStorage.setItem(key, value)
      })
    }, lsd)

    await page.reload({ waitUntil: 'networkidle', timeout: 30_000 })

    // Wait until the app has fully initialized (not stuck on login/otp page).
    // Once past login, the app fetches full user/merchant data and writes it to
    // localStorage — the profile saves that complete state.
    await page.waitForFunction(
      () => !window.location.pathname.includes('/login') && !window.location.pathname.includes('/otp'),
      { timeout: 30_000 },
    )
    // Extra pause so async data fetching finishes writing to localStorage
    await new Promise((r) => setTimeout(r, 5_000))

    await browser.close()
  } catch (err) {
    await client.PATCH('/browsers/{session_id}', {
      params: { path: { session_id: browserId } },
      body: { action: 'stop' },
    })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }

  await client.PATCH('/browsers/{session_id}', {
    params: { path: { session_id: browserId } },
    body: { action: 'stop' },
  })

  return NextResponse.json({ ok: true, profileId })
}
