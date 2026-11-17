/**
 * 随迁文件的自测：合成目录，不碰任何真实工作区。
 *
 *   node test/files.test.mjs
 *
 * 重点是不变量，不是实现细节：
 *   - 只接受源工作区内部、真实存在的普通文件（`..`、绝对路径越界、符号链接一律拒绝）；
 *   - 目标已存在时**绝不覆盖**；
 *   - `copy` 保留源文件，`move` 在复制成功之后才删源；
 *   - 目标父目录按需创建。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const { internals } = await import(new URL('../index.js', import.meta.url).href)
const { classifyFiles, applyFilePlan, extractFileTouches } = internals

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const world = mkdtempSync(join(tmpdir(), 'rehome-files-'))
const source = join(world, 'alpha')
const target = join(world, 'beta')
mkdirSync(join(source, 'reports'), { recursive: true })
mkdirSync(target, { recursive: true })

writeFileSync(join(source, 'notes.md'), 'hello')          // 目标里已存在同名文件
writeFileSync(join(source, 'second.txt'), 'two')         // 正常可带走
writeFileSync(join(source, 'reports', 'r1.txt'), 'roll-up')
writeFileSync(join(world, 'outside.txt'), 'nope')

// 目标里已经有一份同名文件：必须原样保留，且被标成 exists。
writeFileSync(join(target, 'notes.md'), 'ORIGINAL')

let symlinkOk = false
try {
  symlinkSync(join(world, 'outside.txt'), join(source, 'link.txt'))
  symlinkOk = true
} catch {
  symlinkOk = false
}

const paths = [
  'notes.md',
  'second.txt',
  'reports/r1.txt',
  'reports/gone.txt',
  '../outside.txt',
  join(world, 'outside.txt'),
  ...(symlinkOk ? ['link.txt'] : []),
]

const plan = classifyFiles(paths, source, target)
const rels = plan.included.map((file) => file.rel)

check('includes both bringable files', rels.length === 2 && rels.includes('second.txt') && rels.includes('reports/r1.txt'), rels.join(','))
check('does not include the target-existing file', !rels.includes('notes.md'))
check('records byte size', plan.included.find((f) => f.rel === 'reports/r1.txt')?.bytes === 7, String(plan.included.find((f) => f.rel === 'reports/r1.txt')?.bytes))
check('does not include the missing file', !rels.includes('reports/gone.txt'))
check('does not include anything outside the workspace', !plan.included.some((f) => f.source.toLowerCase().includes('outside')))
check('does not include the symlink', !rels.includes('link.txt'))

const reasons = Object.fromEntries(plan.skipped.map((entry) => [entry.path.replace(/\\/g, '/'), entry.reason]))
check('missing file is skipped as missing', reasons['reports/gone.txt'] === 'missing', JSON.stringify(reasons))
check('target-existing file is skipped as exists', reasons['notes.md'] === 'exists')
check('parent-relative path is skipped as outside', reasons['../outside.txt'] === 'outside')
// 相对写法与它解析后的绝对路径是同一个文件，只报一次。
check('the same file is reported once even from two spellings', plan.skipped.filter((entry) => entry.reason === 'outside').length === 1, JSON.stringify(plan.skipped))
check('skipped target file keeps its content', readFileSync(join(target, 'notes.md'), 'utf8') === 'ORIGINAL')

// ---- copy 模式：源文件保留 ------------------------------------------------
const copied = applyFilePlan(plan, 'copy')
check('copy applied both files', copied.applied.length === 2, JSON.stringify(copied.applied))
check('copy created the nested target directory', existsSync(join(target, 'reports', 'r1.txt')))
check('copy wrote the right content', readFileSync(join(target, 'reports', 'r1.txt'), 'utf8') === 'roll-up')
check('copy left the source in place', existsSync(join(source, 'reports', 'r1.txt')))
check('copy reported zero failures', copied.failed.length === 0)
check('copy did not touch the pre-existing target file', readFileSync(join(target, 'notes.md'), 'utf8') === 'ORIGINAL')

// ---- move 模式：复制成功后才删源 ------------------------------------------
rmSync(join(target, 'reports'), { recursive: true, force: true })
rmSync(join(target, 'second.txt'), { force: true })
const moved = applyFilePlan(plan, 'move')
check('move applied both files', moved.applied.length === 2, JSON.stringify(moved.applied))
check('move deleted the source files', !existsSync(join(source, 'reports', 'r1.txt')) && !existsSync(join(source, 'second.txt')))
check('move wrote the content to the target', readFileSync(join(target, 'reports', 'r1.txt'), 'utf8') === 'roll-up')
check('move kept the pre-existing target file untouched', readFileSync(join(target, 'notes.md'), 'utf8') === 'ORIGINAL')

// ---- 目录不会被当成文件 ---------------------------------------------------
mkdirSync(join(source, 'adir'), { recursive: true })
const withDir = classifyFiles(['adir'], source, target)
check('a directory is skipped', withDir.included.length === 0 && withDir.skipped[0]?.reason === 'not-file')

// ---- 目标父目录不存在时能被创建 ------------------------------------------
mkdirSync(join(source, 'deep', 'a'), { recursive: true })
writeFileSync(join(source, 'deep', 'a', 'b.txt'), 'x')
const deep = classifyFiles(['deep/a/b.txt'], source, target)
const deepApplied = applyFilePlan(deep, 'copy')
check('nested parent directories are created', deepApplied.applied.length === 1 && existsSync(join(target, 'deep', 'a', 'b.txt')))

// ---- 从会话日志里挖文件路径（持久来源，冷会话也管用） --------------------
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
const logLine = (event) => frame(JSON.stringify(event) + '\n')

const sessionLog = Buffer.concat([
  logLine({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'D:\\work\\alpha', isSeeded: false, delegationDepth: 0 }),
  // 真实日志里 arguments 是字符串化的 JSON
  logLine({ type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: 'D:\\work\\alpha\\a.txt' }) } }),
  // 对象形态也要认
  logLine({ type: 'tool/call', seq: 2, data: { name: 'edit', arguments: { file_path: 'D:\\work\\alpha\\b.txt' } } }),
  // str_replace_editor 用的是 path
  logLine({ type: 'tool/call', seq: 3, data: { name: 'str_replace_editor', arguments: JSON.stringify({ path: 'D:\\work\\alpha\\c.txt' }) } }),
  // 读文件不算"产生文件"
  logLine({ type: 'tool/call', seq: 4, data: { name: 'read', arguments: JSON.stringify({ file_path: 'D:\\work\\alpha\\read-only.txt' }) } }),
  // 非文件类工具忽略
  logLine({ type: 'tool/call', seq: 5, data: { name: 'pwsh', arguments: JSON.stringify({ command: 'ls' }) } }),
  // 交付物声明：往往指向用 shell 脚本生成、write/edit 记录不到的文件
  logLine({ type: 'tool/call', seq: 6, data: { name: 'present', arguments: JSON.stringify({ files: [{ path: 'd.md' }, { path: 'scripts/e.py' }] }) } }),
  logLine({ type: 'turn/end', seq: 7, data: {} }),
])

const touches = extractFileTouches(sessionLog)
const found = touches.paths.map((path) => path.toLowerCase())

check('log scan counts every tool call', touches.toolCalls === 6, String(touches.toolCalls))
check('log scan finds the write target', found.some((path) => path.endsWith('a.txt')))
check('log scan handles object-shaped arguments', found.some((path) => path.endsWith('b.txt')))
check('log scan reads the `path` key too', found.some((path) => path.endsWith('c.txt')))
check('log scan ignores read-only tools', !found.some((path) => path.endsWith('read-only.txt')))
check('log scan picks up delivered files', found.includes('d.md') && found.includes('scripts/e.py'), found.join(','))
check('log scan yields exactly five paths', touches.paths.length === 5, String(touches.paths.length))

rmSync(world, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
