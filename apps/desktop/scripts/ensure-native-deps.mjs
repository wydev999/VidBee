#!/usr/bin/env node

import { execSync } from 'node:child_process'
import path from 'node:path'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const checkScriptPath = path.join(import.meta.dirname, 'better-sqlite3-check.cjs')

function canLoadBetterSqlite3WithElectron() {
  try {
    execSync(`pnpm exec electron "${checkScriptPath}"`, {
      cwd: desktopRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'pipe'
    })
    return true
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message || 'No output'
    console.warn(`[native-deps] better-sqlite3 check failed: ${details}`)
    return false
  }
}

if (canLoadBetterSqlite3WithElectron()) {
  console.log('[native-deps] better-sqlite3 is ready for Electron')
  process.exit(0)
}

console.log('[native-deps] Rebuilding Electron native dependencies...')
execSync('pnpm exec electron-builder install-app-deps', {
  cwd: desktopRoot,
  stdio: 'inherit',
  shell: true
})

if (!canLoadBetterSqlite3WithElectron()) {
  throw new Error('[native-deps] better-sqlite3 is still unavailable after install-app-deps')
}

console.log('[native-deps] Electron native dependencies are ready')
