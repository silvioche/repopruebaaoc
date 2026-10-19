/** Descubre las herramientas exportadas en src/tools/ y las expone con nombre `<archivo>_<export>`. */
import { z } from "zod"
import type { ContextoHerramienta, Herramienta } from "../dominio/herramienta.ts"
import type { DefinicionHerramienta } from "../llm/adapter.ts"
import * as contratos from "../tools/contratos.ts"

export interface HerramientaRegistrada {
  definicion: DefinicionHerramienta
  ejecutar(args: unknown, ctx: ContextoHerramienta): Promise<string>
  resumir(salida: string): string
}

const MODULOS: Record<string, Record<string, Herramienta>> = { contratos }

function registrar(nombre: string, h: Herramienta): HerramientaRegistrada {
  const esquema = z.object(h.args)
  const { $schema: _omitido, ...jsonSchema } = z.toJSONSchema(esquema, { io: "input" })
  const ejecutar = h.execute as (args: unknown, ctx: ContextoHerramienta) => Promise<string>
  return {
    definicion: { nombre, descripcion: h.description, esquema: jsonSchema },
    async ejecutar(args, ctx) {
      // El backend valida antes de ejecutar; el error vuelve al modelo para que corrija.
      const v = esquema.safeParse(args ?? {})
      if (!v.success) return JSON.stringify({ ok: false, error: `argumentos inválidos: ${z.prettifyError(v.error)}` })
      return ejecutar(v.data, ctx)
    },
    resumir: (salida) => h.resumir?.(salida) ?? salida.slice(0, 160),
  }
}

export function cargarHerramientas(): Map<string, HerramientaRegistrada> {
  const mapa = new Map<string, HerramientaRegistrada>()
  for (const [archivo, modulo] of Object.entries(MODULOS)) {
    for (const [exportado, h] of Object.entries(modulo)) mapa.set(`${archivo}_${exportado}`, registrar(`${archivo}_${exportado}`, h))
  }
  return mapa
}
