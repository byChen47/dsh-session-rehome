/**
 * 搬迁核心的自测。不依赖任何用户数据，全部现场合成：
 * 造一份"header 帧 + 若干事件帧"的日志，跑一遍 plan/apply，检查不变量。
 *
 *   node test/relocate.test.mjs
 *
 * 检查的重点是**不变量**，不是实现细节：
 *   - 只重压第一帧，后面每个事件帧逐字节不变；
 *   - 第一帧明文恰好一行、以单个换行结尾（后端有这条硬校验）；
 *   - header 除 cwd 外一个字段都不多不少、顺序不变（后端是封闭键集）；
 *   - 落盘后目录名 == projectKey(header.cwd)（后端每次列举都会交叉校验这两者）；
 *   - 任何时刻不存在两份规范名日志。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const here = new URL('../index.js', import.meta.url)
const { internals } = await import(here.href)
const { encodeSegment, projectKey, scanZstdFrames, readHeaderFromBuffer, planRelocate, applyRelocate } = internals

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM)

// ---- 合成一份真实形态的日志 ------------------------------------------------
const FROM = 'D:\\work\\alpha'
const TO = 'D:\\work\\beta'
const ID = 'session-11111111-2222-3333-4444-555555555555'
const header = {
  type: 'session',
  version: 4,
  id: ID,
  createdAt: 1794298942692,
  cwd: FROM,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}
const events = [
  JSON.stringify({ type: 'session/title', data: { title: 'hello' } }),
  JSON.stringify({ type: 'turn/start', data: {} }),
  JSON.stringify({ type: 'turn/end', data: {} }),
]
const original = Buffer.concat([frame(JSON.stringify(header) + '\n'), ...events.map((line) => frame(line + '\n'))])

const root = mkdtempSync(join(tmpdir(), 'relocate-'))
const sourceDir = join(root, projectKey(FROM), encodeSegment(ID))
mkdirSync(sourceDir, { recursive: true })
writeFileSync(join(sourceDir, 'session.v4.jsonl.zstd'), original)

// ---- 命名规则 -------------------------------------------------------------
check('projectKey folds separators into one dash', projectKey(FROM) === '--D-work-alpha--', projectKey(FROM))
check('projectKey keeps a plain id untouched', encodeSegment(ID) === ID)

const beforeFrames = scanZstdFrames(original)
check('synthetic log has 4 frames', beforeFrames.frames.length === 4 && beforeFrames.incomplete === false, String(beforeFrames.frames.length))
check('header reads back', readHeaderFromBuffer(original, true)?.cwd === FROM)

// ---- 计划 ----------------------------------------------------------------
const plan = planRelocate({ root, sessionId: ID, toCwd: TO, fromCwd: FROM })
check('target dir derives from the target cwd', plan.targetDir === join(root, projectKey(TO), encodeSegment(ID)))

const afterFrames = scanZstdFrames(plan.buffer)
check('frame count unchanged', afterFrames.frames.length === 4)
check('every frame after the header is byte-identical', original.subarray(beforeFrames.frames[0].end).equals(plan.buffer.subarray(afterFrames.frames[0].end)))

const headerText = Buffer.from(zlib.zstdDecompressSync(plan.buffer.subarray(0, afterFrames.frames[0].end))).toString('utf8')
check('header frame is exactly one newline-terminated line', headerText.endsWith('\n') && headerText.indexOf('\n') === headerText.length - 1)
const rewritten = JSON.parse(headerText.trimEnd())
check('cwd rewritten', rewritten.cwd === TO, rewritten.cwd)
check('no key added or dropped', Object.keys(rewritten).join(',') === Object.keys(header).join(','), Object.keys(rewritten).join(','))
check('other fields untouched', Object.entries(header).every(([key, value]) => key === 'cwd' || rewritten[key] === value))

// ---- 落盘 ----------------------------------------------------------------
const report = applyRelocate(plan)
check('apply verified the readback', report.ok === true)
check('target log exists, source dir gone', existsSync(plan.targetPath) && !existsSync(plan.sourceDir))
check('moved bytes equal the planned bytes', readFileSync(plan.targetPath).equals(plan.buffer))
check('no temp or parked leftovers', readdirSync(plan.targetDir).every((name) => !name.includes('.relocate-')))
check('dir name still matches projectKey(header.cwd)', join(root, projectKey(readHeaderFromBuffer(readFileSync(plan.targetPath), true).cwd), encodeSegment(ID)) === plan.targetDir)

// ---- 拒绝条件 ------------------------------------------------------------
const refuse = (fn) => {
  try {
    fn()
    return 'no-error'
  } catch (error) {
    return error.code ?? error.message
  }
}
check('refuses when the id exists in two project dirs', (() => {
  const dup = join(root, projectKey(FROM), encodeSegment(ID))
  mkdirSync(dup, { recursive: true })
  writeFileSync(join(dup, 'session.v4.jsonl.zstd'), plan.buffer)
  return refuse(() => planRelocate({ root, sessionId: ID, toCwd: TO, fromCwd: FROM })) === 'duplicate-log'
})())
rmSync(join(root, projectKey(FROM)), { recursive: true, force: true })

check('refuses identical source and target', refuse(() => planRelocate({ root, sessionId: ID, toCwd: TO, fromCwd: TO })) === 'same-project-dir')
check('refuses an unknown session', refuse(() => planRelocate({ root, sessionId: 'session-nope', toCwd: FROM })) === 'session-not-stored')

// 同一 id 出现在两个项目目录时会先撞上 duplicate-log（这个守卫比"目标已存在"更早），
// 而且不许覆盖目标位置已有的那份日志。
const collision = join(root, projectKey(FROM), encodeSegment(ID))
mkdirSync(collision, { recursive: true })
writeFileSync(join(collision, 'session.v4.jsonl.zstd'), plan.buffer)
const collided = join(root, projectKey(TO), encodeSegment(ID))
check('never overwrites the existing target log', (() => {
  const before = readFileSync(join(collided, 'session.v4.jsonl.zstd'))
  const code = refuse(() => planRelocate({ root, sessionId: ID, toCwd: TO, fromCwd: FROM }))
  return code === 'duplicate-log' && readFileSync(join(collided, 'session.v4.jsonl.zstd')).equals(before)
})())

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
