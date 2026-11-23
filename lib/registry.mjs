/**
 * dsh-patch-sync —— 官方基线获取。
 *
 * 从 npm registry 取插件精确版本的 tarball，在内存里解压/解析后计算文件哈希，
 * 作为"官方原版"基线。只在需要时联网（首次纳管某插件某版本、或该版本还没
 * 有缓存），结果由 core.ensureBaseline 落盘缓存。
 * @module dsh-patch-sync/registry
 */

import { gunzipSync } from 'node:zlib'
import { sha256, isExcludedRel } from './core.mjs'

/** registry 元数据地址（scoped 名称把 `/` 编码成 `%2f`）。 */
function metadataUrl(name, version) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name)
  return `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-patch-sync' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
    return response
  } finally {
    clearTimeout(timer)
  }
}

/** 读 tar 头里的字符串字段（去 NUL / 去尾部空格）。 */
function headerString(buffer, offset, length) {
  let end = offset + length
  while (end > offset && (buffer[end - 1] === 0 || buffer[end - 1] === 0x20)) end--
  return buffer.subarray(offset, end).toString('utf8')
}

/** 解析 pax 扩展头（`<len> key=value\n` 序列）。 */
function parsePax(data, sink) {
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equal = record.indexOf('=')
    if (equal > 0) sink(record.slice(0, equal), record.slice(equal + 1))
    offset += length
  }
}

/**
 * 解析 ustar（含 GNU longlink / pax 长路径）为文件条目。
 * @param {Buffer} buffer - 未压缩的 tar 内容
 * @returns {{path: string, data: Buffer}[]}
 */
export function parseTar(buffer) {
  const files = []
  let offset = 0
  let pendingPath = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = headerString(header, 0, 100)
    const prefix = headerString(header, 345, 155)
    const size = Number.parseInt(headerString(header, 124, 12) || '0', 8) || 0
    const type = String.fromCharCode(header[156] || 0x30)
    const dataStart = offset + 512
    const dataEnd = Math.min(dataStart + size, buffer.length)
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'x' || type === 'g') {
      if (type === 'x') parsePax(data, (key, value) => { if (key === 'path') pendingPath = value })
    } else if (type === 'L') {
      pendingPath = data.toString('utf8').replace(/\0+$/g, '')
    } else if (type === '0' || type === '\0' || type === '') {
      let filePath = prefix !== '' ? `${prefix}/${name}` : name
      if (pendingPath !== null) {
        filePath = pendingPath
        pendingPath = null
      }
      if (!filePath.endsWith('/')) files.push({ path: filePath, data: Buffer.from(data) })
    } else {
      pendingPath = null
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

/** 去掉 npm tarball 顶层的 `package/` 前缀。 */
function stripPackagePrefix(filePath) {
  return filePath.startsWith('package/') ? filePath.slice('package/'.length) : filePath
}

/**
 * 拉取并解析某插件某版本 npm tarball 的官方文件哈希。
 * @param {string} name - npm 包名（可带 scope）
 * @param {string} version - 精确版本
 * @returns {Promise<{plugin: string, version: string, files: Map<string,string>}>}
 */
export async function fetchRegistryBaseline(name, version) {
  const metaResponse = await fetchWithTimeout(metadataUrl(name, version), 15_000)
  const metadata = await metaResponse.json()
  const tarballUrl = metadata?.dist?.tarball
  if (typeof tarballUrl !== 'string' || tarballUrl === '') {
    throw new Error(`registry 元数据缺少 tarball: ${name}@${version}`)
  }
  const tarballResponse = await fetchWithTimeout(tarballUrl, 60_000)
  const tarball = Buffer.from(await tarballResponse.arrayBuffer())
  const raw = parseTar(gunzipSync(tarball))
  /** @type {Map<string, string>} */
  const files = new Map()
  for (const item of raw) {
    const rel = stripPackagePrefix(item.path)
    if (rel === '' || rel.endsWith('/')) continue
    const parts = rel.split('/').filter(Boolean)
    if (parts.some((part) => part === '..')) continue
    const normalized = parts.join('/')
    if (isExcludedRel(normalized)) continue
    files.set(normalized, sha256(item.data))
  }
  return { plugin: name, version, files }
}
