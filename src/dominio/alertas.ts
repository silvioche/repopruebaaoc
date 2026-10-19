/** Reporte de riesgos para gerencia (HU-5): out/alertas.md. */
import fs from "node:fs"
import { reglas } from "./reglas.ts"
import { leerJsonl, leerMaestro, type Rutas } from "./repositorio.ts"
import { diasEntre } from "./texto.ts"
import type { FilaMaestro } from "./tipos.ts"

export interface ContratoPorVencer {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias_restantes: number
  comercial: string
}

export interface PolizaPendiente {
  id_contrato: string
  cliente: string
  tipo_poliza: string
  estado_poliza: string
  fecha_fin: string
}

export interface RegistroDesdeCorte {
  id_contrato: string
  cliente: string
  accion: string
  fecha_registro: string
  mensaje_id: string
}

export interface ReporteAlertas {
  ruta: string
  hoy: string
  vencen: ContratoPorVencer[]
  polizas_pendientes: PolizaPendiente[]
  registrados_desde_corte: RegistroDesdeCorte[]
  vencidos: ContratoPorVencer[]
}

interface EntradaHistorial {
  id_contrato: string
  accion: string
  mensaje_id: string
  fecha_registro?: string
  ts: string
}

function porVencer(f: FilaMaestro, hoy: string): ContratoPorVencer {
  return { id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: diasEntre(hoy, f.fecha_fin), comercial: f.comercial }
}

function tabla(encabezados: string[], filas: string[][]): string {
  if (filas.length === 0) return "_Sin registros._\n"
  const linea = (celdas: string[]) => `| ${celdas.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`
  return [linea(encabezados), linea(encabezados.map(() => "---")), ...filas.map(linea)].join("\n") + "\n"
}

function markdown(rep: Omit<ReporteAlertas, "ruta">): string {
  const dias = reglas.dias_alerta_vencimiento
  return [
    `# Alertas de contratos — ${rep.hoy}`,
    "",
    `Fuente: \`out/sharepoint/maestro-contratos.csv\`. Fecha de referencia: **${rep.hoy}**.`,
    "",
    `## 1. Contratos que vencen en ≤ ${dias} días (${rep.vencen.length})`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Comercial"], rep.vencen.map((v) => [v.id_contrato, v.cliente, v.fecha_fin, String(v.dias_restantes), v.comercial || "—"])),
    `## 2. Pólizas exigidas no vigentes (${rep.polizas_pendientes.length})`,
    "",
    tabla(["Contrato", "Cliente", "Tipo de póliza", "Estado", "Fecha fin contrato"], rep.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza, p.estado_poliza, p.fecha_fin])),
    `## 3. Registrados desde el corte del ${reglas.fecha_corte_maestro} — gap cubierto (${rep.registrados_desde_corte.length})`,
    "",
    tabla(["Contrato", "Cliente", "Acción", "Fecha registro", "Mensaje"], rep.registrados_desde_corte.map((g) => [g.id_contrato, g.cliente, g.accion, g.fecha_registro, g.mensaje_id])),
    `## Contexto: contratos ya vencidos sin acta de terminación ni renovación registrada (${rep.vencidos.length})`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días vencido"], rep.vencidos.map((v) => [v.id_contrato, v.cliente, v.fecha_fin, String(-v.dias_restantes)])),
  ].join("\n")
}

export function generarAlertas(r: Rutas, hoy: string): ReporteAlertas {
  const maestro = leerMaestro(r)
  const conFecha = maestro.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha_fin))
  const vencen = conFecha
    .map((f) => porVencer(f, hoy))
    .filter((v) => v.dias_restantes >= 0 && v.dias_restantes <= reglas.dias_alerta_vencimiento)
    .sort((a, b) => a.dias_restantes - b.dias_restantes)
  const vencidos = conFecha.map((f) => porVencer(f, hoy)).filter((v) => v.dias_restantes < 0).sort((a, b) => a.dias_restantes - b.dias_restantes)
  const polizas_pendientes = maestro
    .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, fecha_fin: f.fecha_fin }))
  const clientes = new Map(maestro.map((f) => [f.id_contrato, f.cliente]))
  const registrados_desde_corte = leerJsonl<EntradaHistorial>(r.historial)
    .filter((h) => (h.fecha_registro ?? h.ts.slice(0, 10)) > reglas.fecha_corte_maestro)
    .map((h) => ({ id_contrato: h.id_contrato, cliente: clientes.get(h.id_contrato) ?? "", accion: h.accion, fecha_registro: h.fecha_registro ?? h.ts.slice(0, 10), mensaje_id: h.mensaje_id }))
  const reporte = { hoy, vencen, polizas_pendientes, registrados_desde_corte, vencidos }
  fs.mkdirSync(r.out, { recursive: true })
  fs.writeFileSync(r.alertas, markdown(reporte), "utf8")
  return { ruta: "out/alertas.md", ...reporte }
}
