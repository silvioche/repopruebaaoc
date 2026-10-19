/**
 * Adaptador "simulado": planificador determinista basado en reglas que implementa la misma
 * interfaz que un LLM. Se usa cuando el backend no tiene clave de proveedor, para que el
 * chat (y el ciclo del agente, la confirmación humana y el front) sigan siendo demostrables.
 * No interpreta lenguaje libre: reconoce intenciones con expresiones regulares.
 */
import type { AdaptadorLLM, LlamadaHerramienta, MensajeLLM, PeticionLLM, RespuestaLLM } from "./adapter.ts"

interface ResultadoJson {
  ok: boolean
  data?: unknown
  error?: string
  detalle?: unknown
}

interface Paso {
  nombre: string
  args: Record<string, unknown>
}

type Plan = Generator<Paso, string, ResultadoJson>

interface MensajeBuzon {
  id: string
  asunto: string
  tiene_contrato: boolean
  motivo?: string
}
interface Revision {
  campo: string
  valor_propuesto: string
  confianza: number | null
  motivo: string
}
interface Validacion {
  clasificacion: string
  motivo: string
  requiere_revision: string[]
  revision_detalle: Revision[]
  advertencias: string[]
}
interface Registro {
  id_contrato: string | null
  accion: string
  ruta_archivo: string | null
}
interface Alertas {
  ruta: string
  vencen: { id_contrato: string; cliente: string; fecha_fin: string; dias_restantes: number }[]
  polizas_pendientes: { id_contrato: string; cliente: string; tipo_poliza: string; estado_poliza: string }[]
  registrados_desde_corte: { id_contrato: string; accion: string }[]
}

interface Pendiente {
  mensajeId: string
  contrato: Record<string, unknown>
  detalle: Revision[]
}

// ---------- Lectura del historial ----------

interface Par {
  llamada: LlamadaHerramienta
  resultado: ResultadoJson
}

function textoUsuario(m: MensajeLLM): string | null {
  if (m.rol !== "usuario") return null
  const textos = m.bloques.flatMap((b) => (b.tipo === "texto" ? [b.texto] : []))
  return textos.length ? textos.join("\n") : null
}

function pares(mensajes: MensajeLLM[]): Par[] {
  const llamadas = new Map<string, LlamadaHerramienta>()
  const salida: Par[] = []
  for (const m of mensajes) {
    if (m.rol === "asistente") for (const l of m.llamadas) llamadas.set(l.id, l)
    else
      for (const b of m.bloques) {
        const llamada = b.tipo === "resultado" ? llamadas.get(b.idLlamada) : undefined
        if (b.tipo === "resultado" && llamada) salida.push({ llamada, resultado: JSON.parse(b.contenido) as ResultadoJson })
      }
  }
  return salida
}

function argMensaje(l: LlamadaHerramienta): string | null {
  const a = l.args as Record<string, unknown> | null
  return a && typeof a.mensaje_id === "string" ? a.mensaje_id : null
}

/** Mensajes que quedaron esperando confirmación en turnos anteriores. */
function pendientesPrevios(historial: Par[]): Pendiente[] {
  const pendientes = new Map<string, Pendiente>()
  for (const { llamada, resultado } of historial) {
    const id = argMensaje(llamada)
    if (!id) continue
    if (llamada.nombre === "contratos_extraer" && resultado.ok) {
      const contrato = (resultado.data as { contrato: Record<string, unknown> }).contrato
      pendientes.set(id, { mensajeId: id, contrato, detalle: pendientes.get(id)?.detalle ?? [] })
    }
    if (llamada.nombre === "contratos_validar" && resultado.ok) {
      const v = resultado.data as Validacion
      const previo = pendientes.get(id)
      if (previo) previo.detalle = v.requiere_revision.length ? v.revision_detalle : []
    }
    if (llamada.nombre === "contratos_registrar" && resultado.ok) pendientes.delete(id)
  }
  return [...pendientes.values()].filter((p) => p.detalle.length > 0)
}

// ---------- Utilidades de redacción ----------

const FECHA_REFERENCIA = /\b(?:hoy|fecha(?: de referencia)?)\s*(?:es\s+|:\s*|=\s*)?(\d{4}-\d{2}-\d{2})\b/i

/** Fecha de referencia: la que el usuario asoció a "hoy" / "fecha" en este turno o en uno anterior. */
function fechaHoy(texto: string, historial: MensajeLLM[]): string {
  for (const t of [texto, ...[...historial].reverse().map((m) => textoUsuario(m) ?? "")]) {
    const fecha = FECHA_REFERENCIA.exec(t)?.[1]
    if (fecha) return fecha
  }
  return new Date().toISOString().slice(0, 10)
}

function tablaRevision(p: Pendiente): string {
  const filas = p.detalle.map((d) => `| ${d.campo} | ${d.valor_propuesto || "(vacío)"} | ${d.confianza ?? "—"} | ${d.motivo} |`)
  return [`**${p.mensajeId}** — campos en revisión:`, "", "| Campo | Valor propuesto | Confianza | Motivo |", "|---|---|---|---|", ...filas].join("\n")
}

function preguntaConfirmacion(pendientes: Pendiente[]): string {
  const ejemplo = pendientes[0]?.detalle.map((d) => `${d.campo.replace("_", " ")} ${d.valor_propuesto}`).join(" y ")
  return [
    "### ⚠️ Requiere tu confirmación",
    "",
    ...pendientes.map(tablaRevision),
    "",
    `No registré ${pendientes.map((p) => p.mensajeId).join(", ")}. **¿Confirmas estos valores para registrarlo?** Responde, por ejemplo: «confirmo ${ejemplo}», o indícame el valor correcto.`,
  ].join("\n")
}

function resumenAlertas(a: ResultadoJson): string {
  if (!a.ok) return `No pude generar alertas: ${a.error}`
  const d = a.data as Alertas
  return [
    `### Alertas (${d.ruta})`,
    `- **Vencen en ≤ 60 días:** ${d.vencen.map((v) => `${v.id_contrato} ${v.cliente} (${v.fecha_fin}, ${v.dias_restantes} días)`).join("; ") || "ninguno"}`,
    `- **Pólizas exigidas no vigentes:** ${d.polizas_pendientes.map((p) => `${p.id_contrato} (${p.tipo_poliza}, ${p.estado_poliza})`).join("; ") || "ninguna"}`,
    `- **Registrados desde el corte:** ${d.registrados_desde_corte.map((g) => `${g.id_contrato} (${g.accion})`).join("; ") || "ninguno"}`,
  ].join("\n")
}

function accionDe(r: ResultadoJson): string {
  if (!r.ok) return `No registrado: ${r.error}`
  const d = r.data as Registro & { advertencias?: string[] }
  if (d.accion === "rechazado") return `rechazado — ${d.advertencias?.[0] ?? ""}`
  return `${d.accion}${d.id_contrato ? ` ${d.id_contrato}` : ""}${d.ruta_archivo ? ` → \`${d.ruta_archivo}\`` : ""}`
}

// ---------- Planes ----------

function* planProcesar(hoy: string): Plan {
  const buzon = yield { nombre: "contratos_leer_buzon", args: {} }
  if (!buzon.ok) return `No pude leer el buzón: ${buzon.error}`
  const mensajes = (buzon.data as { mensajes: MensajeBuzon[] }).mensajes
  if (mensajes.length === 0) {
    const alertas = yield { nombre: "contratos_alertas", args: { hoy } }
    return `No hay mensajes pendientes en el buzón.\n\n${resumenAlertas(alertas)}`
  }
  const filas: string[] = []
  const pendientes: Pendiente[] = []
  for (const m of mensajes) {
    let contrato: Record<string, unknown> | undefined
    if (m.tiene_contrato) {
      const ex = yield { nombre: "contratos_extraer", args: { mensaje_id: m.id } }
      if (!ex.ok) {
        filas.push(`| ${m.id} | ${m.asunto} | error | ${ex.error} |`)
        continue
      }
      contrato = (ex.data as { contrato: Record<string, unknown> }).contrato
    }
    const va = yield { nombre: "contratos_validar", args: contrato ? { mensaje_id: m.id, contrato } : { mensaje_id: m.id } }
    if (!va.ok) {
      filas.push(`| ${m.id} | ${m.asunto} | error | ${va.error} |`)
      continue
    }
    const v = va.data as Validacion
    if (v.requiere_revision.length && contrato) {
      pendientes.push({ mensajeId: m.id, contrato, detalle: v.revision_detalle })
      filas.push(`| ${m.id} | ${m.asunto} | ${v.clasificacion} | ⏸ en espera de confirmación (${v.requiere_revision.join(", ")}) |`)
      continue
    }
    const reg = yield { nombre: "contratos_registrar", args: contrato ? { mensaje_id: m.id, contrato, hoy } : { mensaje_id: m.id, hoy } }
    filas.push(`| ${m.id} | ${m.asunto} | ${v.clasificacion} | ${accionDe(reg)} |`)
  }
  const alertas = yield { nombre: "contratos_alertas", args: { hoy } }
  return [
    `Procesé ${mensajes.length} mensajes del buzón (fecha de referencia ${hoy}).`,
    "",
    "| Mensaje | Asunto | Clasificación | Acción |",
    "|---|---|---|---|",
    ...filas,
    "",
    pendientes.length ? preguntaConfirmacion(pendientes) : "No quedó nada pendiente de confirmación.",
    "",
    resumenAlertas(alertas),
  ].join("\n")
}

function correcciones(texto: string): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  const valor = /valor\s+(?:de\s+|es\s+|en\s+)?\$?\s*(\d[\d.,]*)/i.exec(texto)?.[1]
  if (valor !== undefined) c.valor = Number(valor.replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."))
  const fin = /fecha[\s_]*(?:de\s+)?fin\w*\s+(?:es\s+|de\s+|en\s+)?(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  if (fin) c.fecha_fin = fin
  const inicio = /fecha[\s_]*(?:de\s+)?inicio\s+(?:es\s+|de\s+|en\s+)?(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  if (inicio) c.fecha_inicio = inicio
  return c
}

function* planConfirmar(texto: string, pendientes: Pendiente[], hoy: string): Plan {
  const mencionados = [...texto.matchAll(/msg-[\w-]+/g)].map((m) => m[0])
  const objetivo = mencionados.length ? pendientes.filter((p) => mencionados.includes(p.mensajeId)) : pendientes
  if (objetivo.length === 0) return "No hay registros esperando confirmación."
  const lineas: string[] = []
  for (const p of objetivo) {
    const contrato = { ...p.contrato, ...correcciones(texto) }
    const reg = yield { nombre: "contratos_registrar", args: { mensaje_id: p.mensajeId, contrato, confirmado: true, hoy } }
    lineas.push(`- **${p.mensajeId}**: ${accionDe(reg)}`)
  }
  const alertas = yield { nombre: "contratos_alertas", args: { hoy } }
  return ["Gracias por confirmar. Resultado:", "", ...lineas, "", resumenAlertas(alertas)].join("\n")
}

function* planAlertas(hoy: string): Plan {
  return resumenAlertas(yield { nombre: "contratos_alertas", args: { hoy } })
}

function* planListar(): Plan {
  const b = yield { nombre: "contratos_leer_buzon", args: {} }
  if (!b.ok) return `No pude leer el buzón: ${b.error}`
  const ms = (b.data as { mensajes: MensajeBuzon[] }).mensajes
  if (!ms.length) return "No hay mensajes pendientes en el buzón."
  return ["| Mensaje | Asunto | ¿Trae contrato? |", "|---|---|---|", ...ms.map((m) => `| ${m.id} | ${m.asunto} | ${m.tiene_contrato ? "sí" : `no — ${m.motivo ?? ""}`} |`)].join("\n")
}

function* planAyuda(): Plan {
  return [
    "Estoy en **modo simulado** (sin modelo de lenguaje configurado): entiendo instrucciones básicas.",
    "",
    "- «Procesa el buzón con fecha de hoy 2026-09-03»",
    "- «¿Qué mensajes hay pendientes?»",
    "- «Genera el reporte de alertas con fecha 2026-09-03»",
    "- «Confirmo el valor 0 y la fecha fin 2027-08-31»",
  ].join("\n")
}

function elegirPlan(texto: string, previos: Par[], historial: MensajeLLM[]): () => Plan {
  const hoy = fechaHoy(texto, historial)
  const pendientes = pendientesPrevios(previos)
  if (/\b(confirm\w*|apruebo|aprobado|de acuerdo)\b|^\s*s[ií]\b/i.test(texto) && pendientes.length) return () => planConfirmar(texto, pendientes, hoy)
  if (/procesa|registra/i.test(texto)) return () => planProcesar(hoy)
  if (/alerta|vence|p[óo]liza|reporte/i.test(texto)) return () => planAlertas(hoy)
  if (/pendiente|buz[oó]n|qu[eé] hay|lista/i.test(texto)) return () => planListar()
  return () => planAyuda()
}

export function crearAdaptadorSimulado(): AdaptadorLLM {
  return {
    proveedor: "simulado",
    modelo: "planificador-determinista",
    async enviar(p: PeticionLLM): Promise<RespuestaLLM> {
      const indiceTurno = p.mensajes.map((m) => textoUsuario(m) !== null).lastIndexOf(true)
      const texto = textoUsuario(p.mensajes[indiceTurno]) ?? ""
      const previos = pares(p.mensajes.slice(0, indiceTurno))
      const delTurno = pares(p.mensajes.slice(indiceTurno)).map((x) => x.resultado)
      const plan = elegirPlan(texto, previos, p.mensajes.slice(0, indiceTurno))()
      let paso = plan.next()
      for (const resultado of delTurno) {
        if (paso.done) break
        paso = plan.next(resultado)
      }
      const uso = { entrada: 0, salida: 0, cacheLeidos: 0 }
      if (paso.done) return { texto: paso.value, llamadas: [], parada: "fin", uso }
      const llamada = { id: `sim-${indiceTurno}-${delTurno.length}`, nombre: paso.value.nombre, args: paso.value.args }
      return { texto: "", llamadas: [llamada], parada: "herramientas", uso }
    },
  }
}
