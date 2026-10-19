/** Lectura del buzón (HU-1): mensajes pendientes con su clasificación preliminar. */
import fs from "node:fs"
import { esAdjuntoDeContrato } from "./extraccion.ts"
import { leerCorreo, leerProcesados, listarIdsBuzon, rutaAdjunto, type Rutas } from "./repositorio.ts"

export interface MensajeBuzon {
  id: string
  de: string
  asunto: string
  fecha: string
  adjuntos: string[]
  tiene_contrato: boolean
  clasificacion_preliminar?: "rechazado"
  motivo?: string
}

function tieneContrato(r: Rutas, id: string, adjuntos: string[]): boolean {
  return adjuntos.some((nombre) => {
    const ruta = rutaAdjunto(r, id, nombre)
    if (!ruta) return false
    const texto = nombre.toLowerCase().endsWith(".txt") ? fs.readFileSync(ruta, "utf8") : null
    return esAdjuntoDeContrato(nombre, texto)
  })
}

export function leerBuzon(r: Rutas): { mensajes: MensajeBuzon[]; ya_procesados: string[] } {
  const procesados = leerProcesados(r)
  const mensajes: MensajeBuzon[] = []
  for (const id of listarIdsBuzon(r)) {
    if (procesados[id]) continue
    const correo = leerCorreo(r, id)
    if (!correo) continue
    const tiene = tieneContrato(r, id, correo.adjuntos)
    const base = { id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos, tiene_contrato: tiene }
    mensajes.push(
      tiene
        ? base
        : { ...base, clasificacion_preliminar: "rechazado", motivo: `sin adjunto de contrato (${correo.adjuntos.join(", ") || "sin adjuntos"})` },
    )
  }
  return { mensajes, ya_procesados: Object.keys(procesados).sort() }
}
