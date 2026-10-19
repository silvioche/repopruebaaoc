/**
 * Clasificación RN1–RN4 y cálculo de campos que requieren revisión (RN5).
 * El contrato propuesto (que puede venir del modelo o del humano) se compara siempre
 * contra la extracción determinista: cualquier valor que difiera exige confirmación.
 */
import { reglas } from "./reglas.ts"
import { leerCorreo, leerMaestro, type Rutas } from "./repositorio.ts"
import { adjuntoDeContrato, extraerMensaje, type Extraccion } from "./extraccion.ts"
import { similitud } from "./texto.ts"
import {
  CAMPOS_CONFIANZA,
  fallo,
  ok,
  type CampoConfianza,
  type Contrato,
  type Diferencia,
  type FilaMaestro,
  type MotivoRevision,
  type Resultado,
  type ResultadoValidacion,
} from "./tipos.ts"

export function valorComoTexto(c: Contrato, campo: CampoConfianza): string {
  const v = c[campo]
  if (v === null || v === undefined) return ""
  if (campo === "tipo_poliza") return String(v).split(";").map((t) => t.trim()).filter(Boolean).sort().join(";")
  return String(v)
}

function valorEnMaestro(fila: FilaMaestro, campo: CampoConfianza): string {
  if (campo === "tipo_poliza") return fila.tipo_poliza.split(";").filter(Boolean).sort().join(";")
  return fila[campo]
}

/** Campos que no aplican a la revisión: en un otrosí, lo que no menciona se conserva. */
function campoAplica(c: Contrato, campo: CampoConfianza): boolean {
  if (campo === "id_contrato" && c.id_contrato === null) return false
  if (c.tipo_documento === "otrosi" && c[campo] === null) return false
  return true
}

function revisionPorConfianza(base: Contrato): MotivoRevision[] {
  return CAMPOS_CONFIANZA.filter((campo) => campoAplica(base, campo))
    .filter((campo) => (base.confianza[campo] ?? 0) < reglas.umbral_confianza)
    .map((campo) => ({
      campo,
      valor_propuesto: valorComoTexto(base, campo),
      confianza: base.confianza[campo] ?? 0,
      motivo: base[campo] === null ? "no se encontró en el documento" : `confianza ${base.confianza[campo]} < ${reglas.umbral_confianza}`,
    }))
}

function revisionPorCambios(base: Contrato, propuesto: Contrato): MotivoRevision[] {
  return CAMPOS_CONFIANZA.filter((campo) => valorComoTexto(base, campo) !== valorComoTexto(propuesto, campo)).map((campo) => ({
    campo,
    valor_propuesto: valorComoTexto(propuesto, campo),
    confianza: null,
    motivo: `difiere de lo extraído del documento ("${valorComoTexto(base, campo)}"); requiere confirmación humana`,
  }))
}

function diferenciasConMaestro(c: Contrato, fila: FilaMaestro): Diferencia[] {
  const campos: CampoConfianza[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"]
  return campos
    .filter((campo) => c[campo] !== null && valorComoTexto(c, campo) !== valorEnMaestro(fila, campo))
    .map((campo) => ({ campo, maestro: fila[campo], documento: valorComoTexto(c, campo) }))
}

/** Conflictos que nunca se resuelven solos: misma clave de contrato pero distinta contraparte o moneda. */
function conflictos(diferencias: Diferencia[]): MotivoRevision[] {
  return diferencias
    .filter((d) => d.campo === "nit_cliente" || d.campo === "moneda")
    .map((d) => ({ campo: d.campo, valor_propuesto: d.documento, confianza: null, motivo: `conflicto con el maestro (registrado: "${d.maestro}")` }))
}

function unicos(motivos: MotivoRevision[]): MotivoRevision[] {
  const vistos = new Set<string>()
  return motivos.filter((m) => (vistos.has(m.campo) ? false : (vistos.add(m.campo), true)))
}

function rechazo(motivo: string, advertencias: string[] = []): ResultadoValidacion {
  return { clasificacion: "rechazado", motivo, requiere_revision: [], revision_detalle: [], advertencias }
}

function buscarCoincidencia(c: Contrato, maestro: FilaMaestro[]): { fila: FilaMaestro; por: string } | null {
  const porId = c.id_contrato ? maestro.find((f) => f.id_contrato === c.id_contrato) : undefined
  if (porId) return { fila: porId, por: "id_contrato" }
  if (!c.nit_cliente || !c.objeto) return null
  const porObjeto = maestro.find(
    (f) => f.nit_cliente === c.nit_cliente && similitud(f.objeto, c.objeto ?? "") >= reglas.similitud_objeto_actualizacion,
  )
  return porObjeto ? { fila: porObjeto, por: "nit_cliente + objeto similar" } : null
}

export function clasificar(c: Contrato, base: Contrato, maestro: FilaMaestro[], advertencias: string[]): ResultadoValidacion {
  if (!c.cliente && !c.objeto && !c.id_contrato) return rechazo("RN4: el texto no contiene partes ni objeto identificables", advertencias)
  const revision = [...revisionPorConfianza(base), ...revisionPorCambios(base, c)]
  const coincidencia = buscarCoincidencia(c, maestro)

  if (!coincidencia) {
    if (c.tipo_documento === "otrosi") {
      return rechazo(`otrosí del contrato ${c.id_contrato ?? "(sin número)"}, que no existe en el maestro: solicitar el contrato original`, advertencias)
    }
    const detalle = unicos(revision)
    return { clasificacion: "nuevo", motivo: "RN3: no hay coincidencia en el maestro", requiere_revision: detalle.map((d) => d.campo), revision_detalle: detalle, advertencias }
  }

  const { fila, por } = coincidencia
  const diferencias = diferenciasConMaestro(c, fila)
  const mismasCondiciones = ["valor", "fecha_inicio", "fecha_fin"].every((campo) => !diferencias.some((d) => d.campo === campo))
  if (c.tipo_documento !== "otrosi" && por === "id_contrato" && mismasCondiciones) {
    return {
      clasificacion: "duplicado",
      motivo: `RN1: ${fila.id_contrato} ya está en el maestro con el mismo valor, fecha_inicio y fecha_fin`,
      id_contrato_existente: fila.id_contrato,
      requiere_revision: [],
      revision_detalle: [],
      diferencias,
      advertencias,
    }
  }
  if (diferencias.length === 0) {
    return { ...rechazo(`RN1: el documento no cambia ningún dato de ${fila.id_contrato}`, advertencias), clasificacion: "duplicado", id_contrato_existente: fila.id_contrato, diferencias }
  }
  const detalle = unicos([...revision, ...conflictos(diferencias)])
  return {
    clasificacion: "actualizacion",
    motivo: c.tipo_documento === "otrosi" ? `RN2: otrosí que modifica ${fila.id_contrato}` : `RN2: coincide con ${fila.id_contrato} por ${por} y cambia ${diferencias.map((d) => d.campo).join(", ")}`,
    id_contrato_existente: fila.id_contrato,
    requiere_revision: detalle.map((d) => d.campo),
    revision_detalle: detalle,
    diferencias,
    advertencias,
  }
}

export interface Evaluacion {
  validacion: ResultadoValidacion
  extraccion: Extraccion | null
  propuesto: Contrato | null
}

function advertenciasDe(e: Extraccion): string[] {
  const avisos: string[] = []
  if (e.contrato.comercial === null) avisos.push(`remitente ${e.correo.de} no está en comerciales.json; se registra sin comercial (no bloquea)`)
  return avisos
}

/** Evalúa un mensaje con el contrato propuesto (o el extraído si no se envía ninguno). */
export function evaluarMensaje(r: Rutas, mensajeId: string, propuesto?: Contrato): Resultado<Evaluacion> {
  const correo = leerCorreo(r, mensajeId)
  if (!correo) return fallo(`no existe el mensaje ${mensajeId} en el buzón`)
  if (!adjuntoDeContrato(r, correo)) {
    const motivo = `RN4: sin adjunto de contrato (adjuntos: ${correo.adjuntos.join(", ") || "ninguno"})`
    return ok({ validacion: rechazo(motivo), extraccion: null, propuesto: null })
  }
  const extraccion = extraerMensaje(r, mensajeId)
  if (!extraccion.ok) return extraccion
  const contrato = propuesto ? { ...propuesto, comercial: extraccion.data.contrato.comercial, tipo_documento: extraccion.data.contrato.tipo_documento } : extraccion.data.contrato
  const validacion = clasificar(contrato, extraccion.data.contrato, leerMaestro(r), advertenciasDe(extraccion.data))
  return ok({ validacion, extraccion: extraccion.data, propuesto: contrato })
}
