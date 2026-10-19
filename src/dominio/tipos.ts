import { z } from "zod"

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
export const CLASIFICACIONES = ["nuevo", "actualizacion", "duplicado", "rechazado"] as const

/** Campos del contrato que llevan nivel de confianza y pueden exigir revisión humana. */
export const CAMPOS_CONFIANZA = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const
export type CampoConfianza = (typeof CAMPOS_CONFIANZA)[number]

export const COLUMNAS_MAESTRO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
] as const
export type ColumnaMaestro = (typeof COLUMNAS_MAESTRO)[number]
export type FilaMaestro = Record<ColumnaMaestro, string>

function esFechaReal(iso: string): boolean {
  const [a, m, d] = iso.split("-").map(Number)
  const fecha = new Date(Date.UTC(a, m - 1, d))
  return fecha.getUTCFullYear() === a && fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d
}

export const FechaISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha inválida: se espera YYYY-MM-DD")
  .refine(esFechaReal, "fecha inválida: el día no existe en el calendario")

const Confianza = z.number().min(0).max(1)

export const ConfianzaPorCampo = z
  .object(Object.fromEntries(CAMPOS_CONFIANZA.map((c) => [c, Confianza.optional()])) as Record<CampoConfianza, z.ZodOptional<typeof Confianza>>)
  .describe("Confianza en [0,1] por campo; < 0.8 exige revisión humana")

export const Contrato = z.object({
  id_contrato: z.string().min(1).nullable().describe("Número del contrato tal como aparece en el documento; null si no tiene"),
  cliente: z.string().min(1).nullable().describe("Razón social de la contraparte"),
  nit_cliente: z.string().regex(/^\d+$/, "nit_cliente: solo dígitos, sin puntos ni DV").nullable().describe("Identificador tributario sin DV ni puntos"),
  pais: z.enum(PAISES, { message: "país desconocido" }).nullable().describe("CO|EC|PE|PA|HN"),
  objeto: z.string().max(200, "objeto: máximo 200 caracteres").nullable().describe("Objeto del contrato, máx. 200 caracteres"),
  valor: z.number().nonnegative().nullable().describe("Valor sin separadores; 0 si es por demanda"),
  valor_indeterminado: z.boolean().describe("true si el contrato es por demanda / sin valor determinado"),
  moneda: z.enum(MONEDAS, { message: "moneda desconocida" }).nullable().describe("COP|USD|PEN|PAB|HNL"),
  fecha_inicio: FechaISO.nullable().describe("YYYY-MM-DD"),
  fecha_fin: FechaISO.nullable().describe("YYYY-MM-DD"),
  plazo_meses: z.number().int().positive().nullable().describe("Plazo expresado en meses, si el documento lo dice"),
  requiere_poliza: z.boolean().nullable().describe("true si el contrato exige póliza"),
  tipo_poliza: z.string().describe("Tipos de póliza separados por ';' (vacío si no aplica)"),
  tipo_documento: z.enum(["contrato", "otrosi"]).describe("contrato u otrosí (modificación de uno existente)"),
  comercial: z.string().nullable().describe("Nombre del comercial resuelto desde comerciales.json; null si el remitente no está registrado"),
  confianza: ConfianzaPorCampo,
  notas: z.array(z.string()).optional().describe("Observaciones de la extracción"),
})
export type Contrato = z.infer<typeof Contrato>

export interface Correo {
  id: string
  de: string
  para: string
  asunto: string
  fecha: string
  cuerpo: string
  adjuntos: string[]
}

export interface Comercial {
  email: string
  nombre: string
  region: string
}

export interface Diferencia {
  campo: string
  maestro: string
  documento: string
}

export interface MotivoRevision {
  campo: string
  valor_propuesto: string
  confianza: number | null
  motivo: string
}

export interface ResultadoValidacion {
  clasificacion: (typeof CLASIFICACIONES)[number]
  motivo: string
  id_contrato_existente?: string
  requiere_revision: string[]
  revision_detalle: MotivoRevision[]
  diferencias?: Diferencia[]
  advertencias: string[]
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string; detalle?: unknown }

export function ok<T>(data: T): Resultado<T> {
  return { ok: true, data }
}

export function fallo<T = never>(error: string, detalle?: unknown): Resultado<T> {
  return detalle === undefined ? { ok: false, error } : { ok: false, error, detalle }
}
