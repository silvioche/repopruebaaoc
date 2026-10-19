/**
 * Interfaz propia del proveedor de lenguaje. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor = escribir otra implementación de `AdaptadorLLM`.
 */

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema de los argumentos (derivado del esquema zod). */
  esquema: Record<string, unknown>
}

export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
}

export type BloqueUsuario =
  | { tipo: "texto"; texto: string }
  | { tipo: "resultado"; idLlamada: string; contenido: string; esError: boolean }

export type MensajeLLM =
  | { rol: "usuario"; bloques: BloqueUsuario[] }
  | {
      rol: "asistente"
      texto: string
      llamadas: LlamadaHerramienta[]
      /** Contenido nativo del proveedor, reenviado intacto en los turnos siguientes. */
      nativo?: unknown
    }

export interface UsoTokens {
  entrada: number
  salida: number
  cacheLeidos: number
}

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  parada: "fin" | "herramientas" | "limite_tokens" | "rechazo"
  uso: UsoTokens
  nativo?: unknown
}

export interface PeticionLLM {
  sistema: string
  mensajes: MensajeLLM[]
  herramientas: DefinicionHerramienta[]
  senal?: AbortSignal
}

export interface AdaptadorLLM {
  proveedor: string
  modelo: string
  enviar(peticion: PeticionLLM): Promise<RespuestaLLM>
}

export class ErrorProveedor extends Error {}
