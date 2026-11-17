/**
 * dsh-session-rehome —— Host 半边。
 *
 * 把一条**已经落盘**的对话从它现在所属的工作区，搬到另一个工作区的目录里：
 *
 *   1. 会话日志从 `<root>/<projectKey(旧cwd)>/<会话id>/` 搬到
 *      `<root>/<projectKey(新cwd)>/<会话id>/`；
 *   2. 日志第一帧里的 header `cwd` 改写成目标工作区路径；
 *   3. 目标工作区 `attachSession`、原工作区 `detachSession`，让归属表跟着换边；
 *   4. 如果这条会话此刻正被 Host 持有（`ctx.sessions` 里有它，或有写句柄），
 *      同时改写内存里的 `header.cwd` 与写句柄的 header，让它之后继续往新位置写。
 *
 * 为什么必须这么麻烦：DSH 里"会话属于哪个工作区"不是一张可以随意改的表，而是
 * `realpath(header.cwd) === workspace.path` 现算出来的（`Workspace.candidateMatches`），
 * 日志目录名也是从 `header.cwd` 现推的（`projectKey`）。所以搬会话 = 搬文件 + 改 header，
 * 两件事必须同时成立。
 *
 * 硬边界：**正在跑一轮的会话一律拒绝**。那一轮随时可能 append，搬家窗口里挪目录会让
 * 事件写到一个不存在的路径。
 */

import zlib from 'node:zlib'
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'session-rehome'

/** 需要的 Host 服务：没有声明 inject 就拿不到服务，路由会静默 404。 */
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionPersistence']

/** 浏览器半边 POST 的同源端点。 */
const ENDPOINT = '/session-rehome/move'

/** 浏览器半边用来取工作区列表的同源端点。 */
const WORKSPACES_ENDPOINT = '/session-rehome/workspaces'

/** 搬迁前预览"会一并带过去哪些文件"。 */
const FILE_PLAN_ENDPOINT = '/session-rehome/file-plan'

/** 一次请求只有两个 id，8 KiB 足够。 */
const MAX_BODY_BYTES = 8 * 1024

/** 文件随迁的三条上限，防止一次手滑把整个构建目录搬走。 */
const MAX_FILES = 200
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024

/** 规范 generation 文件名：`session.jsonl[.zstd]` / `session.vN.jsonl[.zstd]`。 */
const GENERATION_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/** zstd 帧魔数（按小端读出来是 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528

/** 写句柄目录里的租约文件名（0.2.2 起才有；本构建通常不存在）。 */
const LEASE_NAME = 'session.lock'

/** 和 `dsh-session-persistence-jsonl` 一模一样的压缩参数：带校验和帧。 */
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'

/** 带 HTTP 状态与稳定错误码的搬迁失败。 */
class RelocateError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'RelocateError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// 路径命名（与 dsh-session-persistence-jsonl/format.js 逐字一致）
// ---------------------------------------------------------------------------

/**
 * 把任意字符串编码成一个安全的路径段（会话 id 与项目目录共用同一套转义）。
 * @param {string} raw 原始字符串。
 * @returns {string} 单个文件系统安全的路径段。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 项目目录键：`/` `\` `:` 折叠成一个 `-`，其余不安全码位写成 `~XXXX`，截断 251 字符。
 *
 * **注意**：后端用的是 header 里 `cwd` 的**原样字符串**，不做 realpath 归一。
 * 所以搬到目标时写进 header 的 cwd 必须和工作区记录的 path 是同一个字符串；
 * 目录名也由同一个字符串推出，否则重启后写句柄会算出另一个路径、写出第二份日志。
 * @param {string} cwd 会话项目目录。
 * @returns {string} `--<readable>--` 形式的目录名。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 目录里是不是规范 generation 名。
 * @param {string} fileName 目录项名。
 * @returns {{version: number, compressed: boolean} | undefined}
 */
function parseGenerationName(fileName) {
  const match = GENERATION_NAME.exec(fileName)
  if (match === null) return undefined
  return { version: match[1] === undefined ? 0 : Number(match[1]), compressed: match[2] === '.zstd' }
}

/**
 * 选出会话目录里版本最高的规范 generation。
 * @param {string} dir 会话目录。
 * @returns {{selected?: {name: string, version: number, compressed: boolean}, all: object[], others: string[], error?: string}}
 */
function findGeneration(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return { error: `cannot list session directory ${dir}: ${messageOf(error)}`, all: [], others: [] }
  }
  const generations = []
  const others = []
  for (const entry of entries) {
    const parsed = parseGenerationName(entry.name)
    if (parsed === undefined) {
      others.push(entry.name)
      continue
    }
    if (!entry.isFile()) {
      others.push(entry.name)
      continue
    }
    generations.push({ name: entry.name, version: parsed.version, compressed: parsed.compressed })
  }
  if (generations.length === 0) return { error: `no canonical session log in ${dir}`, all: [], others }
  generations.sort((left, right) => right.version - left.version)
  return { selected: generations[0], all: generations, others }
}

// ---------------------------------------------------------------------------
// zstd 帧（只认得本产品写出来的形态：独立帧首尾相接，header 独占第一帧）
// ---------------------------------------------------------------------------

/**
 * 走一遍拼接帧，给出每帧的字节范围。
 *
 * 只解析帧头与块序列的**长度**，不碰块内容——目的只是找到第一帧在哪里结束。
 * @param {Buffer} buffer 整个日志文件。
 * @returns {{frames: {start: number, end: number}[], incomplete: boolean, reason?: string}}
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, incomplete: true, reason: 'file ends inside a frame magic' }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      return { frames, incomplete: true, reason: `no zstd frame magic at byte ${offset}` }
    }
    offset += 4
    if (offset >= buffer.length) return { frames, incomplete: true, reason: 'frame header is truncated' }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    if (singleSegment === 0) offset += 1 // Window_Descriptor
    offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    offset += fcsSize
    if (offset > buffer.length) return { frames, incomplete: true, reason: 'frame header crosses the end of file' }
    for (;;) {
      if (offset + 3 > buffer.length) return { frames, incomplete: true, reason: 'block header is truncated' }
      const header = buffer.readUInt8(offset) | (buffer.readUInt8(offset + 1) << 8) | (buffer.readUInt8(offset + 2) << 16)
      offset += 3
      const lastBlock = header & 1
      const blockType = (header >> 1) & 3
      const blockSize = header >> 3
      if (blockType === 0) offset += blockSize
      else if (blockType === 1) offset += 1
      else if (blockType === 2) offset += blockSize
      else return { frames, incomplete: true, reason: 'reserved zstd block type' }
      if (lastBlock === 1) break
    }
    if (checksum === 1) offset += 4
    if (offset > buffer.length) return { frames, incomplete: true, reason: 'frame body crosses the end of file' }
    frames.push({ start, end: offset })
  }
  return { frames, incomplete: false }
}

/**
 * 读出日志第一帧里的 header 对象。
 * @param {Buffer} buffer 日志内容。
 * @param {boolean} compressed 是否 zstd 帧日志。
 * @returns {object | undefined}
 */
function readHeaderFromBuffer(buffer, compressed) {
  const firstLine = (text) => {
    const index = text.indexOf('\n')
    return index === -1 ? text : text.slice(0, index)
  }
  try {
    if (!compressed) {
      const parsed = JSON.parse(firstLine(buffer.toString('utf8')))
      return parsed !== null && typeof parsed === 'object' && parsed.type === 'session' ? parsed : undefined
    }
    const scan = scanZstdFrames(buffer)
    if (scan.frames.length === 0) return undefined
    const frame = scan.frames[0]
    const text = Buffer.from(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end))).toString('utf8')
    const parsed = JSON.parse(firstLine(text))
    return parsed !== null && typeof parsed === 'object' && parsed.type === 'session' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 改写 header 里的 `cwd`：重压第一帧，后面所有帧**逐字节原样保留**。
 *
 * 这是整件事里唯一真正动内容的一步。之所以安全：header 独占第一帧，其余帧是各自
 * 带校验和的独立 zstd 帧，与前面无关，所以不需要把整份日志解压再压回去。
 * @param {Buffer} buffer 原日志。
 * @param {string} newCwd 目标路径。
 * @param {{compressed: boolean}} options
 * @returns {{buffer: Buffer, rewritten: boolean, header?: object, reason?: string}}
 */
function rewriteHeaderCwd(buffer, newCwd, options) {
  const compressed = options.compressed !== false
  if (!compressed) {
    const text = buffer.toString('utf8')
    const index = text.indexOf('\n')
    const firstLine = index === -1 ? text : text.slice(0, index)
    const rest = index === -1 ? '' : text.slice(index)
    let header
    try {
      header = JSON.parse(firstLine)
    } catch {
      return { buffer, rewritten: false, reason: 'header line is not JSON' }
    }
    if (header?.type !== 'session' || typeof header.cwd !== 'string') {
      return { buffer, rewritten: false, reason: 'header has no cwd' }
    }
    const rebuilt = {}
    for (const [key, value] of Object.entries(header)) rebuilt[key] = key === 'cwd' ? newCwd : value
    return { buffer: Buffer.from(JSON.stringify(rebuilt) + rest, 'utf8'), rewritten: true, header: rebuilt }
  }
  if (!hasZstd) return { buffer, rewritten: false, reason: 'this node build has no zstd support' }
  const scan = scanZstdFrames(buffer)
  if (scan.incomplete || scan.frames.length === 0) {
    return { buffer, rewritten: false, reason: scan.reason ?? 'no complete frame' }
  }
  const first = scan.frames[0]
  let header
  let rest
  try {
    const text = Buffer.from(zlib.zstdDecompressSync(buffer.subarray(first.start, first.end))).toString('utf8')
    const index = text.indexOf('\n')
    header = JSON.parse(index === -1 ? text : text.slice(0, index))
    rest = index === -1 ? '' : text.slice(index)
  } catch (error) {
    return { buffer, rewritten: false, reason: `cannot decode the header frame: ${messageOf(error)}` }
  }
  if (header?.type !== 'session' || typeof header.cwd !== 'string') {
    return { buffer, rewritten: false, reason: 'header has no cwd' }
  }
  if (header.cwd === newCwd) return { buffer, rewritten: false, header, reason: 'already-at-target' }
  const rebuilt = {}
  for (const [key, value] of Object.entries(header)) rebuilt[key] = key === 'cwd' ? newCwd : value
  // 后端要求第一帧的明文**恰好是一行、且以唯一一个 `\n` 结尾**（assertZstdHeaderFrame），
  // 少一个字节都会被判成 corrupt，所以 rest 为空时补回来。
  const body = JSON.stringify(rebuilt) + (rest === '' ? '\n' : rest)
  let frame
  try {
    frame = zlib.zstdCompressSync(Buffer.from(body, 'utf8'), CHECKSUM_OPTIONS)
  } catch (error) {
    return { buffer, rewritten: false, reason: `cannot re-compress the header frame: ${messageOf(error)}` }
  }
  return { buffer: Buffer.concat([frame, buffer.subarray(first.end)]), rewritten: true, header: rebuilt }
}

// ---------------------------------------------------------------------------
// 搬迁计划与落盘
// ---------------------------------------------------------------------------
/**
 * 找出这条会话的日志目录：先按 header 里的 cwd 推，推不到就扫全部项目目录。
 * @param {string} root 会话根。
 * @param {string} sessionId 会话 id。
 * @param {string | undefined} storedCwd header 里记着的 cwd。
 * @returns {string[]} 命中的会话目录。
 */
function locateSessionDirs(root, sessionId, storedCwd) {
  const segment = encodeSegment(sessionId)
  const found = []
  if (typeof storedCwd === 'string' && storedCwd !== '') {
    const guess = join(root, projectKey(storedCwd), segment)
    if (existsSync(guess)) found.push(guess)
  }
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, segment)
    if (found.includes(candidate) || !existsSync(candidate)) continue
    found.push(candidate)
  }
  return found
}

/**
 * 把日志里记录的旧工作区路径改写成新工作区路径。
 *
 * 只替换**确实跟着搬走了**的那些文件（调用方给出精确的前缀对），因此没命中的帧
 * 会**原样保留原来的字节**——这也是"搬一个文件不该动整份日志"的保证。
 *
 * @param {Buffer} buffer 会话日志。
 * @param {Array<[string, string]>} pairs 字面量替换对（已经按 JSON 转义处理过）。
 * @param {boolean} compressed 是否 zstd 帧日志。
 * @returns {{buffer: Buffer, frames: number, changed: number}}
 */
function rewriteLogPaths(buffer, pairs, compressed) {
  if (!Array.isArray(pairs) || pairs.length === 0) return { buffer, frames: 0, changed: 0 }
  if (compressed !== true) {
    let text = buffer.toString('utf8')
    for (const [needle, replacement] of pairs) text = text.split(needle).join(replacement)
    return { buffer: Buffer.from(text, 'utf8'), frames: 0, changed: pairs.length }
  }
  const scan = scanZstdFrames(buffer)
  if (scan.incomplete || scan.frames.length === 0) return { buffer, frames: 0, changed: 0 }
  const parts = []
  let changed = 0
  for (const frame of scan.frames) {
    const slice = buffer.subarray(frame.start, frame.end)
    let text
    try {
      text = Buffer.from(zlib.zstdDecompressSync(slice)).toString('utf8')
    } catch {
      parts.push(slice)
      continue
    }
    let next = text
    for (const [needle, replacement] of pairs) {
      if (next.includes(needle)) next = next.split(needle).join(replacement)
    }
    if (next === text) {
      parts.push(slice)
      continue
    }
    changed++
    parts.push(zlib.zstdCompressSync(Buffer.from(next, 'utf8'), CHECKSUM_OPTIONS))
  }
  return { buffer: Buffer.concat(parts), frames: scan.frames.length, changed }
}

/** 把 Windows 路径转成它在 JSON 文本里的样子（反斜杠翻倍）。 */
function jsonEscapedPath(path) {
  return path.split('\\').join('\\\\')
}

/**
 * 算一次搬迁的计划。**只读**，不写任何东西。
 * @param {{root: string, sessionId: string, toCwd: string}} options
 * @returns {object} 计划（含改写后的 buffer）。
 */
function planRelocate(options) {
  const { root, sessionId, toCwd } = options
  if (typeof root !== 'string' || root === '') throw new RelocateError(500, 'no-root', '无法确定会话根目录。')
  if (typeof toCwd !== 'string' || toCwd === '') throw new RelocateError(400, 'invalid-body', '缺少目标目录。')
  // 防御性：正常路径下 moveSession 已经把"同一个目录"处理成 attach-only，走不到这里。
  if (typeof options.fromCwd === 'string' && options.fromCwd !== '' && samePath(options.fromCwd, toCwd)) {
    throw new RelocateError(409, 'same-project-dir', '源与目标指向同一个目录。')
  }

  const dirs = locateSessionDirs(root, sessionId, options.fromCwd)
  if (dirs.length === 0) throw new RelocateError(409, 'session-not-stored', '这条会话还没有落盘（从未发送过消息），无法搬迁。')
  if (dirs.length > 1) {
    throw new RelocateError(409, 'duplicate-log', `这条会话在多个项目目录下都有日志，先手工清理再搬：${dirs.join(' | ')}`)
  }
  const sourceDir = dirs[0]
  const found = findGeneration(sourceDir)
  if (found.error !== undefined) throw new RelocateError(409, 'session-not-stored', found.error)
  if (found.all.length > 1) {
    throw new RelocateError(409, 'multiple-generations', `会话目录里有 ${found.all.length} 份历史格式日志，暂不支持一次搬多代：${sourceDir}`)
  }
  // 除日志与租约之外的杂项文件一律拒绝搬，避免把不认识的产物留在原地。
  const stray = found.others.filter((entry) => entry !== LEASE_NAME)
  if (stray.length > 0) {
    throw new RelocateError(409, 'session-dir-has-extras', `会话目录里还有其它文件，先确认再搬：${stray.join(', ')}`)
  }

  const generation = found.selected
  const sourcePath = join(sourceDir, generation.name)
  const buffer = readFileSync(sourcePath)
  const header = readHeaderFromBuffer(buffer, generation.compressed)
  if (header === undefined) throw new RelocateError(409, 'unreadable-header', `读不出会话头：${sourcePath}`)
  if (String(header.id) !== sessionId) {
    throw new RelocateError(409, 'id-mismatch', `会话头里的 id (${String(header.id)}) 与请求的 ${sessionId} 不一致。`)
  }
  const rewritten = rewriteHeaderCwd(buffer, toCwd, { compressed: generation.compressed })
  if (rewritten.rewritten !== true) {
    throw new RelocateError(500, 'rewrite-failed', `改写会话头的 cwd 失败：${rewritten.reason ?? 'unknown'}`)
  }

  const targetDir = join(root, projectKey(toCwd), encodeSegment(sessionId))
  if (targetDir === sourceDir) throw new RelocateError(409, 'same-project-dir', '源与目标落在同一个项目目录里。')
  const targetPath = join(targetDir, generation.name)
  if (existsSync(targetPath)) throw new RelocateError(409, 'target-exists', `目标位置已经有一份日志，拒绝覆盖：${targetPath}`)
  if (existsSync(join(targetDir, LEASE_NAME)) && existsSync(join(sourceDir, LEASE_NAME))) {
    throw new RelocateError(409, 'target-has-lease', `目标会话目录里已有写租约：${join(targetDir, LEASE_NAME)}`)
  }

  return {
    sessionId,
    fromCwd: String(header.cwd),
    toCwd,
    generation,
    sourceDir,
    sourcePath,
    targetDir,
    targetPath,
    lease: existsSync(join(sourceDir, LEASE_NAME)) ? join(sourceDir, LEASE_NAME) : null,
    bytesBefore: buffer.length,
    bytesAfter: rewritten.buffer.length,
    frameCount: generation.compressed ? scanZstdFrames(buffer).frames.length : null,
    header,
    buffer: rewritten.buffer,
  }
}

/** 写 + fsync：崩在中间也不会留下半个文件。 */
function writeDurable(path, buffer) {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, buffer, 0, buffer.length, 0)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 执行计划。
 *
 * 三步改名保证**任何时刻都不存在两份规范名日志**：
 *   1. 新日志先以临时名写进目标目录（此刻还不叫 generation，后端看不见它）；
 *   2. 源日志改名成非规范名（源目录里不再有 canonical 名）；
 *   3. 临时名改成规范名（此刻新日志才生效），随后删掉旧文件、搬走租约、清掉空目录。
 *
 * 崩在 2 与 3 之间时：旧数据在 `*.relocate-old`、新数据在 `*.relocate-tmp`，都还能人工救回来。
 * @param {object} plan {@link planRelocate} 的返回值。
 * @returns {object} 搬迁报告。
 */
function applyRelocate(plan) {
  const report = {
    sessionId: plan.sessionId,
    from: plan.fromCwd,
    to: plan.toCwd,
    generation: plan.generation.name,
    bytesBefore: plan.bytesBefore,
    bytesAfter: plan.bytesAfter,
    frames: plan.frameCount,
    sourcePath: plan.sourcePath,
    targetPath: plan.targetPath,
  }
  const tmpPath = plan.targetPath + '.relocate-tmp'
  const parkedPath = plan.sourcePath + '.relocate-old'
  mkdirSync(plan.targetDir, { recursive: true })
  writeDurable(tmpPath, plan.buffer)
  renameSync(plan.sourcePath, parkedPath)
  renameSync(tmpPath, plan.targetPath)
  rmSync(parkedPath, { force: true })

  if (plan.lease !== null) {
    try {
      renameSync(plan.lease, join(plan.targetDir, LEASE_NAME))
      report.leaseMoved = true
    } catch (error) {
      report.leaseMoveError = messageOf(error)
    }
  }

  try {
    if (readdirSync(plan.sourceDir).length === 0) {
      rmdirSync(plan.sourceDir)
      report.removedSourceDir = true
    }
  } catch (error) {
    report.sourceDirCleanupError = messageOf(error)
  }

  // 落盘后自己再读一遍：帧结构能解、header 已是新 cwd，才算真的搬成了。
  const after = readFileSync(plan.targetPath)
  const header = readHeaderFromBuffer(after, plan.generation.compressed)
  report.verifiedHeader = header === undefined
    ? null
    : { id: String(header.id), cwd: typeof header.cwd === 'string' ? header.cwd : null, version: header.version }
  report.verifiedBytes = after.length
  report.ok = report.verifiedHeader !== null && report.verifiedHeader.cwd === plan.toCwd
  return report
}

/**
 * 把日志里"确实已经搬走"的那些文件的路径改写成新工作区。
 *
 * 只动这些精确前缀，其它内容一个字节都不碰；改写后重新校一遍帧结构与头部。
 *
 * @param {string} targetPath 目标位置的日志文件。
 * @param {{compressed: boolean}} generation 该代际的编码方式。
 * @param {string} fromCwd 旧工作区目录。
 * @param {string} toCwd 新工作区目录。
 * @param {Array<{path: string}>} applied 已搬/已复制的文件（相对路径，正斜杠分隔）。
 * @returns {object} 改写报告。
 */
function rewriteSessionPaths(targetPath, generation, fromCwd, toCwd, applied) {
  const pairs = []
  for (const file of applied) {
    if (typeof file?.path !== 'string' || file.path === '') continue
    // 相对路径可能来自日志（正斜杠）或跳过记录（反斜杠），两种都按分隔符拆。
    const parts = file.path.split(/[\\/]+/).filter((part) => part !== '')
    if (parts.length === 0) continue
    const oldAbs = join(fromCwd, ...parts)
    const newAbs = join(toCwd, ...parts)
    // 同一路径在日志里可能是两层转义（普通字段）或四层（`arguments` 本身是 JSON 字符串），
    // 两种都要换，否则工具调用里记的路径会漏掉。
    pairs.push([jsonEscapedPath(oldAbs), jsonEscapedPath(newAbs)])
    pairs.push([jsonEscapedPath(jsonEscapedPath(oldAbs)), jsonEscapedPath(jsonEscapedPath(newAbs))])
    const oldFwd = oldAbs.split('\\').join('/')
    if (oldFwd !== oldAbs) pairs.push([oldFwd, newAbs.split('\\').join('/')])
  }
  if (pairs.length === 0) return { ok: true, changed: 0, frames: 0 }
  let buffer
  try {
    buffer = readFileSync(targetPath)
  } catch (error) {
    return { ok: false, error: messageOf(error), changed: 0 }
  }
  const result = rewriteLogPaths(buffer, pairs, generation.compressed)
  if (result.changed === 0) return { ok: true, changed: 0, frames: result.frames }
  try {
    const tmp = targetPath + '.rehome-paths'
    writeDurable(tmp, result.buffer)
    renameSync(tmp, targetPath)
  } catch (error) {
    return { ok: false, error: messageOf(error), changed: 0 }
  }
  const after = readFileSync(targetPath)
  const header = readHeaderFromBuffer(after, generation.compressed)
  const scan = scanZstdFrames(after)
  return {
    ok: header !== undefined && header.cwd === toCwd && scan.incomplete !== true,
    changed: result.changed,
    frames: scan.frames.length,
    bytes: after.length,
  }
}

// ---------------------------------------------------------------------------
// 内存态：让"以后继续写"落到新位置
// ---------------------------------------------------------------------------

/**
 * 把内存里三处记着旧 cwd 的地方一起改成新 cwd。
 *
 * 漏掉任何一处，下一次 append 都会算回旧路径、在最坏情况下写出第二份日志：
 *   1. 持久化写入句柄的 `header`（每次 append 都从它重新推路径）；
 *   2. 驻留会话对象自身的 `header`（工具与界面从它读 cwd）；
 *   3. 工作区注册表里的头部缓存（`registry.headers`）。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {string} sessionId 会话 id。
 * @param {string} cwd 新的 cwd。
 * @returns {{handle: boolean, live: boolean, registry: boolean}}
 */
function redirectMemory(ctx, sessionId, cwd) {
  const outcome = { handle: false, live: false, registry: false }
  const writers = ctx.sessionPersistence?.tracker?.writers
  const handle = writers instanceof Map ? writers.get(sessionId) : undefined
  if (handle !== undefined && handle !== null && typeof handle.header === 'object' && handle.header !== null) {
    handle.header = { ...handle.header, cwd }
    outcome.handle = true
  }
  let live
  try {
    live = ctx.get('sessions')?.get?.(sessionId)
  } catch {
    live = undefined
  }
  if (live !== undefined && typeof live.header === 'object' && live.header !== null) {
    live.header = { ...live.header, cwd }
    outcome.live = true
  }
  const registry = ctx.workspaceRegistry
  if (registry?.headers instanceof Map) {
    const cached = registry.headers.get(sessionId)
    if (cached !== undefined) {
      registry.headers.set(sessionId, { ...cached, cwd })
      outcome.registry = true
    }
  }
  return outcome
}

// ---------------------------------------------------------------------------
// 业务
// ---------------------------------------------------------------------------

/**
 * 搬一条会话到目标工作区。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {string} sessionId 会话 id。
 * @param {string} workspaceId 目标工作区 id。
 * @returns {Promise<object>} 报告。
 */
async function moveSession(ctx, sessionId, workspaceId, log = () => {}, fileMode = 'none') {
  const registry = ctx.workspaceRegistry
  const persistence = ctx.sessionPersistence
  const workspaces = registry.list()
  const target = workspaces.find((workspace) => String(workspace.id) === workspaceId)
  if (target === undefined) throw new RelocateError(404, 'workspace-not-found', `找不到工作区 ${workspaceId}。`)

  let targetIsDir = false
  try {
    targetIsDir = statSync(String(target.path)).isDirectory()
  } catch {
    targetIsDir = false
  }
  if (!targetIsDir) throw new RelocateError(409, 'workspace-missing', `目标工作区目录不存在：${String(target.path)}`)

  const header = await readStoredHeader(persistence, sessionId)
  if (header === undefined) throw new RelocateError(404, 'session-not-found', `读不到会话 ${sessionId} 的头部。`)
  if (header.origin === 'subagent' || Number(header.delegationDepth) > 0) {
    throw new RelocateError(409, 'subagent-session', '子代理会话不能单独搬。')
  }
  if (typeof header.cwd !== 'string' || header.cwd === '') {
    throw new RelocateError(409, 'no-cwd', '这条会话的头部没有记录 cwd，无法判断它属于哪里。')
  }

  if (agentRunning(ctx, sessionId)) {
    throw new RelocateError(409, 'session-running', '这条会话正在跑一轮，等它结束后再搬。')
  }

  const toCwd = String(target.path)
  const fromCwd = header.cwd
  const report = {
    sessionId,
    from: fromCwd,
    to: toCwd,
    workspace: { id: String(target.id), title: String(target.title) },
  }

  // 已经指向目标目录：只差一次归属修复（导入/旧工作区重建出来的会话就是这样）。
  if (samePath(fromCwd, toCwd)) {
    report.attachOnly = true
    report.note = '会话的 cwd 已经指向这个工作区，只补归属，不动日志。'
    const previous = ownerOf(workspaces, sessionId)
    // 同样是先 detach 再 attach：中间任何时候都不让这个 id 同时记在两个工作区里。
    if (previous !== undefined && String(previous.id) !== String(target.id)) {
      await previous.detachSession(sessionId)
      report.detachedFrom = String(previous.id)
    }
    await target.attachSession(sessionId)
    report.attachedTo = String(target.id)
    report.ok = true
    return report
  }

  const root = resolveRoot(persistence)
  // 先把写句柄里还没落盘的批次刷到**旧**文件里，再搬——否则那批数据会跟着被删的 inode 一起丢。
  await flushWriter(persistence, sessionId)
  const plan = planRelocate({ root, sessionId, toCwd, fromCwd })
  // 文件清单在搬之前算：日志字节刚刷过，是"搬走之前"的完整样子。
  const filePlan = fileMode === 'none' ? null : planFileMigration(ctx, sessionId, toCwd, fromCwd, plan.buffer)
  log('info', `relocating ${plan.sourcePath} -> ${plan.targetPath} (${plan.bytesBefore} -> ${plan.bytesAfter} bytes)`)
  const storage = applyRelocate(plan)
  report.storage = storage
  if (storage.ok !== true) {
    throw new RelocateError(500, 'verify-failed', `日志已搬到 ${plan.targetPath}，但回读的 header 不是新 cwd：${JSON.stringify(storage.verifiedHeader)}`, { storage })
  }

  // 内存态必须早于 attachSession：attachSession 会读"活着的"会话头去校验 cwd。
  report.memory = redirectMemory(ctx, sessionId, toCwd)

  // 注册表里缓存的是**旧** header（服务启动时索引一次，之后不重读磁盘），
  // 不重建索引的话 attachSession 会拿旧 cwd 去校验、直接报 "its cwd resolves to <旧路径>"。
  report.reindexed = await reindexHeaders(ctx)

  // 顺序很关键：**先 detach 再 attach**。反过来的话这个 id 会同时出现在两个工作区的
  // 记账表里，`validateStoredState` 会在下次启动时抛 "accounted by both" 直接起不来。
  const owner = ownerOf(workspaces, sessionId)
  if (owner !== undefined && String(owner.id) !== String(target.id)) {
    try {
      await owner.detachSession(sessionId)
      report.detachedFrom = String(owner.id)
    } catch (error) {
      report.detachError = messageOf(error)
    }
  }
  try {
    await target.attachSession(sessionId)
    report.attachedTo = String(target.id)
  } catch (error) {
    // 文件已经在目标目录、头也改了，把归属再塞回原工作区只会让它更不一致；
    // 直接如实报出来：会话现在是一条"未归入任何工作区"的会话，日志在目标目录里。
    throw new RelocateError(500, 'attach-failed', `日志已搬到 ${plan.targetPath}，但挂到工作区「${String(target.title)}」失败：${messageOf(error)}。会话目前未归入任何工作区，日志已在新位置。`, { report })
  }

  // 用 DSH 自己的读取器再确认一遍：它读得到、且 cwd 是新的，才算搬成。
  try {
    const readback = await readStoredHeader(persistence, sessionId)
    report.dshReadback = readback === undefined
      ? null
      : { cwd: typeof readback.cwd === 'string' ? readback.cwd : null }
  } catch (error) {
    report.dshReadbackError = messageOf(error)
  }

  // 会话已经在新工作区了，再动文件。顺序不能反：先搬文件后搬会话的话，
  // 会话一旦搬失败，文件就已经离开源工作区了。
  if (filePlan !== null) {
    report.files = applyFilePlan(filePlan, fileMode)
    report.files.skipped = filePlan.skipped
    report.files.discovered = filePlan.discovered
    report.files.sources = filePlan.sources
    log('info', `files (${fileMode}): discovered ${filePlan.discovered} (log ${filePlan.sources.log}, summary ${filePlan.sources.summary}); applied ${report.files.applied.length}, failed ${report.files.failed.length}, skipped ${filePlan.skipped.length}`)
    if (report.files.applied.length > 0) log('info', `  applied: ${report.files.applied.map((entry) => entry.path).join(', ')}`)
    if (filePlan.skipped.length > 0) log('info', `  skipped: ${filePlan.skipped.map((entry) => `${entry.path}(${entry.reason})`).join(', ')}`)

    // 文件跟着走了，会话里记录的路径也要跟着走——否则卡片和引用仍指向旧工作区。
    // 范围包含"目标里本来就有、这次只是跳过"的文件：它们的引用同样应该指向新工作区。
    const shipped = [
      ...report.files.applied,
      ...filePlan.skipped.filter((entry) => entry.reason === 'exists').map((entry) => ({ path: entry.path })),
    ]
    if (shipped.length > 0) {
      report.paths = rewriteSessionPaths(plan.targetPath, plan.generation, fromCwd, toCwd, shipped)
      log('info', `paths: ${report.paths.changed} frame(s) rewritten over ${shipped.length} file(s) ${report.paths.ok === true ? '(ok)' : `(FAILED: ${report.paths.error ?? 'verify failed'})`}`)
    }
  }

  // 让 agent 之后的相对路径解析落到新工作区：官方入口会记一条 `working-directory/change`，
  // 投影随之更新，下一轮的工具调用与提示词上下文都用新目录。
  report.workingDirectory = await setWorkingDirectory(ctx, sessionId, toCwd)
  log('info', `working directory: ${report.workingDirectory.applied === true ? 'set to ' + toCwd : 'not changed (' + report.workingDirectory.reason + ')'}`)

  report.ok = true
  return report
}

/**
 * 把正在使用的 agent 的工作目录切到新工作区。
 *
 * 光改 `header.cwd` 不够：`workingDirectory` 是**会话投影**，在会话打开时由
 * `init: header.cwd` 算出来并存住；不改它的话，之后工具解析相对路径仍然落在旧目录。
 * 官方入口 `ctx.workingDirectory.set(agent, path)` 会提交一条
 * `working-directory/change` 事件，投影与提示词上下文一起更新，并且可回放。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {string} sessionId 会话 id。
 * @param {string} cwd 新目录。
 * @returns {Promise<{applied: boolean, reason?: string}>}
 */
async function setWorkingDirectory(ctx, sessionId, cwd) {
  let agent
  try {
    agent = ctx.get?.('agents')?.get?.(sessionId)
  } catch {
    agent = undefined
  }
  if (agent === undefined || agent === null) return { applied: false, reason: 'session-has-no-agent' }
  const service = ctx.get?.('workingDirectory')
  if (service === undefined || typeof service.set !== 'function') return { applied: false, reason: 'working-directory-unavailable' }
  try {
    await service.set(agent, cwd)
    return { applied: true }
  } catch (error) {
    return { applied: false, reason: messageOf(error) }
  }
}

/** 安全地读一条会话的头部（先问后端，后端读不到就报 undefined）。 */
async function readStoredHeader(persistence, sessionId) {
  try {
    if (typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      if (snapshot?.header !== undefined) return snapshot.header
    }
  } catch {
    /* 退回 list() */
  }
  try {
    const snapshots = await persistence.list()
    const hit = snapshots.find((candidate) => String(candidate.header?.id) === sessionId)
    return hit?.header
  } catch {
    return undefined
  }
}

/** 会话根：后端自己暴露的 root 优先，其次 `$DSH_HOME/sessions`。 */
function resolveRoot(persistence) {
  if (typeof persistence?.root === 'string' && persistence.root !== '') return persistence.root
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 这条会话此刻是否正在跑一轮。 */
function agentRunning(ctx, sessionId) {
  try {
    const agent = ctx.get('agents')?.get?.(sessionId)
    return agent !== undefined && agent !== null && agent.status === 'running'
  } catch {
    return false
  }
}

/** 把写句柄缓冲的批次刷到磁盘。 */
async function flushWriter(persistence, sessionId) {
  const writers = persistence?.tracker?.writers
  const handle = writers instanceof Map ? writers.get(sessionId) : undefined
  if (handle !== undefined && handle !== null && typeof handle.flush === 'function') {
    try {
      await handle.flush()
    } catch (error) {
      throw new RelocateError(409, 'flush-failed', `会话还有没落盘的写入，刷新失败，为安全起见不搬：${messageOf(error)}`)
    }
  }
}

/**
 * 让工作区注册表重新从磁盘索引会话头。
 *
 * 注册表只在服务启动时索引一次，之后不再读盘。搬完不重建索引的话，`attachSession`
 * 会拿缓存里的**旧** cwd 去校验，直接报 "its cwd resolves to <旧路径>"。
 */
async function reindexHeaders(ctx) {
  const registry = ctx.workspaceRegistry
  if (typeof registry?.replaceHeaderIndex !== 'function' || typeof registry?.listStoredHeaders !== 'function') return false
  await registry.replaceHeaderIndex(await registry.listStoredHeaders())
  return true
}

/** 按"完整记账"找会话当前属于哪个工作区。 */
function ownerOf(workspaces, sessionId) {
  for (const workspace of workspaces) {
    const ids = workspace?.record?.sessionIds
    if (Array.isArray(ids) && ids.includes(sessionId)) return workspace
  }
  return undefined
}

/**
 * Windows 路径比较：两边都先 realpath 到真身，再统一分隔符与大小写。
 * 直接用字符串比会漏掉「同一目录的另一种写法」，而 header.cwd 必须是**规范拼写**
 * ——`projectKey` 是按原样字符串算的，拼写一变目录名就变，identity 校验会炸。
 */
function samePath(left, right) {
  const canon = (value) => {
    const text = String(value)
    try {
      return realpathSync.native(text).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
    } catch {
      return text.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
    }
  }
  return canon(left) === canon(right)
}

/** 错误消息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// 随迁文件：这个对话在工作区里改过哪些文件，要不要跟着走
// ---------------------------------------------------------------------------
//
// 两个来源，按可靠性排序：
//
//   1. **会话日志**（持久、主来源）：每次 `write` / `edit` 这类工具调用都会把目标
//      绝对路径写进日志，Host 重启、换天、重开都不影响。缺点是不含 shell 里顺手
//      创建的产物。
//   2. **`ctx.workspaceChanges` 的逐轮摘要**（补充）：git 工作树快照 + 文件工具
//      编辑前后的整文件副本，连 shell 改动都抓得到——但它只活在**当前 Host 进程**
//      里，随会话销毁消失。所以只能当补充，不能当唯一依据。
//
// 早先的版本只用 (2)，结果对"昨天干的活"几乎什么都列不出来，白搬一场。

/** 会改动文件的工具名（不同构建叫法不一，用前缀/后缀比较宽松地认）。 */
const MUTATING_FILE_TOOL = /(^|[^a-z])(write|edit|patch|create|replace|save)([^a-z]|$)/i

/**
 * 从会话日志里挖出这个对话碰过的文件路径。
 *
 * @param {Buffer} buffer 会话日志（可以是当前 generation 的完整内容）。
 * @returns {{paths: string[], toolCalls: number}}
 */
function extractFileTouches(buffer) {
  const paths = new Set()
  let toolCalls = 0
  const scan = scanZstdFrames(buffer)
  for (const frame of scan.frames) {
    let text
    try {
      text = Buffer.from(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end))).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      // 每个事件一行 JSON；先看首字符，避免对整行做无谓的 JSON.parse。
      if (line.charCodeAt(0) !== 0x7b) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
      toolCalls++
      const name = String(event.data?.name ?? event.data?.tool ?? event.data?.toolName ?? '')
      // 日志里的 `arguments` 是**字符串化的 JSON**（不是对象），两种形态都认。
      let args = event.data?.arguments ?? event.data?.args ?? event.data?.input
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          continue
        }
      }
      if (args === null || typeof args !== 'object') continue
      if (MUTATING_FILE_TOOL.test(name)) {
        const target = args.file_path ?? args.path ?? args.target ?? args.file
        if (typeof target === 'string' && target !== '') paths.add(target)
      }
      // 交付物声明（`present` 之类）：它列的就是"这个对话产出的文件"，往往还是**用
      // shell 脚本**生成的——那类文件不会被 write/edit 记录，只有这里能拿到。
      if (Array.isArray(args.files)) {
        for (const entry of args.files) {
          const declared = entry?.path ?? entry?.file_path
          if (typeof declared === 'string' && declared !== '') paths.add(declared)
        }
      }
    }
  }
  return { paths: [...paths], toolCalls }
}

/**
 * 平台逐轮摘要里的文件（只在会话存活于本进程时可用，仅作补充）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {string} sessionId 会话 id。
 * @returns {{available: boolean, turns: number, paths: string[]}}
 */
function collectSummaryFiles(ctx, sessionId) {
  let live
  try {
    live = ctx.get('sessions')?.get?.(sessionId)
  } catch {
    live = undefined
  }
  const changes = ctx.get?.('workspaceChanges')
  if (live === undefined || changes === undefined || typeof changes.summary !== 'function') {
    return { available: false, turns: 0, paths: [] }
  }
  const paths = []
  let turns = 0
  for (const event of Array.isArray(live.log) ? live.log : []) {
    if (event === null || typeof event !== 'object' || event.type !== 'workspace/changes') continue
    let summary
    try {
      summary = changes.summary(sessionId, event.seq)
    } catch {
      summary = undefined
    }
    if (summary === undefined || summary === null) continue
    turns++
    for (const file of Array.isArray(summary.files) ? summary.files : []) {
      if (typeof file?.path === 'string' && file.path !== '') paths.push(file.path)
    }
  }
  return { available: true, turns, paths }
}

/** `child` 是否等于 `root` 或位于其内（都要求已经 realpath 过）。 */
function isInside(root, child) {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 把一份路径清单分成"能带过去"和"跳过"两类。
 *
 * 规矩只有一条是硬性的：**只搬源工作区目录里、真实存在的普通文件，且目标从不覆盖**。
 * 越界（`..`、符号链接跳到别处）、缺失、目标已存在、过大、超配额，一律跳过并说明原因。
 *
 * @param {string[]} paths 变更记录里的路径（会话工作目录内是相对路径，否则是绝对路径）。
 * @param {string} sourceRoot 源工作区目录。
 * @param {string} targetRoot 目标工作区目录。
 * @returns {{included: object[], skipped: object[], totalBytes: number}}
 */
function classifyFiles(paths, sourceRoot, targetRoot) {
  const included = []
  const skipped = []
  const source = resolve(sourceRoot)
  const target = resolve(targetRoot)
  const seenAbs = new Set()
  let totalBytes = 0
  let realSource
  try {
    realSource = realpathSync.native(source)
  } catch {
    realSource = source
  }

  for (const raw of paths) {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(source, raw)
    // 同一文件可能被日志与交付物各报一次（一个绝对路径、一个相对路径），只算一次。
    // 查重必须放在"文件是否存在"之前，否则缺失的文件会被重复报。
    const absKey = abs.toLowerCase()
    if (seenAbs.has(absKey)) continue
    seenAbs.add(absKey)
    let stats
    try {
      stats = lstatSync(abs)
    } catch {
      skipped.push({ path: raw, reason: 'missing' })
      continue
    }
    if (!stats.isFile()) {
      skipped.push({ path: raw, reason: stats.isSymbolicLink() ? 'symlink' : 'not-file' })
      continue
    }
    let realAbs
    try {
      realAbs = realpathSync.native(abs)
    } catch {
      skipped.push({ path: raw, reason: 'missing' })
      continue
    }
    if (!isInside(realSource, realAbs)) {
      skipped.push({ path: raw, reason: 'outside' })
      continue
    }
    const rel = relative(realSource, realAbs)
    if (stats.size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: 'too-large' })
      continue
    }
    const targetAbs = resolve(target, rel)
    if (!isInside(target, targetAbs)) {
      skipped.push({ path: rel, reason: 'outside' })
      continue
    }
    if (existsSync(targetAbs)) {
      skipped.push({ path: rel, reason: 'exists' })
      continue
    }
    if (included.length >= MAX_FILES) {
      skipped.push({ path: rel, reason: 'limit' })
      continue
    }
    if (totalBytes + stats.size > MAX_TOTAL_BYTES) {
      skipped.push({ path: rel, reason: 'limit' })
      continue
    }
    totalBytes += stats.size
    included.push({ rel: rel.split('\\').join('/'), source: realAbs, target: targetAbs, bytes: stats.size })
  }
  return { included, skipped, totalBytes }
}

/**
 * 执行文件计划。
 *
 * 先 `COPYFILE_EXCL` 复制（目标已存在就报错，绝不覆盖），成功后才在原工作区删除源文件
 * ——所以 `move` 模式下每一步失败也不会丢数据。
 *
 * @param {{included: object[]}} plan {@link classifyFiles} 的结果。
 * @param {'copy' | 'move'} mode 复制还是移动。
 * @returns {{mode: string, applied: object[], failed: object[], bytes: number}}
 */
function applyFilePlan(plan, mode) {
  const applied = []
  const failed = []
  let bytes = 0
  for (const file of plan.included) {
    try {
      mkdirSync(dirname(file.target), { recursive: true })
      copyFileSync(file.source, file.target, fsConstants.COPYFILE_EXCL)
    } catch (error) {
      failed.push({ path: file.rel, reason: messageOf(error) })
      continue
    }
    if (mode === 'move') {
      try {
        rmSync(file.source, { force: true })
      } catch (error) {
        failed.push({ path: file.rel, reason: `已复制到新工作区，但删除原文件失败：${messageOf(error)}` })
        continue
      }
    }
    applied.push({ path: file.rel, bytes: file.bytes })
    bytes += file.bytes
  }
  return { mode, applied, failed, bytes }
}

/**
 * 读一条会话当前 generation 的完整字节（预览时要解析里面的工具调用）。
 *
 * @param {string} root 会话根。
 * @param {string} sessionId 会话 id。
 * @param {string | undefined} storedCwd 头部里记着的 cwd。
 * @returns {Buffer | undefined}
 */
function readSessionLogBuffer(root, sessionId, storedCwd) {
  const dirs = locateSessionDirs(root, sessionId, storedCwd)
  if (dirs.length !== 1) return undefined
  const found = findGeneration(dirs[0])
  if (found.error !== undefined) return undefined
  try {
    return readFileSync(join(dirs[0], found.selected.name))
  } catch {
    return undefined
  }
}

/**
 * 算一份"随迁文件"计划（只读）。
 *
 * 日志与内存摘要合并取并集：日志覆盖整段历史，摘要补上 shell / git 层面的改动。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {string} sessionId 会话 id。
 * @param {string} targetRoot 目标工作区目录。
 * @param {string} sourceRoot 会话当前 cwd（源工作区目录）。
 * @param {Buffer | undefined} buffer 会话日志字节；给了才会解析工具调用。
 * @returns {object} 预览（含 `included` 供执行用）。
 */
function planFileMigration(ctx, sessionId, targetRoot, sourceRoot, buffer) {
  const fromLog = buffer === undefined ? [] : extractFileTouches(buffer).paths
  const summary = collectSummaryFiles(ctx, sessionId)
  const seen = new Set()
  for (const path of [...fromLog, ...summary.paths]) {
    if (typeof path === 'string' && path !== '') seen.add(path)
  }
  const files = [...seen]
  const classified = classifyFiles(files, sourceRoot, targetRoot)
  return {
    available: true,
    discovered: files.length,
    sources: { log: fromLog.length, summary: summary.turns },
    source: sourceRoot,
    target: targetRoot,
    preview: classified.included.map((file) => ({ path: file.rel, bytes: file.bytes })),
    skipped: classified.skipped,
    totalBytes: classified.totalBytes,
    included: classified.included,
  }
}

/**
 * 纯函数、小工具，以及编排入口 `moveSession`，供离线自测（`node --test` / 手工脚本）
 * 直接调用。不参与 Host 行为，改它们不影响插件的对外契约。
 */
export const internals = {
  encodeSegment,
  projectKey,
  findGeneration,
  scanZstdFrames,
  readHeaderFromBuffer,
  rewriteHeaderCwd,
  rewriteLogPaths,
  planRelocate,
  applyRelocate,
  classifyFiles,
  applyFilePlan,
  extractFileTouches,
  moveSession,
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 插件自己的排障日志：`$DSH_HOME/logs/session-rehome.log`，一行一件事。
 * 搬迁是改用户数据的事，出问题时最需要的就是"它当时到底做了什么"。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {(level: string, text: string) => void}
 */
function createLog(ctx) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'logs', 'session-rehome.log')
  return (level, text) => {
    const line = `[${new Date().toISOString()}] ${level} ${text}\n`
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line, 'utf8')
    } catch {
      /* 日志写不进去不能影响搬迁 */
    }
    try {
      ctx.logger?.[level]?.(`session-rehome: ${text}`)
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 浏览器半边有没有被 client-modules 收进去。
 *
 * 这个值只能从进程里问出来：bundle 是按带 `?rev=` 的精确 URL 供应的，从外面随便
 * 请求一个 `/plugins/...` 路径拿到的 404 说明不了任何问题。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string}
 */
function clientRowState(ctx) {
  try {
    const modules = ctx.get('clientModules')
    const table = modules?.table
    if (!(table instanceof Map)) return 'clientModules-unavailable'
    const row = table.get('dsh-session-rehome')
    if (row === undefined) return 'not-registered'
    return `registered rev=${String(row.entry?.rev ?? '?')}`
  } catch (error) {
    return `error: ${messageOf(error)}`
  }
}

/**
 * 登记端点。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 */
export function apply(ctx) {
  const log = createLog(ctx)
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: (request, response) => serveMove(ctx, request, response, log),
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: WORKSPACES_ENDPOINT,
      handler: (request, response) => serveWorkspaces(ctx, request, response),
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: FILE_PLAN_ENDPOINT,
      handler: (request, response) => serveFilePlan(ctx, request, response),
    }),
  )
  log('info', `mounted; client bundle: ${clientRowState(ctx)}; workspaceChanges: ${ctx.get?.('workspaceChanges') === undefined ? 'absent' : 'present'}`)
}

/**
 * 回答一次"随迁文件"预览请求。
 *
 * 只回预览，什么都不改：真正执行在 `/move` 里，而且服务端会重新算一遍——客户端
 * 传回的清单不可信，路径必须由服务端从变更记录重新推导并做越界检查。
 */
async function serveFilePlan(ctx, request, response) {
  try {
    if (request.method !== 'POST') {
      respond(response, 405, failure('method-not-allowed', '文件预览用 POST。'))
      return
    }
    if (!admitOwner(ctx, request, response)) return
    let body
    try {
      body = await readJsonBody(request)
    } catch {
      respond(response, 400, failure('invalid-body', '请求体不是合法 JSON。'))
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, failure('invalid-body', '请求体必须是 JSON 对象。'))
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (sessionId === '' || workspaceId === '') {
      respond(response, 400, failure('invalid-body', 'sessionId 与 workspaceId 都必填。'))
      return
    }
    const target = ctx.workspaceRegistry.list().find((workspace) => String(workspace.id) === workspaceId)
    if (target === undefined) {
      respond(response, 404, failure('workspace-not-found', `找不到工作区 ${workspaceId}。`))
      return
    }
    const header = await readStoredHeader(ctx.sessionPersistence, sessionId)
    if (header === undefined) {
      respond(response, 404, failure('session-not-found', `读不到会话 ${sessionId} 的头部。`))
      return
    }
    if (typeof header.cwd !== 'string' || header.cwd === '') {
      respond(response, 409, failure('no-cwd', '这条会话的头部没有记录 cwd。'))
      return
    }
    if (samePath(header.cwd, String(target.path))) {
      respond(response, 200, { ok: true, available: false, reason: 'already-there', files: [], skipped: [], totalBytes: 0 })
      return
    }
    const root = resolveRoot(ctx.sessionPersistence)
    const buffer = readSessionLogBuffer(root, sessionId, header.cwd)
    const plan = planFileMigration(ctx, sessionId, String(target.path), header.cwd, buffer)
    respond(response, 200, {
      ok: true,
      available: plan.available,
      discovered: plan.discovered,
      sources: plan.sources,
      files: plan.preview,
      skipped: plan.skipped,
      totalBytes: plan.totalBytes,
    })
  } catch (error) {
    respond(response, 500, failure('plan-failed', `预览失败：${messageOf(error)}`))
  }
}

/**
 * 回答一次工作区列表请求。
 *
 * 浏览器半边刻意不依赖 sidebar 那几个 slot 的隐式 props 去拿工作区：那些 prop 谁
 * 提供、叫什么，都是别的包内部的事，换个构建就可能没有。多一个 GET 换来对话框
 * 自给自足，值。
 */
async function serveWorkspaces(ctx, request, response) {
  try {
    if (request.method !== 'GET') {
      respond(response, 405, failure('method-not-allowed', '工作区列表用 GET。'))
      return
    }
    if (!admitOwner(ctx, request, response, 'GET')) return
    const workspaces = ctx.workspaceRegistry.list().map((workspace) => ({
      id: String(workspace.id),
      title: String(workspace.title),
      path: String(workspace.path),
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
    }))
    respond(response, 200, { ok: true, workspaces })
  } catch (error) {
    respond(response, 500, failure('list-failed', `读取工作区失败：${messageOf(error)}`))
  }
}

/** 回答一次搬迁请求。 */
async function serveMove(ctx, request, response, log) {
  try {
    if (request.method !== 'POST') {
      respond(response, 405, failure('method-not-allowed', '搬迁请求必须是 POST。'))
      return
    }
    if (!admitOwner(ctx, request, response)) return
    let body
    try {
      body = await readJsonBody(request)
    } catch {
      respond(response, 400, failure('invalid-body', '请求体不是合法 JSON。'))
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, failure('invalid-body', '请求体必须是 JSON 对象。'))
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (sessionId === '' || workspaceId === '') {
      respond(response, 400, failure('invalid-body', 'sessionId 与 workspaceId 都必填。'))
      return
    }
    const fileMode = body.files === 'copy' || body.files === 'move' ? body.files : 'none'
    const report = await moveSession(ctx, sessionId, workspaceId, log, fileMode)
    log('info', `moved ${sessionId}: ${report.from} -> ${report.to}${report.attachOnly === true ? ' (attach only)' : ''}`)
    respond(response, 200, { ok: true, ...report })
  } catch (error) {
    if (error instanceof RelocateError) {
      log('warn', `refused ${String(request.url)}: ${error.code} ${error.message}`)
      respond(response, error.status, failure(error.code, error.message, error.details))
      return
    }
    log('error', `unexpected failure: ${messageOf(error)}`)
    respond(response, 500, failure('move-failed', `搬迁失败：${messageOf(error)}`))
  }
}

/**
 * 放行一次 owner 发起、同源的请求；拒绝时自己写好响应。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {'POST' | 'GET'} [method] 传 GET 时跳过 JSON content-type 检查。
 * @returns {boolean} 是否继续处理。
 */
function admitOwner(ctx, request, response, method = 'POST') {
  const admission = ctx.connection.admit(request)
  if ('rejection' in admission) {
    const status = admission.rejection
    respond(response, status, failure(status === 401 ? 'unauthorized' : 'forbidden', status === 401 ? '这个浏览器没有登录。' : '这个调用方不允许改会话。'))
    return false
  }
  if (admission.peer?.principal?.kind !== 'owner') {
    respond(response, 403, failure('forbidden', '只有 owner 能移动会话。'))
    return false
  }
  if (method === 'GET') return true
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    respond(response, 415, failure('unsupported-media-type', '请求必须是 JSON。'))
    return false
  }
  return true
}

/** 读一个限额内的 JSON 请求体。 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/** 统一的失败体。 */
function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details }
}

/** 写一份 JSON 响应。 */
function respond(response, status, body) {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(text)
}
