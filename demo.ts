/**
 * Verificación sin modelo: procesa los 6 mensajes del buzón llamando directamente a las
 * herramientas, muestra la segunda pasada con confirmado=true, genera alertas y comprueba
 * los invariantes (sin duplicados, historial, fixture intacto). Sale con código 1 si algo falla.
 *
 *   bun install && bun run demo.ts      ó      npm install && node demo.ts
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as contratos from "./src/tools/contratos.ts"
import { leerJsonl, leerMaestro, rutas } from "./src/dominio/repositorio.ts"
import type { Contrato, MotivoRevision, Resultado, ResultadoValidacion } from "./src/dominio/tipos.ts"

const HOY = "2026-09-03"
const raiz = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory: raiz, sessionId: "demo" }
const r = rutas(raiz)

interface MensajeBuzon {
  id: string
  asunto: string
  tiene_contrato: boolean
}
interface Extraido {
  contrato: Contrato
  campos_baja_confianza: string[]
}
interface Registro {
  id_contrato: string | null
  accion: string
  ruta_archivo: string | null
}
interface Alertas {
  ruta: string
  vencen: { id_contrato: string; dias_restantes: number }[]
  polizas_pendientes: { id_contrato: string; estado_poliza: string }[]
  registrados_desde_corte: { id_contrato: string; accion: string }[]
}

const parse = <T,>(json: string): Resultado<T> => JSON.parse(json) as Resultado<T>
const huella = (archivo: string) => createHash("sha256").update(fs.readFileSync(archivo)).digest("hex")
const fallos: string[] = []
function comprobar(condicion: boolean, descripcion: string): void {
  console.log(`  ${condicion ? "✔" : "✘"} ${descripcion}`)
  if (!condicion) fallos.push(descripcion)
}

function detalleRevision(detalle: MotivoRevision[]): string {
  return detalle.map((d) => `      · ${d.campo} = "${d.valor_propuesto}" (confianza ${d.confianza ?? "—"}): ${d.motivo}`).join("\n")
}

// ---------------------------------------------------------------------------
fs.rmSync(r.out, { recursive: true, force: true })
const huellaFixture = huella(r.maestroFixture)
console.log(`\n=== Demo de herramientas sin modelo · hoy = ${HOY} · out/ limpio ===\n`)

const buzon = parse<{ mensajes: MensajeBuzon[] }>(await contratos.leer_buzon.execute({}, ctx))
if (!buzon.ok) throw new Error(buzon.error)
console.log(`contratos_leer_buzon → ${buzon.data.mensajes.length} mensajes pendientes\n`)

const pendientes: { id: string; contrato: Contrato }[] = []
const tabla: { mensaje: string; clasificacion: string; revision: string; accion: string }[] = []

for (const m of buzon.data.mensajes) {
  console.log(`▶ ${m.id} — ${m.asunto}`)
  let contrato: Contrato | undefined
  if (m.tiene_contrato) {
    const ex = parse<Extraido>(await contratos.extraer.execute({ mensaje_id: m.id }, ctx))
    if (!ex.ok) {
      console.log(`   extraer: ERROR ${ex.error}\n`)
      tabla.push({ mensaje: m.id, clasificacion: "error", revision: "", accion: ex.error })
      continue
    }
    contrato = ex.data.contrato
    console.log(`   extraer: ${contrato.id_contrato} · ${contrato.cliente} · ${contrato.valor} ${contrato.moneda} · ${contrato.fecha_inicio} → ${contrato.fecha_fin}`)
  } else {
    console.log("   extraer: omitido (sin adjunto de contrato)")
  }
  const va = parse<ResultadoValidacion>(await contratos.validar.execute({ mensaje_id: m.id, contrato }, ctx))
  if (!va.ok) {
    console.log(`   validar: ERROR ${va.error}\n`)
    continue
  }
  console.log(`   validar: ${va.data.clasificacion} — ${va.data.motivo}`)
  for (const a of va.data.advertencias) console.log(`   aviso: ${a}`)
  if (va.data.requiere_revision.length) console.log(`   requiere_revision: [${va.data.requiere_revision.join(", ")}]\n${detalleRevision(va.data.revision_detalle)}`)

  const reg = parse<Registro>(await contratos.registrar.execute({ mensaje_id: m.id, contrato, hoy: HOY }, ctx))
  const accion = reg.ok ? `${reg.data.accion}${reg.data.ruta_archivo ? ` → ${reg.data.ruta_archivo}` : ""}` : `NO registrado (${reg.error})`
  console.log(`   registrar: ${accion}\n`)
  if (!reg.ok && contrato) pendientes.push({ id: m.id, contrato })
  tabla.push({ mensaje: m.id, clasificacion: va.data.clasificacion, revision: va.data.requiere_revision.join(", ") || "—", accion })
}

console.log("=== Resumen primera pasada ===")
console.table(tabla)

// ---------------------------------------------------------------------------
console.log('\n=== Segunda pasada: el usuario responde "confirmo el valor 0 y la fecha fin 2027-08-31" ===')
for (const p of pendientes) {
  const confirmado = { ...p.contrato, valor: 0, fecha_fin: "2027-08-31" }
  const reg = parse<Registro>(await contratos.registrar.execute({ mensaje_id: p.id, contrato: confirmado, confirmado: true, hoy: HOY }, ctx))
  console.log(`   registrar(${p.id}, confirmado=true): ${reg.ok ? `${reg.data.accion} ${reg.data.id_contrato} → ${reg.data.ruta_archivo}` : reg.error}`)
}

// ---------------------------------------------------------------------------
const al = parse<Alertas>(await contratos.alertas.execute({ hoy: HOY }, ctx))
console.log("\n=== contratos_alertas ===")
if (al.ok) {
  console.log(`   ${al.data.ruta}`)
  console.log(`   vencen ≤ 60 días: ${al.data.vencen.map((v) => `${v.id_contrato} (${v.dias_restantes} d)`).join(", ") || "ninguno"}`)
  console.log(`   pólizas no vigentes: ${al.data.polizas_pendientes.map((p) => `${p.id_contrato} (${p.estado_poliza})`).join(", ")}`)
  console.log(`   registrados desde el corte: ${al.data.registrados_desde_corte.map((g) => `${g.id_contrato} (${g.accion})`).join(", ")}`)
}

// ---------------------------------------------------------------------------
console.log("\n=== Robustez (HU-6): cada caso malo devuelve { ok: false } legible y no lanza ===")
const malos: [string, Promise<string>][] = [
  ["mensaje inexistente", contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx)],
  ["path traversal", contratos.extraer.execute({ mensaje_id: "../../etc" }, ctx)],
  ["fecha inválida", contratos.alertas.execute({ hoy: "2026-02-30" }, ctx)],
  ["moneda desconocida", contratos.validar.execute({ mensaje_id: "msg-001", contrato: { ...pendientes[0]?.contrato, moneda: "EUR" } as unknown as Contrato }, ctx)],
  ["reprocesar mensaje", contratos.registrar.execute({ mensaje_id: "msg-001", hoy: HOY }, ctx)],
  ["cotización como contrato", contratos.extraer.execute({ mensaje_id: "msg-005" }, ctx)],
]
for (const [nombre, promesa] of malos) {
  const res = parse<unknown>(await promesa)
  console.log(`   ${nombre}: ${res.ok ? "ok (inesperado)" : res.error.split("\n")[0]}`)
  comprobar(!res.ok, `${nombre} → ok:false`)
}

// ---------------------------------------------------------------------------
console.log("\n=== Invariantes ===")
const maestro = leerMaestro(r)
const ids = maestro.map((f) => f.id_contrato)
const historial = leerJsonl<{ id_contrato: string; accion: string }>(r.historial)
const procesados = JSON.parse(fs.readFileSync(r.procesados, "utf8")) as Record<string, { accion: string }>
const fila = (id: string) => maestro.find((f) => f.id_contrato === id)
comprobar(new Set(ids).size === ids.length, `cero filas duplicadas (${ids.length} filas)`)
comprobar(ids.length === 11, "8 filas históricas + 3 nuevas (msg-001, msg-002, msg-006)")
comprobar(fila("CT-2026-015")?.estado_poliza === "pendiente", "msg-001 nuevo con estado_poliza = pendiente")
comprobar(fila("CT-2026-016")?.estado_poliza === "no_aplica", "msg-002 nuevo con estado_poliza = no_aplica")
comprobar(fila("CT-2026-011")?.fecha_fin === "2027-11-01" && fila("CT-2026-011")?.valor === "520000", "msg-003 otrosí actualiza fecha_fin y valor de CT-2026-011")
comprobar(historial.some((h) => h.id_contrato === "CT-2026-011" && h.accion.startsWith("actualizacion")), "el otrosí deja traza en historial.jsonl")
comprobar(procesados["msg-004"]?.accion === "sin_cambios_duplicado" && fila("CT-2026-012")?.fecha_registro === "2026-05-18", "msg-004 duplicado sin escritura en el maestro")
comprobar(procesados["msg-005"]?.accion === "rechazado", "msg-005 rechazado")
comprobar(fila("CM-2026-03")?.valor === "0" && fila("CM-2026-03")?.fecha_fin === "2027-08-31", "msg-006 registrado solo tras confirmación")
comprobar(fs.existsSync(path.join(r.sharepoint, "Contratos", "2026", "industrias-delta", "CT-2026-015.txt")), "documento archivado en Contratos/<año>/<cliente>/<id>.txt")
comprobar(huella(r.maestroFixture) === huellaFixture, "el fixture maestro-contratos.csv no se modificó")
comprobar(fs.existsSync(r.log) && fs.existsSync(r.alertas), "out/log.jsonl y out/alertas.md generados")

console.log(fallos.length === 0 ? "\nDEMO OK ✔\n" : `\nDEMO CON FALLOS ✘ (${fallos.length})\n`)
process.exit(fallos.length === 0 ? 0 : 1)
