import { Hono } from 'hono'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const systemRouter = new Hono()

interface ContainerInfo {
  name: string
  status: string
  cpu: string
  memory: string
  memoryRaw: number
  memoryLimit: number
  memoryPercent: number
  uptime: string
  image: string
}

interface DiskInfo {
  filesystem: string
  size: string
  used: string
  available: string
  usedPercent: number
  mountpoint: string
}

// ── Helper: get Docker container stats ──
function getContainerStats(): ContainerInfo[] {
  try {
    // Get container list via docker ps
    const psOutput = execFileSync('docker', [
      'ps', '-a',
      '--filter', 'name=cortex-',
      '--format', '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}',
    ], { timeout: 5000, encoding: 'utf-8' }).trim()

    if (!psOutput) return []

    const containers = psOutput.split('\n').filter(Boolean)
    const stats: ContainerInfo[] = []

    // Get stats for all running containers in one call
    const statsMap: Record<string, { cpu: string; memory: string; memPercent: number }> = {}
    try {
      const statsOutput = execFileSync('docker', [
        'stats', '--no-stream',
        '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}',
      ], { timeout: 10000, encoding: 'utf-8' }).trim()

      if (statsOutput) {
        for (const line of statsOutput.split('\n').filter(Boolean)) {
          const [name, cpu, memory, memPerc] = line.split('|')
          if (name) {
            statsMap[name] = {
              cpu: cpu ?? '0%',
              memory: memory ?? '0B / 0B',
              memPercent: parseFloat(memPerc?.replace('%', '') ?? '0') || 0,
            }
          }
        }
      }
    } catch {
      // docker stats might fail if no running containers
    }

    for (const line of containers) {
      const [name, state, statusText, image] = line.split('|')
      if (!name) continue

      const containerStats = statsMap[name]
      let memoryRaw = 0
      let memoryLimit = 0

      if (containerStats?.memory) {
        const memMatch = containerStats.memory.match(/([\d.]+)(\w+)\s*\/\s*([\d.]+)(\w+)/)
        if (memMatch) {
          memoryRaw = parseToBytes(parseFloat(memMatch[1]!), memMatch[2]!)
          memoryLimit = parseToBytes(parseFloat(memMatch[3]!), memMatch[4]!)
        }
      }

      stats.push({
        name: name ?? 'unknown',
        status: state ?? 'unknown',
        cpu: containerStats?.cpu ?? '0%',
        memory: containerStats?.memory ?? '—',
        memoryRaw,
        memoryLimit,
        memoryPercent: containerStats?.memPercent ?? 0,
        uptime: statusText ?? '',
        image: (image ?? '').split(':')[0]?.split('/').pop() ?? image ?? '',
      })
    }

    return stats.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function parseToBytes(value: number, unit: string): number {
  const u = unit.toLowerCase()
  if (u.includes('gib') || u.includes('gb')) return value * 1024 * 1024 * 1024
  if (u.includes('mib') || u.includes('mb')) return value * 1024 * 1024
  if (u.includes('kib') || u.includes('kb')) return value * 1024
  return value
}

// ── Helper: get disk usage ──
function getDiskUsage(): DiskInfo[] {
  try {
    const output = execFileSync('df', ['-h', '/'], {
      timeout: 3000, encoding: 'utf-8',
    })
    const lines = output.trim().split('\n')
    if (lines.length < 2) return []

    const parts = lines[1]!.split(/\s+/)
    return [{
      filesystem: parts[0] ?? 'unknown',
      size: parts[1] ?? '0',
      used: parts[2] ?? '0',
      available: parts[3] ?? '0',
      usedPercent: parseInt(parts[4]?.replace('%', '') ?? '0', 10),
      mountpoint: parts[5] ?? '/',
    }]
  } catch {
    return []
  }
}

// ── Helper: get CPU usage (average over 1 second) ──
function getCpuUsage(): { percent: number; cores: number; model: string; loadAvg: number[] } {
  const cpus = os.cpus()
  const loadAvg = os.loadavg()
  const cores = cpus.length
  // Use 1-min load average as percentage of cores
  const percent = Math.min(100, Math.round((loadAvg[0]! / cores) * 100))

  return {
    percent,
    cores,
    model: cpus[0]?.model ?? 'Unknown',
    loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
  }
}

// ── Main endpoint ──
systemRouter.get('/metrics', async (c) => {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const memPercent = Math.round((usedMem / totalMem) * 100)

  const cpu = getCpuUsage()
  const disk = getDiskUsage()
  const containers = getContainerStats()

  // Network info
  const networkInterfaces = os.networkInterfaces()
  const primaryIp = Object.values(networkInterfaces)
    .flat()
    .find(iface => iface && !iface.internal && iface.family === 'IPv4')?.address ?? 'unknown'

  return c.json({
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: Math.floor(os.uptime()),
    ip: primaryIp,
    cpu: {
      percent: cpu.percent,
      cores: cpu.cores,
      model: cpu.model,
      loadAvg: cpu.loadAvg,
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: memPercent,
      totalHuman: formatBytes(totalMem),
      usedHuman: formatBytes(usedMem),
      freeHuman: formatBytes(freeMem),
    },
    disk: disk.map(d => ({
      ...d,
    })),
    containers,
  })
})

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}
