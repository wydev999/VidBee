import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { type IpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { resolveBundledResourcesPath } from '../../lib/bundled-resources-path'
import { settingsManager } from '../../settings'
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
  updateAvailable: boolean
}

function getProxyUrl(): string {
  return (settingsManager.get('proxy') ?? '').trim()
}

function sendProgress(toolName: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('toolUpdate:progress', { tool: toolName, percent })
    }
  }
}

function runVersionCheck(binaryPath: string, args: string[]): string | null {
  try {
    const { execSync } = require('node:child_process')
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

function downloadFile(url: string, destPath: string, toolName: string): Promise<void> {
  const proxy = getProxyUrl()
  if (proxy) {
    return downloadFileWithCurl(url, destPath, toolName, proxy)
  }
  return downloadFileDirect(url, destPath, toolName)
}

function downloadFileDirect(url: string, destPath: string, toolName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    https
      .get(url, { headers: { 'User-Agent': 'vidbee' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const location = response.headers.location
          if (location) {
            response.resume()
            file.close()
            safeUnlink(destPath)
            return downloadFileDirect(location, destPath, toolName).then(resolve).catch(reject)
          }
        }
        if (response.statusCode !== 200) {
          response.resume()
          file.close()
          safeUnlink(destPath)
          return reject(new Error(`HTTP ${response.statusCode} for ${url}`))
        }

        const contentLength = Number.parseInt(response.headers['content-length'] ?? '0', 10)
        let downloadedBytes = 0

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length
          if (contentLength > 0) {
            sendProgress(toolName, Math.round((downloadedBytes / contentLength) * 100))
          }
        })

        response.pipe(file)
        file.on('finish', () => {
          file.close()
          sendProgress(toolName, 100)
          resolve()
        })
      })
      .on('error', (error) => {
        file.close()
        safeUnlink(destPath)
        reject(error)
      })
  })
}

function downloadFileWithCurl(
  url: string,
  destPath: string,
  toolName: string,
  proxy: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = os.platform() === 'win32'
    const curlExe = isWin ? 'curl.exe' : 'curl'
    const args = [
      '-sSL',
      '--retry',
      '3',
      '--retry-delay',
      '2',
      '--ssl-no-revoke',
      '--insecure',
      '-x',
      proxy,
      '-o',
      destPath,
      '--write-out',
      '%{size_download}',
      url
    ]

    const proc = spawn(curlExe, args, {
      windowsHide: true,
      timeout: 300_000
    })
    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        sendProgress(toolName, 100)
        resolve()
      } else {
        safeUnlink(destPath)
        reject(new Error(`curl exit code ${code}: ${stderr.trim() || 'unknown error'}`))
      }
    })

    proc.on('error', (error) => {
      safeUnlink(destPath)
      reject(error)
    })
  })
}

interface ToolDefinition {
  name: string
  displayName: string
  binaryName: string
  subDir: string | null
  versionArgs: string[]
  githubRepo: string | null
  versionExtractPattern: RegExp | null
  assetName: string | null
  assetFilter:
    | ((
        assets: Array<{
          name?: string
          browser_download_url?: string
        }>
      ) => string | undefined)
    | null
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

  private getToolDefinitions(): ToolDefinition[] {
    const isWin = os.platform() === 'win32'
    const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64'
    return [
      {
        name: 'yt-dlp',
        displayName: 'yt-dlp',
        binaryName: isWin ? 'yt-dlp.exe' : 'yt-dlp',
        subDir: null,
        versionArgs: ['--version'],
        githubRepo: 'yt-dlp/yt-dlp',
        versionExtractPattern: null,
        assetName: isWin ? 'yt-dlp.exe' : 'yt-dlp',
        assetFilter: null
      },
      {
        name: 'ffmpeg',
        displayName: 'FFmpeg',
        binaryName: isWin ? 'ffmpeg.exe' : 'ffmpeg',
        subDir: 'ffmpeg',
        versionArgs: ['-version'],
        githubRepo: 'yt-dlp/FFmpeg-Builds',
        versionExtractPattern: /ffmpeg version (\S+)/i,
        assetName: null,
        assetFilter: (assets) => {
          const suffix = isWin
            ? 'win64-gpl.zip'
            : os.platform() === 'darwin'
              ? 'macos64-gpl.tar.xz'
              : 'linux64-gpl.tar.xz'
          const pattern = new RegExp(`ffmpeg-master-[^-]+-${suffix.replace(/\./g, '\\.')}`, 'i')
          return assets.find((a) => a.name && pattern.test(a.name))?.browser_download_url
        }
      },
      {
        name: 'ffprobe',
        displayName: 'FFprobe',
        binaryName: isWin ? 'ffprobe.exe' : 'ffprobe',
        subDir: 'ffmpeg',
        versionArgs: ['-version'],
        githubRepo: null,
        versionExtractPattern: /ffprobe version (\S+)/i,
        assetName: null,
        assetFilter: null
      },
      {
        name: 'deno',
        displayName: 'Deno',
        binaryName: isWin ? 'deno.exe' : 'deno',
        subDir: null,
        versionArgs: ['--version'],
        githubRepo: 'denoland/deno',
        versionExtractPattern: /^deno (\S+)/m,
        assetName: null,
        assetFilter: (assets) => {
          const name = isWin
            ? `deno-${arch}-pc-windows-msvc.zip`
            : os.platform() === 'darwin'
              ? `deno-${arch}-apple-darwin.zip`
              : `deno-${arch}-unknown-linux-gnu.zip`
          return assets.find((a) => a.name === name)?.browser_download_url
        }
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

  private async getFfmpegBuildsVersion(): Promise<string | null> {
    try {
      const proxy = getProxyUrl()
      const isWin = os.platform() === 'win32'
      const curlExe = isWin ? 'curl.exe' : 'curl'
      const authArgs = ['-sSL', '--ssl-no-revoke', '--insecure']
      if (proxy) {
        authArgs.push('-x', proxy)
      }
      const result = execSync(
        `"${curlExe}" ${authArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')} "https://github.com/yt-dlp/FFmpeg-Builds/releases?per_page=1"`,
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      )
      const match = result.match(/autobuild-(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}/)
      if (match) {
        return match[1].replace(/-/g, '')
      }
      return null
    } catch {
      return null
    }
  }

  @IpcMethod()
  async checkForUpdates(_context: IpcContext): Promise<ToolUpdateCheck[]> {
    const results: ToolUpdateCheck[] = []

    for (const def of this.getToolDefinitions()) {
      if (!def.githubRepo) {
        continue
      }

      try {
        let latestVersion: string | null = null
        let releaseAssets: Array<{ name?: string; browser_download_url?: string }> = []

        if (def.githubRepo === 'yt-dlp/FFmpeg-Builds') {
          const dateStr = await this.getFfmpegBuildsVersion()
          if (!dateStr) {
            continue
          }
          latestVersion = dateStr
          const list = (await fetchJson(
            `https://api.github.com/repos/${def.githubRepo}/releases?per_page=2`
          )) as Array<{
            tag_name?: string
            assets?: Array<{ name?: string; browser_download_url?: string }>
          }>
          const realRelease = (list ?? []).find((r) => r.tag_name !== 'latest')
          releaseAssets = realRelease?.assets ?? []
        } else {
          const release = (await fetchJson(
            `https://api.github.com/repos/${def.githubRepo}/releases/latest`
          )) as {
            tag_name?: string
            assets?: Array<{ name?: string; browser_download_url?: string }>
          }
          latestVersion = release.tag_name ?? null
          releaseAssets = release.assets ?? []
        }

        if (!latestVersion) {
          continue
        }

        let downloadUrl = ''
        const assets = releaseAssets
        if (def.assetFilter) {
          downloadUrl = def.assetFilter(assets) ?? ''
        } else if (def.assetName) {
          downloadUrl =
            (assets ?? []).find((a) => a.name === def.assetName)?.browser_download_url ?? ''
        }

        const currentVersion = this.getCurrentVersion(def)
        const updateAvailable = this.checkUpdateAvailable(currentVersion, latestVersion)

        results.push({
          name: def.name,
          latestVersion,
          downloadUrl,
          updateAvailable
        })
      } catch (error) {
        scopedLoggers.system.warn(`Failed to check update for ${def.name}:`, error)
      }
    }

    return results
  }

  private getCurrentVersion(def: ToolDefinition): string | null {
    const resourcesPath = this.getResourcesPath()
    const binaryPath = def.subDir
      ? path.join(resourcesPath, def.subDir, def.binaryName)
      : path.join(resourcesPath, def.binaryName)
    if (!fs.existsSync(binaryPath)) {
      return null
    }
    const raw = runVersionCheck(binaryPath, def.versionArgs)
    if (raw && def.versionExtractPattern) {
      const match = raw.match(def.versionExtractPattern)
      return match?.[1] ?? raw.split('\n')[0]?.trim() ?? raw
    }
    return raw
  }

  private checkUpdateAvailable(currentVersion: string | null, latestTag: string): boolean {
    if (!currentVersion) {
      return true
    }

    const cleanTag = latestTag.replace(/^v/, '')
    return !(currentVersion.includes(cleanTag) || currentVersion.includes(latestTag))
  }

  @IpcMethod()
  async updateTool(_context: IpcContext, toolName: string): Promise<boolean> {
    const def = this.getToolDefinitions().find((d) => d.name === toolName)
    if (!def?.githubRepo) {
      throw new Error(`Unknown tool or no update source: ${toolName}`)
    }

    const resourcesPath = this.getResourcesPath()

    if (toolName === 'yt-dlp') {
      return await this.updateYtDlp(resourcesPath)
    }

    if (toolName === 'ffmpeg' || toolName === 'ffprobe') {
      return await this.updateFfmpeg(resourcesPath)
    }

    if (toolName === 'deno') {
      return await this.updateDeno(resourcesPath)
    }

    throw new Error(`Update not implemented for: ${toolName}`)
  }

  private async updateYtDlp(resourcesPath: string): Promise<boolean> {
    const release = (await fetchJson(
      'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
    )) as {
      assets?: Array<{
        name?: string
        browser_download_url?: string
      }>
    }

    const isWin = os.platform() === 'win32'
    const assetName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
    const asset = (release.assets ?? []).find((a) => a.name === assetName)
    if (!asset?.browser_download_url) {
      throw new Error('Failed to find yt-dlp download URL')
    }

    const binaryPath = path.join(resourcesPath, assetName)
    await downloadFile(asset.browser_download_url, `${binaryPath}.tmp`, 'yt-dlp')

    if (!fs.existsSync(`${binaryPath}.tmp`)) {
      throw new Error('Downloaded file not found')
    }
    fs.renameSync(`${binaryPath}.tmp`, binaryPath)
    return true
  }

  private async updateFfmpeg(resourcesPath: string): Promise<boolean> {
    const isWin = os.platform() === 'win32'
    const isMac = os.platform() === 'darwin'

    const apiUrl = 'https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases?per_page=1'
    const response = await fetchJson(apiUrl)
    const release = (
      Array.isArray(response)
        ? (
            response as Array<{
              tag_name?: string
              assets?: Array<{ name?: string; browser_download_url?: string }>
            }>
          )[0]
        : response
    ) as {
      assets?: Array<{
        name?: string
        browser_download_url?: string
      }>
    }

    const suffix = isWin ? 'win64-gpl.zip' : isMac ? 'macos64-gpl.tar.xz' : 'linux64-gpl.tar.xz'
    const assetPattern = new RegExp(`ffmpeg-master-[^-]+-${suffix.replace(/\./g, '\\.')}`, 'i')
    const asset = (release.assets ?? []).find((a) => a.name && assetPattern.test(a.name))
    if (!asset?.browser_download_url) {
      throw new Error('Failed to find ffmpeg download URL')
    }

    const tempDir = path.join(resourcesPath, '.ffmpeg-update-temp')
    const tempArchive = path.join(resourcesPath, '.ffmpeg-update-archive.zip')
    const ffmpegDir = path.join(resourcesPath, 'ffmpeg')

    try {
      fs.mkdirSync(tempDir, { recursive: true })
      await downloadFile(asset.browser_download_url, tempArchive, 'ffmpeg')

      if (!fs.existsSync(tempArchive)) {
        throw new Error('Downloaded ffmpeg archive not found')
      }

      if (isWin) {
        const { execSync } = require('node:child_process')
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Path '${tempArchive.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force"`,
          {
            stdio: 'pipe',
            timeout: 60_000,
            windowsHide: true
          }
        )
      } else {
        const { execSync } = require('node:child_process')
        execSync(`tar -xf "${tempArchive}" -C "${tempDir}"`, { stdio: 'pipe', timeout: 60_000 })
      }

      const entries = fs.readdirSync(tempDir)
      const extractedDir = entries.find((e) => {
        const full = path.join(tempDir, e)
        return fs.statSync(full).isDirectory() && e.startsWith('ffmpeg-master')
      })
      if (!extractedDir) {
        throw new Error('Could not find extracted ffmpeg directory')
      }

      const binDir = path.join(tempDir, extractedDir, 'bin')
      const ffmpegSrc = path.join(binDir, isWin ? 'ffmpeg.exe' : 'ffmpeg')
      const ffprobeSrc = path.join(binDir, isWin ? 'ffprobe.exe' : 'ffprobe')

      if (!fs.existsSync(ffmpegSrc)) {
        throw new Error(`ffmpeg binary not found in extracted archive at ${ffmpegSrc}`)
      }

      fs.mkdirSync(ffmpegDir, { recursive: true })
      fs.copyFileSync(ffmpegSrc, path.join(ffmpegDir, isWin ? 'ffmpeg.exe' : 'ffmpeg'))

      if (fs.existsSync(ffprobeSrc)) {
        fs.copyFileSync(ffprobeSrc, path.join(ffmpegDir, isWin ? 'ffprobe.exe' : 'ffprobe'))
      }

      if (!isWin) {
        try {
          fs.chmodSync(path.join(ffmpegDir, 'ffmpeg'), 0o755)
          if (fs.existsSync(path.join(ffmpegDir, 'ffprobe'))) {
            fs.chmodSync(path.join(ffmpegDir, 'ffprobe'), 0o755)
          }
        } catch {
          // ignore
        }
      }

      return true
    } finally {
      safeUnlink(tempArchive)
      safeRmdir(tempDir)
    }
  }

  private async updateDeno(resourcesPath: string): Promise<boolean> {
    const isWin = os.platform() === 'win32'
    const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64'

    const release = (await fetchJson(
      'https://api.github.com/repos/denoland/deno/releases/latest'
    )) as {
      tag_name?: string
      assets?: Array<{
        name?: string
        browser_download_url?: string
      }>
    }

    const assetName = isWin
      ? `deno-${arch}-pc-windows-msvc.zip`
      : os.platform() === 'darwin'
        ? `deno-${arch}-apple-darwin.zip`
        : `deno-${arch}-unknown-linux-gnu.zip`
    const asset = (release.assets ?? []).find((a) => a.name === assetName)
    if (!asset?.browser_download_url) {
      throw new Error(`Failed to find deno download URL for ${assetName}`)
    }

    const outputName = isWin ? 'deno.exe' : 'deno'
    const outputPath = path.join(resourcesPath, outputName)
    const tempDir = path.join(resourcesPath, '.deno-update-temp')
    const tempArchive = path.join(resourcesPath, '.deno-update-archive.zip')

    try {
      fs.mkdirSync(tempDir, { recursive: true })
      await downloadFile(asset.browser_download_url, tempArchive, 'deno')

      if (!fs.existsSync(tempArchive)) {
        throw new Error('Downloaded deno archive not found')
      }

      if (isWin) {
        const { execSync } = require('node:child_process')
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Path '${tempArchive.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force"`,
          {
            stdio: 'pipe',
            timeout: 60_000,
            windowsHide: true
          }
        )
      } else {
        const { execSync } = require('node:child_process')
        execSync(`unzip -q "${tempArchive}" -d "${tempDir}"`, { stdio: 'pipe', timeout: 60_000 })
      }

      const denoBinary = path.join(tempDir, outputName)
      if (!fs.existsSync(denoBinary)) {
        throw new Error(`Deno binary not found at ${denoBinary}`)
      }

      fs.copyFileSync(denoBinary, outputPath)
      if (!isWin) {
        try {
          fs.chmodSync(outputPath, 0o755)
        } catch {
          // ignore
        }
      }

      return true
    } finally {
      safeUnlink(tempArchive)
      safeRmdir(tempDir)
    }
  }
}

function fetchJson(url: string): Promise<unknown> {
  const proxy = getProxyUrl()
  if (proxy) {
    try {
      const { execSync } = require('node:child_process')
      const isWin = os.platform() === 'win32'
      const curlExe = isWin ? 'curl.exe' : 'curl'
      const result = execSync(
        `"${curlExe}" -sSL --retry 2 --ssl-no-revoke --insecure -x "${proxy}" "${url}"`,
        {
          encoding: 'utf8',
          timeout: 30_000,
          windowsHide: true
        }
      )
      return Promise.resolve(JSON.parse(result))
    } catch (error) {
      throw new Error(`API request failed via proxy: ${(error as Error).message}`)
    }
  }

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

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // ignore
  }
}

function safeRmdir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
    }
  } catch {
    // ignore
  }
}

export { ToolUpdateService }
