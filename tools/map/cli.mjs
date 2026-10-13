#!/usr/bin/env node
// map — keep map.json honest. Usage:
//   node tools/map/cli.mjs check [--fix] [--strict] [--base <ref>] [--all]   validate map.json against the code (errors fail; --strict fails on warnings too)
//   node tools/map/cli.mjs coverage [--building <id>]                        what each building is missing (code, areas, journeys, guides)
//   node tools/map/cli.mjs touched [--base <ref>]                            what your branch changed that the map and guides may need to know
//   node tools/map/cli.mjs diff [--base <ref>]                               map changes vs base (what reviewers will see)
//   node tools/map/cli.mjs report [--base <ref>]                             markdown summary for CI ($GITHUB_STEP_SUMMARY)
//   node tools/map/cli.mjs sync [--pr <n>]                                   ask the Notion Worker to re-sync now (needs MAP_SYNC_URL + MAP_SYNC_SECRET)
//   node tools/map/cli.mjs init                                              write a starter map.json from the folder layout
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { check, coverage, diff, summarize, journeysTouched, parseOpenapiOps, flatten } from "./mapcore.mjs"

const args = process.argv.slice(2)
const cmd = args[0] || "check"
const flag = (f) => args.includes(f)
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).trim() } catch { return null } }
const root = git("rev-parse", "--show-toplevel") || process.cwd()
const mapPath = resolve(root, opt("--file", "map.json"))
const tty = process.stdout.isTTY, paint = (c) => (s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : String(s))
const red = paint(31), yel = paint(33), grn = paint(32), dim = paint(2), bold = paint(1)
const plural = (n, w, s = "s") => `${n} ${w}${n === 1 ? "" : s}`

function readRepoFile(p) {
  const f = join(root, p)
  if (!existsSync(f)) return null
  return statSync(f).isDirectory() ? "" : readFileSync(f, "utf8")
}
let tracked = null
const listFiles = () => (tracked ??= (git("ls-files") || "").split("\n").filter(Boolean))
function loadMap(text, where) {
  try { return JSON.parse(text) } catch (e) { console.error(red(`${where}: not valid JSON: ${e.message}`)); process.exit(1) }
}
function readMap() {
  if (!existsSync(mapPath)) { console.error(red("map.json not found. Run: node tools/map/cli.mjs init")); process.exit(1) }
  return loadMap(readFileSync(mapPath, "utf8"), "map.json")
}
function opsFor(map) {
  if (!map.openapi) return null
  const t = readRepoFile(map.openapi)
  if (t === null) { console.error(red(`openapi file ${map.openapi} not found`)); return new Set() }
  return parseOpenapiOps(t)
}
/** The branch this one will merge into: --base, then CI's GITHUB_BASE_REF, then the usual names. */
function baseRef() {
  const b = opt("--base", null)
  if (b) return b
  const ci = process.env.GITHUB_BASE_REF
  if (ci) for (const r of [`origin/${ci}`, ci]) if (git("rev-parse", "--verify", "-q", r)) return r
  for (const r of ["origin/staging", "origin/main", "origin/master", "main", "master"]) if (git("rev-parse", "--verify", "-q", r)) return r
  return null
}
function mapAt(ref) {
  const mb = git("merge-base", ref, "HEAD") || ref
  const t = git("show", `${mb}:map.json`)
  try { return t ? JSON.parse(t) : null } catch { return null }
}
function runCheck(map) {
  const ref = flag("--no-base") ? null : baseRef()
  const base = ref ? mapAt(ref) : null
  const files = !flag("--no-files")
  return check(map, { public: flag("--public") || map.visibility === "public", openapiOps: opsFor(map), readFile: files ? readRepoFile : undefined, listFiles: files ? listFiles : undefined, base })
}
const counts = (map) => {
  const items = flatten(map), n = (t) => items.filter((i) => i.type === t).length
  return `${n("building")} buildings, ${n("connection")} connections, ${n("code")} code, ${n("journey")} journeys, ${n("guide")} guides`
}
const groupByRule = (issues) => {
  const g = new Map()
  for (const i of issues) { const r = i.rule || "other"; g.set(r, [...(g.get(r) || []), i]) }
  return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}
const RULES = {
  "C-1": "buildings with too little code mapped", "C-2": "operations or connections no journey uses", "C-3": "journey steps with no code",
  "C-4": "very long code ranges", "C-5": "line ranges that stop before the code does", "C-6": "renamed ids", "C-7": "thin stories",
  "C-8": "outside services or HTTP calls not on the map", "C-9": "buildings with no guide", "D-1": "too few journeys", "D-5": "serves on a gateway", "D-6": "guides without \"Verified against\"", other: "other",
}

if (cmd === "check") {
  const map = readMap()
  let issues = runCheck(map)
  if (flag("--fix")) {
    let fixed = 0
    for (const i of issues) {
      const m = /^code\[(\d+)\]\.lines$/.exec(i.path)
      if (m && i.fix && i.level === "error") { map.code[+m[1]].lines = i.fix.lines; fixed++ }
    }
    if (fixed) {
      writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n")
      console.log(grn(`fixed ${plural(fixed, "line range")}. Read each one again: the summary and steps must still match the code.`))
      issues = runCheck(map)
    }
  }
  const errs = issues.filter((i) => i.level === "error"), warns = issues.filter((i) => i.level === "warning")
  for (const i of errs) console.log(`${red("error")}   ${i.path || "map"}  ${i.message}${i.fix ? dim("  (--fix updates this)") : ""}`)
  const all = flag("--all") || flag("--strict")
  for (const [rule, list] of groupByRule(warns)) {
    console.log(`${yel("warning")} ${bold(rule)}${rule === "other" ? "" : " " + dim(RULES[rule] || "")} ${dim(`(${list.length})`)}`)
    for (const i of all ? list : list.slice(0, 3)) console.log(`        ${i.path || "map"}  ${i.message.replace(/^[CD]-\d+: /, "")}`)
    if (!all && list.length > 3) console.log(dim(`        … ${list.length - 3} more (--all)`))
  }
  console.log(`${errs.length ? red("✗") : warns.length ? yel("✓") : grn("✓")} map.json ${dim(`(${counts(map)}${map.visibility === "public" ? ", public rules" : ""})`)}${errs.length ? red(`  ${plural(errs.length, "error")}`) : ""}${warns.length ? yel(`  ${plural(warns.length, "warning")}`) : ""}`)
  if (errs.length && issues.some((i) => i.fix && i.level === "error")) console.log(dim("Line ranges drifted: run check --fix, then re-read those entries."))
  process.exit(errs.length || (flag("--strict") && warns.length) ? 1 : 0)
}

if (cmd === "coverage") {
  const map = readMap()
  const issues = coverage(map, { readFile: readRepoFile, listFiles, openapiOps: opsFor(map) })
  const only = opt("--building", null)
  const B = map.buildings || [], K = map.code || [], J = map.journeys || [], G = map.guides || []
  const uses = (j, id) => j.steps.some((s) => s.building === id || [s, ...(s.on_failure || [])].some((x) => x.building === id))
  for (const [i, b] of B.entries()) {
    if (only && b.id !== only) continue
    if (b.kind === "outside") continue
    const code = K.filter((k) => k.building === b.id), js = J.filter((j) => uses(j, b.id)), gs = G.filter((g) => g.about.includes(b.id))
    const mine = issues.filter((x) => x.path === `buildings[${i}]` || x.path.startsWith(`buildings[${i}].`))
    const mark = mine.length ? yel("•") : grn("✓")
    console.log(`${mark} ${bold(b.name)} ${dim(`${b.id} · ${b.path || "no path"}`)}`)
    console.log(`    ${code.length} code entr${code.length === 1 ? "y" : "ies"} · ${plural((b.areas || []).length, "area")} · ${plural(js.length, "journey")} · ${plural(gs.length, "guide")}`)
    for (const x of mine) console.log(`    ${yel(x.rule || "")} ${x.message.replace(/^[CD]-\d+: /, "")}`)
  }
  const rest = issues.filter((x) => !x.path.startsWith("buildings["))
  if (rest.length && !only) { console.log(bold("Whole map")); for (const x of rest) console.log(`    ${yel(x.rule || "")} ${x.path}  ${x.message.replace(/^[CD]-\d+: /, "")}`) }
  console.log(dim(`${plural(issues.length, "gap")} found. Coverage gaps are warnings; fix the ones a newcomer would trip on first.`))
  process.exit(0)
}

if (cmd === "diff") {
  let a, b
  if (args[1] && !args[1].startsWith("--")) { a = loadMap(readFileSync(args[1], "utf8"), args[1]); b = loadMap(readFileSync(args[2], "utf8"), args[2]) }
  else { const ref = baseRef(); a = ref ? mapAt(ref) : null; b = readMap() }
  const ch = diff(a, b)
  for (const c of ch.filter((c) => c.type !== "step")) {
    const sign = c.change === "added" ? grn("+") : c.change === "removed" ? red("−") : yel("~")
    console.log(`${sign} ${c.type.padEnd(10)} ${c.id}${c.fields.length ? dim("  " + c.fields.join(", ")) : ""}`)
  }
  const steps = ch.filter((c) => c.type === "step").length
  if (steps) console.log(dim(`  ${plural(steps, "journey step")} edited`))
  console.log(summarize(ch, journeysTouched(b, ch)))
  process.exit(0)
}

if (cmd === "report") {
  const map = readMap()
  const issues = runCheck(map)
  const errs = issues.filter((i) => i.level === "error"), warns = issues.filter((i) => i.level === "warning")
  const md = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ")
  const out = ["## 🗺️ Architecture map", ""]
  out.push(errs.length ? `**✗ ${plural(errs.length, "error")}** · ${plural(warns.length, "warning")} · ${counts(map)}` : `**✓ map.json passes** · ${plural(warns.length, "warning")} · ${counts(map)}`, "")
  if (errs.length) {
    out.push("### Errors", "", "| Where | Problem |", "| --- | --- |")
    for (const i of errs) out.push(`| \`${md(i.path || "map")}\` | ${md(i.message)}${i.fix ? " *(run `check --fix`)*" : ""} |`)
    out.push("")
  }
  if (warns.length) {
    out.push("<details><summary>Coverage and depth warnings</summary>", "", "| Rule | What | Count | First |", "| --- | --- | --- | --- |")
    for (const [rule, list] of groupByRule(warns)) out.push(`| ${rule} | ${rule === "other" ? "" : md(RULES[rule] || "")} | ${list.length} | ${md(list[0].message.replace(/^[CD]-\d+: /, ""))} |`)
    out.push("", "</details>", "")
  }
  const ref = baseRef()
  if (ref) {
    const ch = diff(mapAt(ref), map)
    out.push(`### Changes vs \`${ref}\``, "", ch.length ? summarize(ch, journeysTouched(map, ch)) : "No map changes.", "")
  }
  console.log(out.join("\n"))
  process.exit(0)
}

if (cmd === "touched") {
  const ref = baseRef()
  if (!ref) { console.error(red("no base branch found; pass --base <ref>")); process.exit(1) }
  const mb = git("merge-base", ref, "HEAD") || ref
  const files = [...new Set([...(git("diff", "--name-only", mb) || "").split("\n"), ...(git("ls-files", "--others", "--exclude-standard") || "").split("\n")].filter(Boolean))]
  const map = existsSync(mapPath) ? loadMap(readFileSync(mapPath, "utf8"), "map.json") : { buildings: [], code: [], guides: [] }
  const under = (f, p) => p && (p === "." || f === p || f.startsWith(p.replace(/\/?$/, "/")))
  const hitB = new Map(), hitK = [], loose = []
  for (const f of files) {
    if (f === "map.json") continue
    const b = (map.buildings || []).filter((b) => under(f, b.path)).sort((x, y) => y.path.length - x.path.length)[0]
    if (b) hitB.set(b.id, [...(hitB.get(b.id) || []), f]); else if (!/(^|\/)(test|tests|__tests__|docs?)\/|\.(md|lock)$|^\.|^tools\/map\/|^[^/]+\.(json|ya?ml|toml|config\.[cm]?[jt]s)$/.test(f)) loose.push(f)
    for (const k of map.code || []) if (k.path === f) hitK.push(k)
  }
  console.log(files.includes("map.json") ? grn("map.json is changed on this branch") : yel("map.json is NOT changed on this branch"))
  for (const [id, fs] of hitB) console.log(`building ${id}: ${plural(fs.length, "file")} changed ${dim(fs.slice(0, 4).join(", ") + (fs.length > 4 ? ", …" : ""))}`)
  for (const k of hitK) console.log(`code ${k.id}: ${k.path} changed ${dim("— check summary, calls, symbol and lines")}`)
  if (loose.length) console.log(yel(`not covered by any building: ${loose.slice(0, 8).join(", ")}${loose.length > 8 ? ", …" : ""}`))
  const stale = (map.guides || []).filter((g) => g.about.some((id) => hitB.has(id)) && !files.includes(g.path))
  for (const g of stale) console.log(yel(`guide ${g.path} ("${g.title}") is about ${g.about.filter((id) => hitB.has(id)).join(", ")} but wasn't updated`) + dim(" — re-read it against the code and refresh \"Verified against\""))
  console.log(dim("Update map.json and guides if any of these changed what a building does, what it talks to, or how a journey runs. Then run: node tools/map/cli.mjs check"))
  process.exit(0)
}

if (cmd === "sync") {
  const url = process.env.MAP_SYNC_URL, secret = process.env.MAP_SYNC_SECRET
  if (!url || !secret) { console.error(red("set MAP_SYNC_URL (the Worker's /sync webhook) and MAP_SYNC_SECRET (the webhook secret). Or run the \"map sync\" workflow from the Actions tab.")); process.exit(1) }
  const remote = git("remote", "get-url", "origin") || ""
  const full = opt("--repo", (/[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(remote) || [])[1])
  if (!full) { console.error(red("couldn't tell owner/name from the origin remote; pass --repo owner/name")); process.exit(1) }
  const pr = Number(opt("--pr", 0)) || undefined
  const body = JSON.stringify({ repo: full, ...(pr ? { pr } : {}) })
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-map-signature": sig }, body })
  console.log(res.ok ? grn(`sync queued for ${full}${pr ? ` PR #${pr}` : ""}`) : red(`sync failed: ${res.status} ${await res.text()}`))
  process.exit(res.ok ? 0 : 1)
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
  writeFileSync(mapPath, JSON.stringify({ $schema: "./tools/map/map.schema.json", version: 1, repo: name, visibility: "private", buildings, connections: [], code: [], journeys: [], guides: [] }, null, 2) + "\n")
  console.log(grn(`wrote map.json with ${plural(buildings.length, "building")}. Fill in the TODOs (or ask your agent to "update the map"), then run check.`))
  process.exit(0)
}

console.error(`unknown command ${cmd}. Commands: check, coverage, touched, diff, report, sync, init`)
process.exit(1)
