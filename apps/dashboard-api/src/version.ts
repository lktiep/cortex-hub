import { readFileSync } from 'node:fs'

// The release CI builds under is passed in as APP_VERSION. version.json is the
// fallback for a local build: in an image it can lag, because CI claims the
// next version after the commit it builds was written.
let version = process.env['APP_VERSION'] || ''
if (!version) {
  try {
    const versionJson = JSON.parse(readFileSync('./version.json', 'utf-8')) as { version?: string }
    version = versionJson.version || '0.0.0-dev'
  } catch {
    version = '0.0.0-dev' // version.json not found
  }
}

export const appVersion = version
