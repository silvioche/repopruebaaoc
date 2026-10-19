/**
 * Envoltorio común de herramientas: valida argumentos con zod, nunca lanza,
 * devuelve JSON `{ ok, data | error }` y deja traza en out/log.jsonl (RN7 / CA4).
 */
import { z } from "zod"
import { agregarJsonl, rutas, type Rutas } from "./repositorio.ts"
import { fallo, type Resultado } from "./tipos.ts"

export interface ContextoHerramienta {
  /** Raíz del proyecto; todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
}

export interface Herramienta<A extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: A
  execute(args: z.input<z.ZodObject<A>>, ctx: ContextoHerramienta): Promise<string>
  /** Opcional: resumen de una línea de la salida de execute, para el chat y el log. */
  resumir?(salida: string): string
}

interface Definicion<A extends z.ZodRawShape, T> {
  description: string
  args: A
  ejecutar(args: z.output<z.ZodObject<A>>, r: Rutas, ctx: ContextoHerramienta): Resultado<T>
  resumen(data: T): string
}

function mensajeIdDe(args: unknown): string | null {
  if (typeof args !== "object" || args === null || !("mensaje_id" in args)) return null
  return typeof args.mensaje_id === "string" ? args.mensaje_id : null
}

export function definirHerramienta<A extends z.ZodRawShape, T>(nombre: string, def: Definicion<A, T>): Herramienta<A> {
  const esquema = z.object(def.args)
  return {
    description: def.description,
    args: def.args,
    async execute(args, ctx) {
      const r = rutas(ctx.directory)
      const parseado = esquema.safeParse(args ?? {})
      let resultado: Resultado<T>
      if (!parseado.success) {
        resultado = fallo(`argumentos inválidos: ${z.prettifyError(parseado.error)}`)
      } else {
        try {
          resultado = def.ejecutar(parseado.data, r, ctx)
        } catch (e) {
          resultado = fallo(`error interno en contratos_${nombre}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const resumen = resultado.ok ? def.resumen(resultado.data) : resultado.error
      try {
        agregarJsonl(r.log, { ts: new Date().toISOString(), herramienta: `contratos_${nombre}`, mensaje_id: mensajeIdDe(args), ok: resultado.ok, resumen, sesion: ctx.sessionId })
      } catch {
        // El log nunca debe tumbar la herramienta.
      }
      return JSON.stringify(resultado)
    },
    resumir(salida) {
      const r = JSON.parse(salida) as Resultado<T>
      return r.ok ? def.resumen(r.data) : r.error
    },
  }
}
