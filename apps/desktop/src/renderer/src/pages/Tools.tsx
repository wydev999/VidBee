import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Progress } from '@renderer/components/ui/progress'
import { Separator } from '@renderer/components/ui/separator'
import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipcEvents, ipcServices } from '../lib/ipc'

interface ToolEntry {
  name: string
  displayName: string
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  checking: boolean
  updating: boolean
  progress: number
}

let toolsCache: ToolEntry[] | null = null

export function Tools() {
  const { t } = useTranslation()
  const [tools, setTools] = useState<ToolEntry[]>(toolsCache ?? [])
  const [loading, setLoading] = useState(toolsCache === null)
  const progressRef = useRef<Record<string, number>>({})

  const loadToolsStatus = useCallback(async (clearCache = false) => {
    if (clearCache) {
      toolsCache = null
    }
    setLoading(true)
    try {
      const status = await ipcServices.toolUpdate.getToolsStatus()
      const mapped = status.tools.map((tool) => ({
        ...tool,
        checking: false,
        updating: false,
        progress: progressRef.current[tool.name] ?? 0
      }))
      toolsCache = mapped
      setTools(mapped)
    } catch (error) {
      console.error('Failed to load tools status:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!toolsCache) {
      void loadToolsStatus()
    }
  }, [loadToolsStatus])

  useEffect(() => {
    const handleProgress = (data: unknown) => {
      const { tool, percent } = (data ?? {}) as {
        tool: string
        percent: number
      }
      progressRef.current[tool] = percent
      setTools((prev) => prev.map((t) => (t.name === tool ? { ...t, progress: percent } : t)))
    }
    ipcEvents.on('toolUpdate:progress', handleProgress)
    return () => {
      ipcEvents.removeListener('toolUpdate:progress', handleProgress)
    }
  }, [])

  const handleCheckUpdates = useCallback(async () => {
    setTools((prev) =>
      prev.map((t) => ({
        ...t,
        checking: true,
        updateAvailable: false,
        latestVersion: null
      }))
    )
    try {
      const updates = await ipcServices.toolUpdate.checkForUpdates()
      setTools((prev) =>
        prev.map((tool) => {
          const update = updates.find((u) => u.name === tool.name)
          if (update) {
            return {
              ...tool,
              latestVersion: update.latestVersion,
              updateAvailable: update.updateAvailable,
              checking: false
            }
          }
          return { ...tool, checking: false }
        })
      )
    } catch (error) {
      console.error('Failed to check updates:', error)
      setTools((prev) => prev.map((t) => ({ ...t, checking: false })))
    }
  }, [])

  const handleUpdateTool = useCallback(
    async (toolName: string) => {
      progressRef.current[toolName] = 0
      setTools((prev) =>
        prev.map((t) => (t.name === toolName ? { ...t, updating: true, progress: 0 } : t))
      )
      try {
        await ipcServices.toolUpdate.updateTool(toolName)
        await loadToolsStatus(true)
        const updates = await ipcServices.toolUpdate.checkForUpdates()
        setTools((prev) =>
          prev.map((tool) => {
            const update = updates.find((u) => u.name === tool.name)
            if (update) {
              return {
                ...tool,
                latestVersion: update.latestVersion,
                updateAvailable: update.updateAvailable,
                updating: false
              }
            }
            return { ...tool, updating: false }
          })
        )
      } catch (error) {
        console.error(`Failed to update ${toolName}:`, error)
        setTools((prev) => prev.map((t) => (t.name === toolName ? { ...t, updating: false } : t)))
      }
    },
    [loadToolsStatus]
  )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-2xl">{t('tools.title')}</h1>
          <p className="text-muted-foreground">{t('tools.description')}</p>
        </div>
        <Button
          disabled={tools.some((t) => t.checking || t.updating)}
          onClick={handleCheckUpdates}
          variant="outline"
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${tools.some((t) => t.checking) ? 'animate-spin' : ''}`}
          />
          {t('tools.checkUpdates')}
        </Button>
      </div>

      <Separator />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {tools.map((tool) => (
            <Card key={tool.name}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-lg">{tool.displayName}</CardTitle>
                    {tool.updating ? (
                      <Badge variant="secondary">
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        {tool.progress > 0 && tool.progress < 100
                          ? `${tool.progress}%`
                          : t('tools.updating')}
                      </Badge>
                    ) : tool.updateAvailable ? (
                      <Badge variant="default">{t('tools.updateAvailable')}</Badge>
                    ) : tool.latestVersion ? (
                      <Badge variant="outline">{t('tools.upToDate')}</Badge>
                    ) : null}
                  </div>
                  {tool.updateAvailable ? (
                    <Button
                      disabled={tool.updating}
                      onClick={() => {
                        void handleUpdateTool(tool.name)
                      }}
                      size="sm"
                    >
                      {tool.updating ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t('tools.updating')}
                        </>
                      ) : (
                        t('tools.updateNow')
                      )}
                    </Button>
                  ) : null}
                </div>
                <CardDescription>
                  {t('tools.currentVersion')}: {tool.currentVersion || t('tools.unknown')}
                  {tool.latestVersion
                    ? ` | ${t('tools.latestVersion')}: ${tool.latestVersion}`
                    : null}
                </CardDescription>
              </CardHeader>
              {tool.updating && tool.progress > 0 && tool.progress < 100 ? (
                <div className="px-6 pb-4">
                  <Progress value={tool.progress} />
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
