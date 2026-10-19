/** Sesiones en memoria con respaldo en out/sesiones/<id>.json. */
import fs from "node:fs"
import path from "node:path"
import type { MensajeLLM } from "../llm/adapter.ts"
import type { MotivoRevision } from "../dominio/tipos.ts"

export interface LlamadaVisible {
  id: string
  nombre: string
  args: unknown
  ok: boolean
  resumen: string
  resultado: string
  bloqueada?: boolean
}

export interface PendienteConfirmacion {
  mensaje_id: string
  clasificacion: string
  campos: MotivoRevision[]
}

export interface TurnoVisible {
  rol: "usuario" | "agente"
  texto: string
  ts: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  pendientes?: PendienteConfirmacion[]
  error?: boolean
}

export interface Sesion {
  id: string
  creada: string
  mensajesLLM: MensajeLLM[]
  visible: TurnoVisible[]
  tokens: { entrada: number; salida: number }
  /** Mensajes que esperan confirmación humana al cierre del último turno. */
  pendientes: PendienteConfirmacion[]
}

const ID_SESION = /^[A-Za-z0-9_-]{1,64}$/

export function idSesionValido(id: string): boolean {
  return ID_SESION.test(id)
}

export function crearAlmacen(directorio: string) {
  const carpeta = path.join(directorio, "out", "sesiones")
  const memoria = new Map<string, Sesion>()
  const archivo = (id: string) => path.join(carpeta, `${id}.json`)

  return {
    obtener(id: string): Sesion | null {
      const enMemoria = memoria.get(id)
      if (enMemoria) return enMemoria
      if (!fs.existsSync(archivo(id))) return null
      const sesion = JSON.parse(fs.readFileSync(archivo(id), "utf8")) as Sesion
      memoria.set(id, sesion)
      return sesion
    },
    obtenerOCrear(id: string): Sesion {
      return this.obtener(id) ?? { id, creada: new Date().toISOString(), mensajesLLM: [], visible: [], tokens: { entrada: 0, salida: 0 }, pendientes: [] }
    },
    guardar(sesion: Sesion): void {
      memoria.set(sesion.id, sesion)
      fs.mkdirSync(carpeta, { recursive: true })
      fs.writeFileSync(archivo(sesion.id), JSON.stringify(sesion), "utf8")
    },
    limpiar(): void {
      memoria.clear()
    },
  }
}

export type Almacen = ReturnType<typeof crearAlmacen>
