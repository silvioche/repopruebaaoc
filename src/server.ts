/** API HTTP del agente + archivos estáticos del front. Sin frameworks: node:http. */
import { timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarTurno, type EventoAgente } from "./agente/ciclo.ts"
import { cargarHerramientas } from "./agente/herramientas.ts"
import { cargarSistema } from "./agente/prompt.ts"
import { crearAlmacen, idSesionValido } from "./agente/sesiones.ts"
import { leerMaestro, rutas } from "./dominio/repositorio.ts"
import { crearAdaptador } from "./llm/index.ts"

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
try {
  process.loadEnvFile(path.join(RAIZ, ".env"))
} catch {
  // sin .env: se usan las variables del entorno
}

const CONFIG = {
  puerto: Number(process.env.PORT ?? 3000),
  maxIteraciones: Number(process.env.MAX_ITERACIONES ?? 25),
  maxTokensSesion: Number(process.env.MAX_TOKENS_SESION ?? 400_000),
  maxMensaje: 4000,
  peticionesPorMinuto: Number(process.env.RATE_LIMIT_POR_MINUTO ?? 20),
  claveAcceso: process.env.ACCESS_KEY ?? "",
  permitirReinicio: process.env.ALLOW_RESET !== "false",
}

const llm = crearAdaptador(process.env)
const herramientas = cargarHerramientas()
const sistema = cargarSistema(RAIZ)
const almacen = crearAlmacen(RAIZ)
const ocupadas = new Set<string>()
const ventanas = new Map<string, number[]>()

const ESTATICOS: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
}

// ---------- utilidades HTTP ----------

function json(res: http.ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: http.IncomingMessage, limite = 32_768): Promise<unknown> {
  let total = 0
  const trozos: Buffer[] = []
  for await (const trozo of req) {
    total += (trozo as Buffer).length
    if (total > limite) throw new Error("cuerpo demasiado grande")
    trozos.push(trozo as Buffer)
  }
  return trozos.length ? JSON.parse(Buffer.concat(trozos).toString("utf8")) : {}
}

function autorizado(req: http.IncomingMessage): boolean {
  if (!CONFIG.claveAcceso) return true
  const recibida = Buffer.from(String(req.headers["x-access-key"] ?? ""))
  const esperada = Buffer.from(CONFIG.claveAcceso)
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada)
}

function dentroDelLimite(req: http.IncomingMessage): boolean {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim()
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return recientes.length <= CONFIG.peticionesPorMinuto
}

interface PeticionChat {
  sessionId: string
  message: string
}

function validarChat(cuerpo: unknown): PeticionChat | string {
  if (typeof cuerpo !== "object" || cuerpo === null) return "cuerpo inválido"
  const { sessionId, message } = cuerpo as Record<string, unknown>
  if (typeof sessionId !== "string" || !idSesionValido(sessionId)) return "sessionId inválido"
  if (typeof message !== "string" || message.trim() === "") return "message vacío"
  if (message.length > CONFIG.maxMensaje) return `message supera ${CONFIG.maxMensaje} caracteres`
  return { sessionId, message: message.trim() }
}

// ---------- chat ----------

async function turno(peticion: PeticionChat, emitir?: (e: EventoAgente) => void) {
  const sesion = almacen.obtenerOCrear(peticion.sessionId)
  ocupadas.add(sesion.id)
  try {
    const respuesta = await ejecutarTurno(sesion, peticion.message, {
      llm,
      herramientas,
      sistema,
      directorio: RAIZ,
      config: { maxIteraciones: CONFIG.maxIteraciones, maxTokensSesion: CONFIG.maxTokensSesion },
      emitir,
    })
    almacen.guardar(sesion)
    return respuesta
  } finally {
    ocupadas.delete(sesion.id)
  }
}

async function manejarChat(req: http.IncomingMessage, res: http.ServerResponse, streaming: boolean): Promise<void> {
  if (!autorizado(req)) return json(res, 401, { error: "clave de acceso inválida (cabecera x-access-key)" })
  if (!dentroDelLimite(req)) return json(res, 429, { error: "demasiadas peticiones; espera un minuto" })
  const peticion = validarChat(await leerCuerpo(req))
  if (typeof peticion === "string") return json(res, 400, { error: peticion })
  if (ocupadas.has(peticion.sessionId)) return json(res, 409, { error: "la sesión ya está procesando un mensaje" })
  if (!streaming) return json(res, 200, await turno(peticion))

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" })
  const enviar = (evento: string, datos: unknown) => res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`)
  const latido = setInterval(() => res.write(": latido\n\n"), 15_000)
  try {
    const respuesta = await turno(peticion, (e) => enviar(e.tipo, e))
    enviar("fin", respuesta)
  } catch (e) {
    enviar("fin", { reply: `Error interno: ${e instanceof Error ? e.message : String(e)}`, toolCalls: [], needsConfirmation: false, pendientes: [], error: true })
  } finally {
    clearInterval(latido)
    res.end()
  }
}

// ---------- rutas ----------

async function enrutar(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname

  if (req.method === "GET" && ESTATICOS[ruta]) {
    const [archivo, tipo] = ESTATICOS[ruta]
    res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" })
    return void res.end(fs.readFileSync(path.join(RAIZ, "web", archivo)))
  }
  if (req.method === "GET" && ruta === "/api/health") {
    return json(res, 200, {
      ok: true,
      provider: llm.proveedor,
      model: llm.modelo,
      herramientas: [...herramientas.keys()],
      maxIteraciones: CONFIG.maxIteraciones,
      maxTokensSesion: CONFIG.maxTokensSesion,
      requiereClave: CONFIG.claveAcceso !== "",
      permiteReinicio: CONFIG.permitirReinicio,
    })
  }
  if (req.method === "POST" && ruta === "/api/chat") return manejarChat(req, res, false)
  if (req.method === "POST" && ruta === "/api/chat/stream") return manejarChat(req, res, true)

  const sesion = /^\/api\/sessions\/([^/]+)$/.exec(ruta)
  if (req.method === "GET" && sesion) {
    const s = idSesionValido(sesion[1]) ? almacen.obtener(sesion[1]) : null
    return s ? json(res, 200, { id: s.id, creada: s.creada, tokens: s.tokens, pendientes: s.pendientes, historial: s.visible }) : json(res, 404, { error: "sesión no encontrada" })
  }
  if (req.method === "GET" && ruta === "/api/maestro") return json(res, 200, { filas: leerMaestro(rutas(RAIZ)) })
  if (req.method === "GET" && ruta === "/api/alertas") {
    const archivo = rutas(RAIZ).alertas
    return json(res, 200, { markdown: fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8") : null })
  }
  if (req.method === "POST" && ruta === "/api/reset") {
    if (!autorizado(req)) return json(res, 401, { error: "clave de acceso inválida" })
    if (!CONFIG.permitirReinicio) return json(res, 403, { error: "reinicio deshabilitado en este despliegue" })
    if (ocupadas.size > 0) return json(res, 409, { error: "hay un turno en curso; intenta en unos segundos" })
    fs.rmSync(rutas(RAIZ).out, { recursive: true, force: true })
    almacen.limpiar()
    return json(res, 200, { ok: true })
  }
  json(res, 404, { error: "ruta no encontrada" })
}

const servidor = http.createServer((req, res) => {
  enrutar(req, res).catch((e: unknown) => {
    const mensaje = e instanceof SyntaxError ? "JSON inválido" : e instanceof Error ? e.message : "error interno"
    if (!res.headersSent) json(res, 400, { error: mensaje })
    else res.end()
  })
})
servidor.requestTimeout = 0
servidor.listen(CONFIG.puerto, () => {
  console.log(`Agente de contratos en http://localhost:${CONFIG.puerto} · proveedor ${llm.proveedor} (${llm.modelo}) · ${herramientas.size} herramientas`)
})
