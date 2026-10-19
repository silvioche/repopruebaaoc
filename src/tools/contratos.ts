/**
 * Herramientas del agente de registro de contratos.
 * Cada export es una herramienta; el modelo la ve como `contratos_<export>`.
 * Son la única fuente de valores que el agente puede afirmar (CA2).
 */
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { generarAlertas } from "../dominio/alertas.ts"
import { leerBuzon } from "../dominio/buzon.ts"
import { extraerMensaje } from "../dominio/extraccion.ts"
import { definirHerramienta } from "../dominio/herramienta.ts"
import { reglas } from "../dominio/reglas.ts"
import { registrarMensaje } from "../dominio/registro.ts"
import { validarIdMensaje } from "../dominio/repositorio.ts"
import { Contrato, FechaISO, fallo, ok, type CampoConfianza } from "../dominio/tipos.ts"
import { evaluarMensaje } from "../dominio/validacion.ts"

const MensajeId = z.string().describe("Identificador del mensaje del buzón, p. ej. msg-001")

function hoySistema(): string {
  return new Date().toISOString().slice(0, 10)
}

export const leer_buzon = definirHerramienta("leer_buzon", {
  description: "Lista los mensajes del buzón aún no procesados, con remitente, asunto, adjuntos y si traen contrato.",
  args: {},
  ejecutar: (_args, r) => ok(leerBuzon(r)),
  resumen: (d) => `${d.mensajes.length} pendientes (${d.mensajes.filter((m) => !m.tiene_contrato).length} sin contrato), ${d.ya_procesados.length} ya procesados`,
})

export const extraer = definirHerramienta("extraer", {
  description: "Extrae de forma determinista los datos estructurados del contrato u otrosí adjunto a un mensaje, con confianza por campo.",
  args: { mensaje_id: MensajeId },
  ejecutar: ({ mensaje_id }, r) => {
    const invalido = validarIdMensaje(mensaje_id)
    if (invalido) return fallo(invalido)
    const x = extraerMensaje(r, mensaje_id)
    if (!x.ok) return x
    const { contrato, adjunto } = x.data
    const baja = (Object.entries(contrato.confianza) as [CampoConfianza, number][])
      .filter(([campo, conf]) => conf < reglas.umbral_confianza && !(contrato.tipo_documento === "otrosi" && contrato[campo] === null) && !(campo === "id_contrato" && contrato.id_contrato === null))
      .map(([campo]) => campo)
    return ok({ mensaje_id, archivo: adjunto.nombre, contrato, campos_baja_confianza: baja })
  },
  resumen: (d) => `${d.contrato.id_contrato ?? "sin número"} · ${d.contrato.cliente ?? "?"} · baja confianza: ${d.campos_baja_confianza.join(", ") || "ninguno"}`,
})

export const validar = definirHerramienta("validar", {
  description: "Clasifica un mensaje como nuevo, actualizacion, duplicado o rechazado contra el maestro y lista los campos que requieren revisión humana.",
  args: {
    mensaje_id: MensajeId,
    contrato: Contrato.optional().describe("Contrato devuelto por contratos_extraer (con correcciones del usuario si las hay). Si se omite, se usa la extracción del documento."),
  },
  ejecutar: ({ mensaje_id, contrato }, r) => {
    const invalido = validarIdMensaje(mensaje_id)
    if (invalido) return fallo(invalido)
    const ev = evaluarMensaje(r, mensaje_id, contrato)
    return ev.ok ? ok({ mensaje_id, ...ev.data.validacion }) : ev
  },
  resumen: (d) => `${d.mensaje_id}: ${d.clasificacion}${d.requiere_revision.length ? ` · revisar ${d.requiere_revision.join(", ")}` : ""}`,
})

export const registrar = definirHerramienta("registrar", {
  description: "Registra o actualiza el contrato en el maestro de SharePoint, archiva el documento y marca el mensaje como procesado; exige confirmado=true si hay campos en revisión.",
  args: {
    mensaje_id: MensajeId,
    contrato: Contrato.optional().describe("Valores a registrar. Si se omite se usan los extraídos del documento. Todo valor distinto al extraído exige confirmado=true."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente en su último mensaje los campos en revisión"),
    hoy: FechaISO.optional().describe("Fecha de registro YYYY-MM-DD (la fecha de hoy indicada por el usuario); por defecto la del sistema"),
  },
  ejecutar: ({ mensaje_id, contrato, confirmado, hoy }, r) => {
    const invalido = validarIdMensaje(mensaje_id)
    if (invalido) return fallo(invalido)
    return registrarMensaje(r, { mensajeId: mensaje_id, contrato, confirmado: confirmado === true, hoy: hoy ?? hoySistema() })
  },
  resumen: (d) => `${d.accion}${d.id_contrato ? ` ${d.id_contrato}` : ""}${d.ruta_archivo ? ` → ${d.ruta_archivo}` : ""}`,
})

export const alertas = definirHerramienta("alertas", {
  description: "Genera out/alertas.md con contratos que vencen en ≤ 60 días, pólizas exigidas no vigentes y registros desde el corte del maestro.",
  args: { hoy: FechaISO.describe("Fecha de referencia YYYY-MM-DD") },
  ejecutar: ({ hoy }, r) => ok(generarAlertas(r, hoy)),
  resumen: (d) => `vencen ${d.vencen.length} · pólizas pendientes ${d.polizas_pendientes.length} · registrados desde corte ${d.registrados_desde_corte.length}`,
})

export const leer_pdf = definirHerramienta("leer_pdf", {
  description: "Devuelve el texto de un adjunto del buzón (ruta relativa al buzón, p. ej. msg-001/contrato.txt) para revisarlo literalmente.",
  args: { ruta: z.string().describe("Ruta relativa al buzón: <mensaje_id>/<adjunto>") },
  ejecutar: ({ ruta }, r) => {
    const [id, adjunto, ...resto] = ruta.split(/[\\/]/)
    const invalido = validarIdMensaje(id ?? "")
    if (invalido || !adjunto || resto.length > 0 || adjunto.startsWith(".")) return fallo(`ruta inválida: "${ruta}" (formato <mensaje_id>/<adjunto>)`)
    const archivo = path.join(r.buzon, id, adjunto)
    if (!fs.existsSync(archivo)) return fallo(`no existe ${ruta}`)
    if (adjunto.toLowerCase().endsWith(".pdf")) return fallo("PDF nativo no soportado en esta versión; usa el texto extraído (.txt)")
    const texto = fs.readFileSync(archivo, "utf8")
    if (texto.trim() === "") return fallo(`el adjunto ${ruta} está vacío`)
    return ok({ ruta, texto })
  },
  resumen: (d) => `${d.ruta}: ${d.texto.length} caracteres`,
})
