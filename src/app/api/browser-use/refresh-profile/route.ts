import { chromium } from 'playwright-core'
import { NextResponse } from 'next/server'

import { client } from '@/lib/api/client'

/**
 * POST /api/browser-use/refresh-profile
 *
 * Creates a raw (no-AI) Browser Use browser session, connects via CDP,
 * sets the auth localStorage payload, then stops the session — saving
 * auth state into BROWSER_USE_PROFILE_ID.
 *
 * Call once after creating the profile, and again when TEST_AUTH_TOKEN expires.
 * No LLM cost; completes in a few seconds.
 */
export async function POST() {
  const profileId = process.env.BROWSER_USE_PROFILE_ID
  if (!profileId) {
    return NextResponse.json({ error: 'BROWSER_USE_PROFILE_ID is not set' }, { status: 400 })
  }

  const tokenId = process.env.TEST_AUTH_TOKEN
  if (!tokenId) {
    return NextResponse.json({ error: 'TEST_AUTH_TOKEN is not set' }, { status: 400 })
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
    // Always open a fresh page so we're not fighting an existing navigation
    const page = await context.newPage()

    // Navigate to site and wait for full load
    await page.goto('https://ai.xeno.in', { waitUntil: 'networkidle', timeout: 30_000 })

    // Set localStorage payload directly — no API call needed
    const lsd = {
      navBarData:
        '[{"slug":"customer_360","enabled":true,"config":{},"children":[{"slug":"persona","enabled":true,"children":[]},{"slug":"offers","enabled":true,"children":[]},{"slug":"orders","enabled":true,"children":[]},{"slug":"loyalty","enabled":true,"children":[]},{"slug":"communication","enabled":true,"children":[]},{"slug":"otp","enabled":true,"children":[]},{"slug":"events","enabled":true,"children":[]},{"slug":"edit","enabled":true,"children":[]}]}]',
      user: JSON.stringify({
        refreshToken: 'e9af3ff6-5425-4c88-bb04-29fba0c481ef',
        tokenId,
        userId: 4032,
        merchantId: 120,
      }),
      merchant: JSON.stringify({ id: 120, name: 'Xeno Dev', currencyCode: 'INR' }),
      userDetails: JSON.stringify({
        id: 4032,
        phone: '9582382346',
        name: 'Xeno Test Suite',
        email: 'xeno-testsuite@xeno.in',
      }),
    }

    // Set localStorage (no reload in evaluate — it throws when page navigates mid-call)
    await page.evaluate((payload) => {
      Object.entries(payload).forEach(([key, value]) => {
        localStorage.setItem(key, value)
      })
    }, lsd)

    // Use Playwright's reload so it properly awaits the navigation
    await page.reload({ waitUntil: 'networkidle', timeout: 30_000 })

    await browser.close()
  } catch (err) {
    await client.PATCH('/browsers/{session_id}', {
      params: { path: { session_id: browserId } },
      body: { action: 'stop' },
    })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }

  // Stop session — Browser Use saves profile state on stop
  await client.PATCH('/browsers/{session_id}', {
    params: { path: { session_id: browserId } },
    body: { action: 'stop' },
  })

  return NextResponse.json({ ok: true, profileId })
}
