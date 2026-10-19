import fs from "node:fs"

/** Parámetros de negocio editables sin tocar código (src/knowledge/reglas.json). */
export interface Reglas {
  umbral_confianza: number
  dias_alerta_vencimiento: number
  fecha_corte_maestro: string
  similitud_objeto_actualizacion: number
  nit_propio: string
  tipos_poliza: Record<string, string>
  moneda_por_palabra: Record<string, string>
  moneda_por_pais: Record<string, string>
  pais_por_texto: Record<string, string>
}

export const reglas: Reglas = JSON.parse(
  fs.readFileSync(new URL("../knowledge/reglas.json", import.meta.url), "utf8"),
) as Reglas
