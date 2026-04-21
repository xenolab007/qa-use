import createClient from 'openapi-fetch'

import type { paths } from '@/lib/api/v3'

export type Client = ReturnType<typeof createClient<paths>>

export const client = createClient<paths>({
  baseUrl: 'https://api.browser-use.com/api/v3/',
  headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY ?? '' },
})
