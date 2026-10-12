#!/usr/bin/env node
// map — keep map.json honest. Usage:
//   node tools/map/cli.mjs check [--fix] [--public]      validate map.json against the code
//   node tools/map/cli.mjs touched [--base origin/main]  what your branch changed that the map may need to know
//   node tools/map/cli.mjs diff [--base origin/main]     map changes vs base (what reviewers will see)
//   node tools/map/cli.mjs init                          write a starter map.json from the folder layout
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { check, diff, summarize, journeysTouched, parseOpenapiOps, flatten } from "./mapcore.mjs"

const args = process.argv.slice(2)
const cmd = args[0] || "check"
const flag = (f) => args.includes(f)
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch { return null } }
const root = git("rev-parse", "--show-toplevel") || process.cwd()
const mapPath = resolve(root, opt("--file", "map.json"))
const tty = process.stdout.isTTY, paint = (c) => (s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : String(s))
const red = paint(31), yel = paint(33), grn = paint(32), dim = paint(2)

function readRepoFile(p) {
  const f = join(root, p)
  if (!existsSync(f)) return null
  return statSync(f).isDirectory() ? "" : readFileSync(f, "utf8")
}
function loadMap(text, where) {
  try { return JSON.parse(text) } catch (e) { console.error(red(`${where}: not valid JSON: ${e.message}`)); process.exit(1) }
}
function opsFor(map) {
  if (!map.openapi) return null
  const t = readRepoFile(map.openapi)
  if (t === null) { console.error(red(`openapi file ${map.openapi} not found`)); return new Set() }
  return parseOpenapiOps(t)
}
function baseRef() {
  const b = opt("--base", null)
  if (b) return b
  for (const r of ["origin/main", "origin/master", "main", "master"]) if (git("rev-parse", "--verify", "-q", r)) return r
  return null
}
function mapAt(ref) {
  const t = git("show", `${ref}:map.json`)
  return t ? JSON.parse(t) : null
}

if (cmd === "check") {
  if (!existsSync(mapPath)) { console.error(red("map.json not found. Run: node tools/map/cli.mjs init")); process.exit(1) }
  const map = loadMap(readFileSync(mapPath, "utf8"), "map.json")
  const pub = flag("--public") || map.visibility === "public"
  let issues = check(map, { public: pub, openapiOps: opsFor(map), readFile: flag("--no-files") ? undefined : readRepoFile })
  if (flag("--fix")) {
    let fixed = 0
    for (const i of issues) {
      const m = /^code\[(\d+)\]\.lines$/.exec(i.path)
      if (m && i.fix) { map.code[+m[1]].lines = i.fix.lines; fixed++ }
    }
    if (fixed) {
      writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n")
      console.log(grn(`fixed ${fixed} line range${fixed === 1 ? "" : "s"}`))
      issues = check(map, { public: pub, openapiOps: opsFor(map), readFile: readRepoFile })
    }
  }
  const errs = issues.filter((i) => i.level === "error"), warns = issues.filter((i) => i.level === "warning")
  for (const i of errs) console.log(`${red("error")}   ${i.path || "map"}  ${i.message}${i.fix ? dim("  (--fix can update this)") : ""}`)
  for (const i of warns) console.log(`${yel("warning")} ${i.path || "map"}  ${i.message}`)
  const items = flatten(map)
  const count = (t) => items.filter((i) => i.type === t).length
  console.log(`${errs.length ? red("✗") : grn("✓")} map.json ${dim(`(${count("building")} buildings, ${count("connection")} connections, ${count("code")} code, ${count("journey")} journeys${pub ? ", public rules" : ""})`)}`)
  process.exit(errs.length ? 1 : 0)
}

if (cmd === "diff") {
  let a, b
  if (args[1] && !args[1].startsWith("--")) { a = loadMap(readFileSync(args[1], "utf8"), args[1]); b = loadMap(readFileSync(args[2], "utf8"), args[2]) }
  else { const ref = baseRef(); a = ref ? mapAt(ref) : null; b = loadMap(readFileSync(mapPath, "utf8"), "map.json") }
  const ch = diff(a, b)
  for (const c of ch.filter((c) => c.type !== "step")) {
    const sign = c.change === "added" ? grn("+") : c.change === "removed" ? red("−") : yel("~")
    console.log(`${sign} ${c.type.padEnd(10)} ${c.id}${c.fields.length ? dim("  " + c.fields.join(", ")) : ""}`)
  }
  const steps = ch.filter((c) => c.type === "step").length
  if (steps) console.log(dim(`  ${steps} journey step${steps === 1 ? "" : "s"} edited`))
  console.log(summarize(ch, journeysTouched(b, ch)))
  process.exit(0)
}

if (cmd === "touched") {
  const ref = baseRef()
  if (!ref) { console.error(red("no base branch found; pass --base <ref>")); process.exit(1) }
  const mb = git("merge-base", ref, "HEAD") || ref
  const files = [...new Set([...(git("diff", "--name-only", mb) || "").split("\n"), ...(git("ls-files", "--others", "--exclude-standard") || "").split("\n")].filter(Boolean))]
  const map = existsSync(mapPath) ? loadMap(readFileSync(mapPath, "utf8"), "map.json") : { buildings: [], code: [] }
  const under = (f, p) => p && (f === p || f.startsWith(p.replace(/\/?$/, "/")))
  const hitB = new Map(), hitK = [], loose = []
  for (const f of files) {
    if (f === "map.json") continue
    const b = (map.buildings || []).filter((b) => under(f, b.path)).sort((x, y) => y.path.length - x.path.length)[0]
    if (b) hitB.set(b.id, [...(hitB.get(b.id) || []), f]); else if (!/(^|\/)(test|tests|__tests__|docs?)\/|\.(md|lock)$|^\./.test(f)) loose.push(f)
    for (const k of map.code || []) if (k.path === f) hitK.push(k)
  }
  console.log(files.includes("map.json") ? grn("map.json is changed on this branch") : yel("map.json is NOT changed on this branch"))
  for (const [id, fs] of hitB) console.log(`building ${id}: ${fs.length} file${fs.length === 1 ? "" : "s"} changed ${dim(fs.slice(0, 4).join(", ") + (fs.length > 4 ? ", …" : ""))}`)
  for (const k of hitK) console.log(`code ${k.id}: ${k.path} changed ${dim("— check summary, calls and lines")}`)
  if (loose.length) console.log(yel(`not covered by any building: ${loose.slice(0, 8).join(", ")}${loose.length > 8 ? ", …" : ""}`))
  console.log(dim("Update map.json if any of these changed what a building does, what it talks to, or how a journey runs. Then run: node tools/map/cli.mjs check"))
  process.exit(0)
}

if (cmd === "init") {
  if (existsSync(mapPath)) { console.error(yel("map.json already exists")); process.exit(1) }
  const kindOf = (dir) => /worker|job|cron/.test(dir) ? "worker" : /web|app|cli|site|ui/.test(dir) ? "app" : /db|database|migrations/.test(dir) ? "database" : "service"
  const buildings = []
  for (const top of ["apps", "services", "workers", "packages", "cmd"]) {
    if (!existsSync(join(root, top))) continue
    for (const d of readdirSync(join(root, top))) if (statSync(join(root, top, d)).isDirectory())
      buildings.push({ id: d.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48), name: d, kind: kindOf(`${top}/${d}`), path: `${top}/${d}`, summary: "TODO: one or two sentences, from the code." })
  }
  if (!buildings.length) buildings.push({ id: "app", name: "App", kind: "service", path: ".", summary: "TODO" })
  const name = (git("remote", "get-url", "origin") || root).replace(/\.git$/, "").split(/[/:]/).pop().toLowerCase()
  writeFileSync(mapPath, JSON.stringify({ $schema: "./tools/map/map.schema.json", version: 1, repo: name, visibility: "private", buildings, connections: [], code: [], journeys: [] }, null, 2) + "\n")
  console.log(grn(`wrote map.json with ${buildings.length} buildings. Fill in the TODOs, then run check.`))
  process.exit(0)
}

console.error(`unknown command ${cmd}. Commands: check, touched, diff, init`)
process.exit(1)
