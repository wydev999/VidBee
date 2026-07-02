import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { type IpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { resolveBundledResourcesPath } from '../../lib/bundled-resources-path'
import { scopedLoggers } from '../../utils/logger'

interface ToolInfo {
  name: string
  displayName: string
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  binaryPath: string
}

interface ToolsStatus {
  tools: ToolInfo[]
}

interface ToolUpdateCheck {
  name: string
  latestVersion: string
  downloadUrl: string
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'vidbee',
            Accept: 'application/vnd.github+json'
          }
        },
        (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            const location = response.headers.location
            if (location) {
              response.resume()
              return fetchJson(location).then(resolve).catch(reject)
            }
          }
          if (response.statusCode !== 200) {
            response.resume()
            return reject(new Error(`HTTP ${response.statusCode} for ${url}`))
          }
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch (error) {
              reject(new Error(`Failed to parse JSON: ${(error as Error).message}`))
            }
          })
        }
      )
      .on('error', reject)
  })
}

function runVersionCheck(binaryPath: string, args: string[]): string | null {
  try {
    const result = execSync(`"${binaryPath}" ${args.join(' ')}`, {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    })
    const lines = result.split(/\r?\n/).filter(Boolean)
    return lines[0]?.trim() ?? null
  } catch {
    return null
  }
}

class ToolUpdateService extends IpcService {
  static readonly groupName = 'toolUpdate'

  private resourcesPath: string | null = null

  private getResourcesPath(): string {
    if (!this.resourcesPath) {
      this.resourcesPath = resolveBundledResourcesPath([
        os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
      ])
    }
    return this.resourcesPath
  }

  private getToolDefinitions(): Array<{
    name: string
    displayName: string
    binaryName: string
    subDir: string | null
    versionArgs: string[]
    githubRepo: string | null
    versionExtractPattern: RegExp | null
  }> {
    const isWin = os.platform() === 'win32'
    return [
      {
        name: 'yt-dlp',
        displayName: 'yt-dlp',
        binaryName: isWin ? 'yt-dlp.exe' : 'yt-dlp',
        subDir: null,
        versionArgs: ['--version'],
        githubRepo: 'yt-dlp/yt-dlp',
        versionExtractPattern: null
      },
      {
        name: 'ffmpeg',
        displayName: 'FFmpeg',
        binaryName: isWin ? 'ffmpeg.exe' : 'ffmpeg',
        subDir: 'ffmpeg',
        versionArgs: ['-version'],
        githubRepo: 'yt-dlp/FFmpeg-Builds',
        versionExtractPattern: /ffmpeg version (\S+)/i
      },
      {
        name: 'ffprobe',
        displayName: 'FFprobe',
        binaryName: isWin ? 'ffprobe.exe' : 'ffprobe',
        subDir: 'ffmpeg',
        versionArgs: ['-version'],
        githubRepo: null,
        versionExtractPattern: /ffprobe version (\S+)/i
      },
      {
        name: 'deno',
        displayName: 'Deno',
        binaryName: isWin ? 'deno.exe' : 'deno',
        subDir: null,
        versionArgs: ['--version'],
        githubRepo: 'denoland/deno',
        versionExtractPattern: /^deno (\S+)/m
      }
    ]
  }

  @IpcMethod()
  async getToolsStatus(_context: IpcContext): Promise<ToolsStatus> {
    const resourcesPath = this.getResourcesPath()
    const tools: ToolInfo[] = []

    for (const def of this.getToolDefinitions()) {
      const binaryPath = def.subDir
        ? path.join(resourcesPath, def.subDir, def.binaryName)
        : path.join(resourcesPath, def.binaryName)

      let currentVersion: string | null = null
      if (fs.existsSync(binaryPath)) {
        const raw = runVersionCheck(binaryPath, def.versionArgs)
        if (raw && def.versionExtractPattern) {
          const match = raw.match(def.versionExtractPattern)
          currentVersion = match?.[1] ?? raw.split('\n')[0]?.trim() ?? raw
        } else {
          currentVersion = raw
        }
      }

      tools.push({
        name: def.name,
        displayName: def.displayName,
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        binaryPath
      })
    }

    return { tools }
  }

  @IpcMethod()
  async checkForUpdates(_context: IpcContext): Promise<ToolUpdateCheck[]> {
    const results: ToolUpdateCheck[] = []

    for (const def of this.getToolDefinitions()) {
      if (!def.githubRepo) {
        continue
      }

      try {
        if (def.githubRepo === 'yt-dlp/yt-dlp') {
          const release = (await fetchJson(
            `https://api.github.com/repos/${def.githubRepo}/releases/latest`
          )) as {
            tag_name?: string
            assets?: Array<{ name?: string; browser_download_url?: string }>
          }
          const latestVersion = release.tag_name ?? null

          if (latestVersion) {
            const asset = (release.assets ?? []).find(
              (a) => a.name === (os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
            )
            results.push({
              name: def.name,
              latestVersion,
              downloadUrl: asset?.browser_download_url ?? ''
            })
          }
        } else if (def.githubRepo === 'yt-dlp/FFmpeg-Builds') {
          const release = (await fetchJson(
            `https://api.github.com/repos/${def.githubRepo}/releases/latest`
          )) as {
            tag_name?: string
            assets?: Array<{ name?: string; browser_download_url?: string }>
          }
          const latestVersion = release.tag_name ?? null

          if (latestVersion) {
            const assetName =
              os.platform() === 'win32'
                ? 'ffmpeg-master-latest-win64-gpl.zip'
                : os.platform() === 'darwin'
                  ? 'ffmpeg-master-latest-macos64-gpl.tar.xz'
                  : 'ffmpeg-master-latest-linux64-gpl.tar.xz'
            const asset = (release.assets ?? []).find(
              (a) => a.name?.toLowerCase() === assetName.toLowerCase()
            )
            results.push({
              name: def.name,
              latestVersion,
              downloadUrl: asset?.browser_download_url ?? ''
            })
          }
        } else if (def.githubRepo === 'denoland/deno') {
          const release = (await fetchJson(
            `https://api.github.com/repos/${def.githubRepo}/releases/latest`
          )) as { tag_name?: string }
          const latestVersion = release.tag_name ?? null

          if (latestVersion) {
            const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64'
            const assetName =
              os.platform() === 'win32'
                ? `deno-${arch}-pc-windows-msvc.zip`
                : os.platform() === 'darwin'
                  ? `deno-${arch}-apple-darwin.zip`
                  : `deno-${arch}-unknown-linux-gnu.zip`
            const asset = (
              release as { assets?: Array<{ name?: string; browser_download_url?: string }> }
            ).assets?.find((a) => a.name === assetName)
            results.push({
              name: def.name,
              latestVersion,
              downloadUrl: asset?.browser_download_url ?? ''
            })
          }
        }
      } catch (error) {
        scopedLoggers.system.warn(`Failed to check update for ${def.name}:`, error)
      }
    }

    return results
  }

  @IpcMethod()
  async updateTool(_context: IpcContext, toolName: string): Promise<boolean> {
    const def = this.getToolDefinitions().find((d) => d.name === toolName)
    if (!def?.githubRepo) {
      throw new Error(`Unknown tool or no update source: ${toolName}`)
    }

    const resourcesPath = this.getResourcesPath()
    const binaryPath = def.subDir
      ? path.join(resourcesPath, def.subDir, def.binaryName)
      : path.join(resourcesPath, def.binaryName)

    if (toolName === 'yt-dlp') {
      const release = (await fetchJson(
        'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
      )) as { assets?: Array<{ name?: string; browser_download_url?: string }> }
      const asset = (release.assets ?? []).find(
        (a) => a.name === (os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
      )
      if (!asset?.browser_download_url) {
        throw new Error('Failed to find yt-dlp download URL')
      }
      await downloadFile(asset.browser_download_url, `${binaryPath}.tmp`)
      fs.renameSync(`${binaryPath}.tmp`, binaryPath)
      return true
    }

    throw new Error(`Update not implemented for: ${toolName}`)
  }
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    https
      .get(url, { headers: { 'User-Agent': 'vidbee' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const location = response.headers.location
          if (location) {
            response.resume()
            file.close()
            fs.unlinkSync(destPath)
            return downloadFile(location, destPath).then(resolve).catch(reject)
          }
        }
        if (response.statusCode !== 200) {
          response.resume()
          file.close()
          fs.unlinkSync(destPath)
          return reject(new Error(`HTTP ${response.statusCode} for ${url}`))
        }
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve()
        })
      })
      .on('error', (error) => {
        file.close()
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath)
        }
        reject(error)
      })
  })
}

export { ToolUpdateService }
