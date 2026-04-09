#!/usr/bin/env node
// Run once to get your Gmail refresh token.
// Usage: node scripts/gmail-auth.mjs
//
// Prerequisites:
// 1. Go to https://console.cloud.google.com
// 2. Create a project (or use an existing one)
// 3. Enable the Gmail API
// 4. Create OAuth credentials: APIs & Services → Credentials → Create → OAuth client ID → Desktop app
// 5. Copy the Client ID and Client Secret into .env.local as GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET
// 6. Run this script — it will print a URL, open it, authorise, paste the code back
// 7. Copy the refresh_token printed at the end into .env.local as GMAIL_REFRESH_TOKEN

import { createInterface } from 'readline'
import { google } from 'googleapis'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load env vars from .env.local manually (dotenv not needed for a one-time script)
const envPath = resolve(process.cwd(), '.env.local')
const envVars = {}
try {
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const [key, ...rest] = line.split('=')
    if (key && rest.length) envVars[key.trim()] = rest.join('=').trim()
  }
} catch {
  console.error('Could not read .env.local — make sure you run this from the pantani/ directory')
  process.exit(1)
}

const clientId = envVars.GMAIL_CLIENT_ID
const clientSecret = envVars.GMAIL_CLIENT_SECRET

if (!clientId || clientId.includes('your-')) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env.local first, then re-run.')
  process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  'urn:ietf:wg:oauth:2.0:oob'  // Desktop app redirect
)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
  prompt: 'consent',  // Forces refresh_token to be returned
})

console.log('\n1. Open this URL in your browser:\n')
console.log(authUrl)
console.log('\n2. Authorise the app, then paste the code below:\n')

const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.question('Code: ', async (code) => {
  rl.close()
  try {
    const { tokens } = await oauth2Client.getToken(code.trim())
    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token returned. Try revoking access at https://myaccount.google.com/permissions and re-running.')
      process.exit(1)
    }
    console.log('\n✓ Add this to your .env.local:\n')
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log('\nThen restart the dev server.')
  } catch (err) {
    console.error('Failed to exchange code:', err.message)
    process.exit(1)
  }
})
