/**
 * Ciclo del agente: prompt → modelo → herramientas → … → respuesta.
 * CA1 tope de iteraciones · CA3 confirmación humana · CA4 traza · CA5 errores sin matar la sesión.
 */
import { agregarJsonl, leerProcesados, rutas } from "../dominio/repositorio.ts"
import type { MotivoRevision } from "../dominio/tipos.ts"
import { ErrorProveedor, type AdaptadorLLM, type BloqueUsuario, type LlamadaHerramienta, type UsoTokens } from "../llm/adapter.ts"
import type { HerramientaRegistrada } from "./herramientas.ts"
import type { LlamadaVisible, PendienteConfirmacion, Sesion } from "./sesiones.ts"

export interface ConfigCiclo {
  maxIteraciones: number
  maxTokensSesion: number
}

export type EventoAgente =
  | { tipo: "pensando"; iteracion: number }
  | { tipo: "texto"; texto: string }
  | { tipo: "tool_call"; id: string; nombre: string; args: unknown }
  | { tipo: "tool_result"; llamada: LlamadaVisible }

export interface DependenciasCiclo {
  llm: AdaptadorLLM
  herramientas: Map<string, HerramientaRegistrada>
  sistema: string
  directorio: string
  config: ConfigCiclo
  emitir?: (evento: EventoAgente) => void
}

export interface RespuestaTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  pendientes: PendienteConfirmacion[]
  error: boolean
  uso: { entrada: number; salida: number; sesion: number; tope: number }
}

interface ResultadoJson {
  ok: boolean
  data?: { clasificacion?: string; requiere_revision?: string[]; revision_detalle?: MotivoRevision[] }
  error?: string
  detalle?: { clasificacion?: string; requiere_revision?: string[]; revision_detalle?: MotivoRevision[] }
}

function mensajeIdDe(args: unknown): string | null {
  if (typeof args !== "object" || args === null || !("mensaje_id" in args)) return null
  return typeof args.mensaje_id === "string" ? args.mensaje_id : null
}

function agregarTextoUsuario(sesion: Sesion, texto: string): void {
  const ultimo = sesion.mensajesLLM.at(-1)
  // Si el turno anterior se cortó por un error, el último mensaje ya es del usuario: se completa.
  if (ultimo?.rol === "usuario") ultimo.bloques.push({ tipo: "texto", texto })
  else sesion.mensajesLLM.push({ rol: "usuario", bloques: [{ tipo: "texto", texto }] })
}

/** Actualiza el mapa de pendientes de confirmación a partir de un resultado de herramienta. */
function actualizarPendientes(pendientes: Map<string, PendienteConfirmacion>, nombre: string, args: unknown, salida: string): void {
  const id = mensajeIdDe(args)
  if (!id) return
  const r = JSON.parse(salida) as ResultadoJson
  if (nombre === "contratos_validar" && r.ok && r.data) {
    const enRevision = (r.data.requiere_revision ?? []).length > 0 && (r.data.clasificacion === "nuevo" || r.data.clasificacion === "actualizacion")
    if (enRevision) pendientes.set(id, { mensaje_id: id, clasificacion: r.data.clasificacion ?? "", campos: r.data.revision_detalle ?? [] })
    else pendientes.delete(id)
  }
  if (nombre === "contratos_registrar") {
    if (r.ok) pendientes.delete(id)
    else if (r.detalle?.requiere_revision?.length) pendientes.set(id, { mensaje_id: id, clasificacion: r.detalle.clasificacion ?? "", campos: r.detalle.revision_detalle ?? [] })
  }
}

/** CA3: `confirmado=true` solo se acepta para mensajes cuya revisión se le mostró al usuario en el turno anterior. */
function bloqueoDeConfirmacion(llamada: LlamadaHerramienta, confirmables: Set<string>): string | null {
  if (llamada.nombre !== "contratos_registrar") return null
  const args = llamada.args as { confirmado?: unknown } | null
  if (args?.confirmado !== true) return null
  const id = mensajeIdDe(llamada.args)
  if (id && confirmables.has(id)) return null
  return JSON.stringify({
    ok: false,
    error: `confirmación no válida para ${id ?? "(sin mensaje_id)"}: el usuario aún no ha visto ni confirmado sus campos en revisión. Termina el turno mostrando los campos y preguntando explícitamente.`,
  })
}

async function ejecutarLlamada(llamada: LlamadaHerramienta, deps: DependenciasCiclo, sesion: Sesion, confirmables: Set<string>): Promise<LlamadaVisible> {
  const h = deps.herramientas.get(llamada.nombre)
  const bloqueo = bloqueoDeConfirmacion(llamada, confirmables)
  const salida = !h
    ? JSON.stringify({ ok: false, error: `herramienta desconocida: ${llamada.nombre}` })
    : (bloqueo ?? (await h.ejecutar(llamada.args, { directory: deps.directorio, sessionId: sesion.id })))
  const ok = (JSON.parse(salida) as ResultadoJson).ok
  return {
    id: llamada.id,
    nombre: llamada.nombre,
    args: llamada.args,
    ok,
    resumen: bloqueo ? "bloqueada: falta confirmación humana" : (h?.resumir(salida) ?? salida),
    resultado: salida,
    bloqueada: bloqueo !== null,
  }
}

function resumenTope(llamadas: LlamadaVisible[], directorio: string, maxIteraciones: number): string {
  const procesados = Object.keys(leerProcesados(rutas(directorio)))
  const hechas = llamadas.map((l) => `- ${l.nombre}: ${l.resumen}`).join("\n")
  return [
    `Alcancé el tope de ${maxIteraciones} iteraciones de este turno y me detengo aquí.`,
    "",
    "**Lo que hice:**",
    hechas || "- (ninguna herramienta ejecutada)",
    "",
    `**Mensajes procesados hasta ahora:** ${procesados.join(", ") || "ninguno"}.`,
    "**Lo que falta:** pídeme «continúa» para seguir con los mensajes pendientes del buzón.",
  ].join("\n")
}

function registrarError(directorio: string, sesion: Sesion, error: string): void {
  try {
    agregarJsonl(rutas(directorio).log, { ts: new Date().toISOString(), herramienta: "agente", mensaje_id: null, ok: false, resumen: error, sesion: sesion.id })
  } catch {
    // sin log no se interrumpe la respuesta
  }
}

export async function ejecutarTurno(sesion: Sesion, mensaje: string, deps: DependenciasCiclo): Promise<RespuestaTurno> {
  const { config } = deps
  const confirmables = new Set(sesion.pendientes.map((p) => p.mensaje_id))
  const pendientes = new Map(sesion.pendientes.map((p) => [p.mensaje_id, p]))
  const llamadas: LlamadaVisible[] = []
  const usoTurno: UsoTokens = { entrada: 0, salida: 0, cacheLeidos: 0 }
  let reply = ""
  let error = false

  sesion.visible.push({ rol: "usuario", texto: mensaje, ts: new Date().toISOString() })
  agregarTextoUsuario(sesion, mensaje)

  let terminado = false
  for (let iteracion = 1; iteracion <= config.maxIteraciones && !terminado; iteracion++) {
    if (sesion.tokens.entrada + sesion.tokens.salida >= config.maxTokensSesion) {
      reply = `Esta sesión alcanzó su tope de ${config.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
      error = true
      break
    }
    deps.emitir?.({ tipo: "pensando", iteracion })
    let respuesta
    try {
      respuesta = await deps.llm.enviar({ sistema: deps.sistema, mensajes: sesion.mensajesLLM, herramientas: [...deps.herramientas.values()].map((h) => h.definicion) })
    } catch (e) {
      const detalle = e instanceof ErrorProveedor ? e.message : `error inesperado del proveedor: ${e instanceof Error ? e.message : String(e)}`
      reply = `No pude completar la respuesta: ${detalle}. La sesión sigue activa; puedes reintentar.`
      registrarError(deps.directorio, sesion, detalle)
      error = true
      break
    }
    usoTurno.entrada += respuesta.uso.entrada
    usoTurno.salida += respuesta.uso.salida
    sesion.tokens.entrada += respuesta.uso.entrada
    sesion.tokens.salida += respuesta.uso.salida
    sesion.mensajesLLM.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, nativo: respuesta.nativo })
    if (respuesta.texto && respuesta.llamadas.length) deps.emitir?.({ tipo: "texto", texto: respuesta.texto })

    if (respuesta.llamadas.length === 0) {
      reply = respuesta.parada === "rechazo" ? "El modelo declinó responder esta solicitud. Reformúlala o procesa el caso manualmente." : respuesta.texto
      if (respuesta.parada === "limite_tokens") reply += "\n\n_(respuesta truncada por límite de tokens)_"
      terminado = true
      break
    }

    const resultados: BloqueUsuario[] = []
    for (const llamada of respuesta.llamadas) {
      deps.emitir?.({ tipo: "tool_call", id: llamada.id, nombre: llamada.nombre, args: llamada.args })
      const visible = await ejecutarLlamada(llamada, deps, sesion, confirmables)
      if (!visible.bloqueada) actualizarPendientes(pendientes, llamada.nombre, llamada.args, visible.resultado)
      llamadas.push(visible)
      deps.emitir?.({ tipo: "tool_result", llamada: visible })
      resultados.push({ tipo: "resultado", idLlamada: llamada.id, contenido: visible.resultado, esError: !visible.ok })
    }
    sesion.mensajesLLM.push({ rol: "usuario", bloques: resultados })
  }
  if (!terminado && !error) reply = resumenTope(llamadas, deps.directorio, config.maxIteraciones)

  const procesados = leerProcesados(rutas(deps.directorio))
  sesion.pendientes = [...pendientes.values()].filter((p) => !procesados[p.mensaje_id])
  const needsConfirmation = sesion.pendientes.length > 0
  sesion.visible.push({ rol: "agente", texto: reply, ts: new Date().toISOString(), toolCalls: llamadas, needsConfirmation, pendientes: sesion.pendientes, error })
  return {
    reply,
    toolCalls: llamadas,
    needsConfirmation,
    pendientes: sesion.pendientes,
    error,
    uso: { entrada: usoTurno.entrada, salida: usoTurno.salida, sesion: sesion.tokens.entrada + sesion.tokens.salida, tope: config.maxTokensSesion },
  }
}
