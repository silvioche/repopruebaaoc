/** Escritura en el maestro simulado de SharePoint, archivo del documento e historial (HU-4). */
import path from "node:path"
import {
  agregarJsonl,
  archivarDocumento,
  escribirMaestro,
  leerJsonl,
  leerMaestro,
  leerProcesados,
  marcarProcesado,
  type Rutas,
} from "./repositorio.ts"
import { slug } from "./texto.ts"
import { evaluarMensaje } from "./validacion.ts"
import { fallo, ok, type Contrato, type FilaMaestro, type Resultado } from "./tipos.ts"

export interface ResultadoRegistro {
  id_contrato: string | null
  accion: "insertado" | "actualizado" | "sin_cambios_duplicado" | "rechazado"
  clasificacion: string
  ruta_archivo: string | null
  cambios?: Record<string, { antes: string; despues: string }>
  advertencias: string[]
}

interface EntradaHistorial {
  ts: string
  id_contrato: string
  accion: string
  cambios: Record<string, { antes: string; despues: string }>
  mensaje_id: string
  ruta_archivo?: string
  fecha_registro?: string
}

function siguienteAutoId(maestro: FilaMaestro[], anio: string): string {
  const prefijo = `AUTO-${anio}-`
  const usados = maestro.filter((f) => f.id_contrato.startsWith(prefijo)).map((f) => Number(f.id_contrato.slice(prefijo.length)))
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`
}

function filaDesdeContrato(c: Contrato, id: string, ruta: string, hoy: string): FilaMaestro {
  return {
    id_contrato: id,
    cliente: c.cliente ?? "",
    nit_cliente: c.nit_cliente ?? "",
    pais: c.pais ?? "",
    objeto: c.objeto ?? "",
    valor: String(c.valor ?? 0),
    moneda: c.moneda ?? "",
    fecha_inicio: c.fecha_inicio ?? "",
    fecha_fin: c.fecha_fin ?? "",
    requiere_poliza: String(c.requiere_poliza === true),
    tipo_poliza: c.requiere_poliza ? c.tipo_poliza : "",
    estado_poliza: c.requiere_poliza ? "pendiente" : "no_aplica",
    comercial: c.comercial ?? "",
    ruta_sharepoint: ruta,
    fecha_registro: hoy,
    fuente: "buzon",
  }
}

/** Aplica sobre la fila los campos presentes en el documento; los null se conservan. */
function aplicarCambios(fila: FilaMaestro, c: Contrato): { nueva: FilaMaestro; cambios: Record<string, { antes: string; despues: string }> } {
  const nueva = { ...fila }
  const propuestos: Partial<FilaMaestro> = {
    cliente: c.cliente ?? undefined,
    nit_cliente: c.nit_cliente ?? undefined,
    pais: c.pais ?? undefined,
    objeto: c.objeto ?? undefined,
    valor: c.valor === null ? undefined : String(c.valor),
    moneda: c.moneda ?? undefined,
    fecha_inicio: c.fecha_inicio ?? undefined,
    fecha_fin: c.fecha_fin ?? undefined,
    requiere_poliza: c.requiere_poliza === null ? undefined : String(c.requiere_poliza),
    tipo_poliza: c.requiere_poliza === null ? undefined : c.tipo_poliza,
  }
  const cambios: Record<string, { antes: string; despues: string }> = {}
  for (const [campo, valor] of Object.entries(propuestos) as [keyof FilaMaestro, string | undefined][]) {
    if (valor !== undefined && valor !== fila[campo]) {
      cambios[campo] = { antes: fila[campo], despues: valor }
      nueva[campo] = valor
    }
  }
  // Si el plazo se amplía y hay pólizas, deben ampliarse: quedan pendientes hasta que se acredite.
  const amplia = cambios.fecha_fin && nueva.requiere_poliza === "true" && nueva.estado_poliza === "vigente"
  if (amplia) {
    cambios.estado_poliza = { antes: nueva.estado_poliza, despues: "pendiente" }
    nueva.estado_poliza = "pendiente"
  }
  if (nueva.requiere_poliza === "false" && nueva.estado_poliza !== "no_aplica") {
    cambios.estado_poliza = { antes: nueva.estado_poliza, despues: "no_aplica" }
    nueva.estado_poliza = "no_aplica"
  }
  return { nueva, cambios }
}

function rutaArchivo(c: Contrato, id: string, adjunto: string, historial: EntradaHistorial[]): string {
  const anio = (c.fecha_inicio ?? "").slice(0, 4) || "sin-fecha"
  const ext = path.extname(adjunto) || ".txt"
  const carpeta = `Contratos/${anio}/${slug(c.cliente ?? "sin-cliente")}`
  if (c.tipo_documento !== "otrosi") return `${carpeta}/${id}${ext}`
  const previos = historial.filter((h) => h.id_contrato === id && h.ruta_archivo?.includes("-otrosi-")).length
  return `${carpeta}/${id}-otrosi-${previos + 1}${ext}`
}

export interface OpcionesRegistro {
  mensajeId: string
  contrato?: Contrato
  confirmado: boolean
  hoy: string
}

export function registrarMensaje(r: Rutas, op: OpcionesRegistro): Resultado<ResultadoRegistro> {
  const previo = leerProcesados(r)[op.mensajeId]
  if (previo) return fallo(`el mensaje ${op.mensajeId} ya fue procesado (${previo.accion}, ${previo.ts}); no se escribe de nuevo`)
  const evaluacion = evaluarMensaje(r, op.mensajeId, op.contrato)
  if (!evaluacion.ok) return evaluacion
  const { validacion, extraccion, propuesto } = evaluacion.data
  const ts = new Date().toISOString()

  if (validacion.clasificacion === "rechazado" || validacion.clasificacion === "duplicado" || !extraccion || !propuesto) {
    const accion = validacion.clasificacion === "duplicado" ? "sin_cambios_duplicado" : "rechazado"
    const id = validacion.id_contrato_existente ?? null
    marcarProcesado(r, op.mensajeId, { ts, clasificacion: validacion.clasificacion, accion, id_contrato: id })
    return ok({ id_contrato: id, accion, clasificacion: validacion.clasificacion, ruta_archivo: null, advertencias: [validacion.motivo, ...validacion.advertencias] })
  }

  if (validacion.requiere_revision.length > 0 && !op.confirmado) {
    return fallo(`requiere revisión: ${validacion.requiere_revision.join(", ")}`, {
      clasificacion: validacion.clasificacion,
      requiere_revision: validacion.requiere_revision,
      revision_detalle: validacion.revision_detalle,
    })
  }

  const maestro = leerMaestro(r)
  const historial = leerJsonl<EntradaHistorial>(r.historial)
  const hoy = op.hoy

  if (validacion.clasificacion === "nuevo") {
    const id = propuesto.id_contrato ?? siguienteAutoId(maestro, (propuesto.fecha_inicio ?? hoy).slice(0, 4))
    if (maestro.some((f) => f.id_contrato === id)) return fallo(`ya existe una fila con id_contrato ${id}; no se duplica`)
    const ruta = archivarDocumento(r, extraccion.adjunto.ruta, rutaArchivo(propuesto, id, extraccion.adjunto.nombre, historial))
    const fila = filaDesdeContrato(propuesto, id, ruta, hoy)
    escribirMaestro(r, [...maestro, fila])
    const cambios = Object.fromEntries(Object.entries(fila).map(([k, v]) => [k, { antes: "", despues: v }]))
    agregarJsonl(r.historial, { ts, id_contrato: id, accion: "alta", cambios, mensaje_id: op.mensajeId, ruta_archivo: ruta, fecha_registro: hoy, confirmado_por_humano: op.confirmado })
    marcarProcesado(r, op.mensajeId, { ts, clasificacion: "nuevo", accion: "insertado", id_contrato: id })
    return ok({ id_contrato: id, accion: "insertado", clasificacion: "nuevo", ruta_archivo: ruta, advertencias: validacion.advertencias })
  }

  const id = validacion.id_contrato_existente ?? ""
  const indice = maestro.findIndex((f) => f.id_contrato === id)
  if (indice < 0) return fallo(`no se encontró ${id} en el maestro para actualizar`)
  const { nueva, cambios } = aplicarCambios(maestro[indice], propuesto)
  const ruta = archivarDocumento(r, extraccion.adjunto.ruta, rutaArchivo({ ...propuesto, cliente: nueva.cliente, fecha_inicio: nueva.fecha_inicio }, id, extraccion.adjunto.nombre, historial))
  maestro[indice] = nueva
  escribirMaestro(r, maestro)
  agregarJsonl(r.historial, { ts, id_contrato: id, accion: propuesto.tipo_documento === "otrosi" ? "actualizacion_otrosi" : "actualizacion", cambios, mensaje_id: op.mensajeId, ruta_archivo: ruta, fecha_registro: hoy, confirmado_por_humano: op.confirmado })
  marcarProcesado(r, op.mensajeId, { ts, clasificacion: "actualizacion", accion: "actualizado", id_contrato: id })
  return ok({ id_contrato: id, accion: "actualizado", clasificacion: "actualizacion", ruta_archivo: ruta, cambios, advertencias: validacion.advertencias })
}

