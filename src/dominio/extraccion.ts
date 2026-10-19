/**
 * Extracción determinista (regex + heurísticas) de los datos de un contrato u otrosí.
 * Regla de oro: lo que no está en el texto queda en null con confianza 0; nada se inventa.
 */
import fs from "node:fs"
import path from "node:path"
import { reglas } from "./reglas.ts"
import { leerComerciales, leerCorreo, rutaAdjunto, type Rutas } from "./repositorio.ts"
import {
  fechasEnTexto,
  mesEnTexto,
  normalizar,
  palabrasANumero,
  parsearNumero,
  recortar,
  sumarDias,
  sumarMeses,
  tituloRazonSocial,
  ultimoDiaDelMes,
  type FechaEncontrada,
} from "./texto.ts"
import { MONEDAS, PAISES, fallo, ok, type CampoConfianza, type Contrato, type Correo, type Resultado } from "./tipos.ts"

class ErrorExtraccion extends Error {}

type Pais = (typeof PAISES)[number]
type Moneda = (typeof MONEDAS)[number]
type Confianzas = Partial<Record<CampoConfianza, number>>

// ---------- Clasificación de adjuntos ----------

const NO_CONTRATO = /\b(cotizacion|propuesta|oferta|factura|cuenta de cobro)\b/

/** Un adjunto es contrato si su encabezado (o su nombre, si no es texto) lo identifica como contrato u otrosí. */
export function esAdjuntoDeContrato(nombre: string, texto: string | null): boolean {
  const base = normalizar(path.parse(nombre).name)
  if (texto === null) return /\b(contrato|otrosi)\b/.test(base) && !NO_CONTRATO.test(base)
  const encabezado = normalizar(texto.trim().split("\n")[0] ?? "")
  if (NO_CONTRATO.test(encabezado)) return false
  return /\b(contrato|otrosi|otro si)\b/.test(encabezado) || (/\b(contrato|otrosi)\b/.test(base) && texto.trim() === "")
}

export interface AdjuntoContrato {
  nombre: string
  ruta: string
  texto: string
}

export function adjuntoDeContrato(r: Rutas, correo: Correo): AdjuntoContrato | null {
  for (const nombre of correo.adjuntos) {
    const ruta = rutaAdjunto(r, correo.id, nombre)
    if (!ruta) continue
    const texto = nombre.toLowerCase().endsWith(".txt") ? fs.readFileSync(ruta, "utf8") : null
    if (esAdjuntoDeContrato(nombre, texto)) return { nombre, ruta, texto: texto ?? "" }
  }
  return null
}

// ---------- Estructura del documento ----------

const ORDINALES = "PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA"

function dividirClausulas(texto: string): { preambulo: string; clausulas: string[] } {
  const partes = texto.split(new RegExp(`\\n\\s*(?=(?:${ORDINALES})\\.)`))
  return { preambulo: partes[0] ?? "", clausulas: partes.slice(1) }
}

function clausulaCon(clausulas: string[], palabra: RegExp): string | null {
  return clausulas.find((c) => palabra.test(c)) ?? null
}

// ---------- Partes ----------

interface Parte {
  nombre: string
  tipoId: string
  id: string
  segmento: string
}

const DELIMITADORES_PARTE = ["Entre los suscritos,", "Entre ", " y ", "), "]

function partesDelPreambulo(preambulo: string): Parte[] {
  const coincidencias = [...preambulo.matchAll(/\b(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\-]*\d)/g)]
  return coincidencias.map((m, i) => {
    const inicio = m.index ?? 0
    const antes = preambulo.slice(Math.max(0, inicio - 200), inicio)
    const corte = Math.max(...DELIMITADORES_PARTE.map((d) => (antes.lastIndexOf(d) >= 0 ? antes.lastIndexOf(d) + d.length : 0)))
    const nombre = antes
      .slice(corte)
      .replace(/,?\s*identificad[ao]\s+con\s*$/i, "")
      .trim()
      .replace(/,$/, "")
      .trim()
    const finSegmento = coincidencias[i + 1]?.index ?? Math.min(preambulo.length, inicio + 300)
    return { nombre, tipoId: m[1], id: m[2], segmento: preambulo.slice(inicio, finSegmento) }
  })
}

function nitSinDv(parte: Parte): string {
  const base = parte.tipoId === "NIT" ? parte.id.split("-")[0] : parte.id
  return base.replace(/\D/g, "")
}

function paisPorIdentificador(parte: Parte, nit: string): Pais | null {
  if (parte.tipoId === "NIT") return "CO"
  if (parte.tipoId === "RTN") return "HN"
  if (nit.length === 13) return "EC"
  if (nit.length === 11) return "PE"
  return "PA"
}

function paisPorTexto(segmento: string): Pais | null {
  const t = ` ${normalizar(segmento)} `
  for (const [clave, pais] of Object.entries(reglas.pais_por_texto)) {
    if (t.includes(` ${clave} `)) return pais as Pais
  }
  return null
}

/** Busca la razón social con su capitalización original en el bloque de firmas. */
function nombreEnFirmas(texto: string, nombre: string): string | null {
  const objetivo = normalizar(nombre)
  for (const linea of texto.split("\n")) {
    for (const celda of linea.split(/\s{2,}/)) {
      if (celda.trim() && normalizar(celda) === objetivo && celda.trim() !== nombre) return celda.trim()
    }
  }
  return null
}

interface DatosParte {
  cliente: string | null
  nit: string | null
  pais: Pais | null
  confianza: Confianzas
}

function extraerContraparte(texto: string, preambulo: string, notas: string[]): DatosParte {
  const contraparte = partesDelPreambulo(preambulo).find(
    (p) => nitSinDv(p) !== reglas.nit_propio && !/periferia/i.test(p.nombre),
  )
  if (!contraparte || !contraparte.nombre) {
    return { cliente: null, nit: null, pais: null, confianza: { cliente: 0, nit_cliente: 0, pais: 0 } }
  }
  const nit = nitSinDv(contraparte)
  const enFirmas = nombreEnFirmas(texto, contraparte.nombre)
  const porId = paisPorIdentificador(contraparte, nit)
  const porTexto = paisPorTexto(contraparte.segmento)
  let confPais = 0.85
  if (porTexto && porTexto === porId) confPais = 0.97
  else if (porTexto && porTexto !== porId) {
    confPais = 0.6
    notas.push(`país: el identificador sugiere ${porId} pero el domicilio sugiere ${porTexto}`)
  }
  return {
    cliente: enFirmas ?? tituloRazonSocial(contraparte.nombre),
    nit,
    pais: porId,
    confianza: { cliente: enFirmas ? 0.97 : 0.85, nit_cliente: 0.95, pais: confPais },
  }
}

// ---------- Objeto ----------

function extraerObjeto(clausulas: string[]): { objeto: string | null; confianza: number } {
  const cl = clausulaCon(clausulas, /\bOBJETO\b/)
  if (!cl) return { objeto: null, confianza: 0 }
  const limpio = cl
    .replace(/^[^.]+\.\s*OBJETO\.\s*/i, "")
    .replace(/^EL CONTRATISTA\s+(se obliga a\s+(ejecutar\s+)?|prestar[áa]\s+(el servicio de\s+)?)/i, "")
    .replace(/^(la|el|los|las)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
  if (!limpio) return { objeto: null, confianza: 0 }
  const { texto, recortado } = recortar(limpio.charAt(0).toUpperCase() + limpio.slice(1), 200)
  return { objeto: texto, confianza: recortado ? 0.85 : 0.9 }
}

// ---------- Valor y moneda ----------

interface DatosValor {
  valor: number | null
  indeterminado: boolean
  moneda: Moneda | null
  confianza: Confianzas
}

const VALOR_INDETERMINADO = /no tiene (un )?valor determinado|valor indeterminado|por demanda|cuant[ií]a indeterminada/i

function monedaValida(codigo: string): Moneda {
  if (!(MONEDAS as readonly string[]).includes(codigo)) throw new ErrorExtraccion(`moneda desconocida: ${codigo}`)
  return codigo as Moneda
}

function monedaPorPalabra(texto: string): Moneda | null {
  const t = ` ${normalizar(texto)} `
  for (const [palabra, moneda] of Object.entries(reglas.moneda_por_palabra)) {
    if (t.includes(` ${palabra} `)) return moneda as Moneda
  }
  return null
}

function extraerValor(texto: string, clausulas: string[], pais: Pais | null, notas: string[]): DatosValor {
  const cl = clausulaCon(clausulas, /\bVALOR\b/)
  if (!cl) return { valor: null, indeterminado: false, moneda: null, confianza: { valor: 0, moneda: 0 } }

  if (VALOR_INDETERMINADO.test(cl)) {
    notas.push("valor: contrato sin valor determinado (por demanda / órdenes de servicio); se registra 0")
    const codigo = /\b(COP|USD|PEN|PAB|HNL)\b/.exec(texto)?.[1] as Moneda | undefined
    if (codigo) notas.push(`moneda: inferida de otras cláusulas (${codigo})`)
    const moneda = codigo ?? ((pais && reglas.moneda_por_pais[pais]) as Moneda | undefined) ?? null
    return { valor: 0, indeterminado: true, moneda, confianza: { valor: 0.6, moneda: codigo ? 0.85 : moneda ? 0.6 : 0 } }
  }

  const cifra = /\(\s*([A-Z]{3})\s*\$?\s*(\d[\d.,]*)\s*\)/.exec(cl) ?? /\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*\d)/.exec(cl)
  const enLetras = /(?:es de|ser[áa] de|asciende a|por)\s+([A-ZÁÉÍÓÚÑ/\s]+?)\s*\(/.exec(cl)?.[1] ?? null
  const valorLetras = enLetras ? palabrasANumero(enLetras) : null
  const monedaLetras = enLetras ? monedaPorPalabra(enLetras) : null

  if (!cifra) {
    if (valorLetras === null) return { valor: null, indeterminado: false, moneda: monedaLetras, confianza: { valor: 0, moneda: monedaLetras ? 0.7 : 0 } }
    notas.push("valor: solo expresado en letras")
    return { valor: valorLetras, indeterminado: false, moneda: monedaLetras, confianza: { valor: 0.75, moneda: monedaLetras ? 0.8 : 0 } }
  }

  const moneda = monedaValida(cifra[1])
  const valor = parsearNumero(cifra[2])
  if (valor === null) throw new ErrorExtraccion(`valor ilegible: "${cifra[2]}"`)
  let confValor = 0.9
  if (valorLetras !== null && valorLetras === valor) confValor = 0.99
  else if (valorLetras !== null) {
    confValor = 0.6
    notas.push(`valor: en letras dice ${valorLetras} y en números ${valor}`)
  }
  let confMoneda = 0.95
  if (monedaLetras && monedaLetras !== moneda) {
    confMoneda = 0.6
    notas.push(`moneda: el código ${moneda} no coincide con las letras (${monedaLetras})`)
  }
  return { valor, indeterminado: false, moneda, confianza: { valor: confValor, moneda: confMoneda } }
}

// ---------- Fechas ----------

interface DatosFechas {
  inicio: string | null
  fin: string | null
  plazoMeses: number | null
  confianza: Confianzas
}

function verificarFechas(fechas: FechaEncontrada[]): void {
  const invalida = fechas.find((f) => !f.valida)
  if (invalida) throw new ErrorExtraccion(`fecha inválida en el documento: "${invalida.textual}"`)
}

function rolDeFecha(texto: string, fecha: FechaEncontrada): "desde" | "hasta" | null {
  const ventana = texto.slice(Math.max(0, fecha.indice - 35), fecha.indice).toLowerCase()
  const desde = ventana.lastIndexOf("desde")
  const hasta = ventana.lastIndexOf("hasta")
  if (desde < 0 && hasta < 0) return null
  return hasta > desde ? "hasta" : "desde"
}

function fechaDeFirma(texto: string): { exacta: string | null; mes: { anio: number; mes: number } | null } {
  const linea = texto.split("\n").find((l) => /se firma/i.test(l)) ?? ""
  const fechas = fechasEnTexto(linea)
  verificarFechas(fechas)
  return { exacta: fechas[0]?.iso ?? null, mes: fechas.length ? null : mesEnTexto(linea) }
}

function extraerFechas(texto: string, preambulo: string, clausulas: string[], esOtrosi: boolean, notas: string[]): DatosFechas {
  const cl = clausulaCon(clausulas, /\bPLAZO\b/) ?? ""
  const plazoTexto = /\((\d{1,3})\)\s*mes(es)?/i.exec(cl)?.[1] ?? /\b(\d{1,3})\s+meses\b/i.exec(cl)?.[1]
  const plazoMeses = plazoTexto ? Number(plazoTexto) : null
  const fechas = fechasEnTexto(cl)
  verificarFechas(fechas)

  let inicio = fechas.find((f) => rolDeFecha(cl, f) === "desde")?.iso ?? null
  let fin = fechas.find((f) => rolDeFecha(cl, f) === "hasta")?.iso ?? null
  const confianza: Confianzas = { fecha_inicio: inicio ? 0.95 : 0, fecha_fin: fin ? 0.95 : 0 }
  let inicioSoloMes = false

  if (!inicio && esOtrosi) {
    const suscrito = fechasEnTexto(preambulo).find((f) => /suscrit[oa]\s+el\s+[^(]*$/i.test(preambulo.slice(Math.max(0, f.indice - 40), f.indice)))
    if (suscrito) {
      inicio = suscrito.iso
      confianza.fecha_inicio = 0.9
    }
  }
  if (!inicio && /(a partir|desde)\s+de\s+la\s+(fecha\s+de\s+)?(su\s+)?firma|a partir de su firma/i.test(cl)) {
    const firma = fechaDeFirma(texto)
    if (firma.exacta) {
      inicio = firma.exacta
      confianza.fecha_inicio = 0.85
      notas.push("fecha_inicio: tomada de la fecha de firma")
    } else if (firma.mes) {
      inicio = `${firma.mes.anio}-${String(firma.mes.mes).padStart(2, "0")}-01`
      inicioSoloMes = true
      confianza.fecha_inicio = 0.8
      notas.push("fecha_inicio: la firma solo indica mes y año; se asume el día 1")
    }
  }

  if (inicio && fin && plazoMeses) {
    const esperado = sumarDias(sumarMeses(inicio, plazoMeses), -1)
    if (esperado === fin || sumarMeses(inicio, plazoMeses) === fin) confianza.fecha_fin = 0.98
    else {
      confianza.fecha_fin = 0.7
      notas.push(`fecha_fin: el plazo de ${plazoMeses} meses no cuadra con las fechas (${inicio} → ${fin})`)
    }
  } else if (!fin && inicio && plazoMeses) {
    if (inicioSoloMes) {
      const [a, m] = sumarMeses(inicio, plazoMeses).split("-").map(Number)
      fin = ultimoDiaDelMes(a, m)
      confianza.fecha_fin = 0.5
      notas.push(`fecha_fin: derivada de ${plazoMeses} meses sobre una firma sin día; se toma el último día del mes (${fin})`)
    } else {
      fin = sumarDias(sumarMeses(inicio, plazoMeses), -1)
      confianza.fecha_fin = 0.85
      notas.push(`fecha_fin: derivada de fecha_inicio + ${plazoMeses} meses`)
    }
  }
  if (fin && /prorrogable|pr[óo]rroga autom[áa]tica|prorrogar[áa] autom/i.test(cl)) {
    confianza.fecha_fin = Math.min(confianza.fecha_fin ?? 0, 0.75)
    notas.push("fecha_fin: el contrato tiene prórroga automática")
  }
  if (inicio && fin && fin < inicio) throw new ErrorExtraccion(`fecha inválida: fecha_fin ${fin} es anterior a fecha_inicio ${inicio}`)
  return { inicio, fin, plazoMeses, confianza }
}

// ---------- Póliza ----------

interface DatosPoliza {
  requiere: boolean | null
  tipos: string
  confianza: Confianzas
}

function correoMencionaPoliza(cuerpo: string): boolean | null {
  const t = normalizar(cuerpo)
  if (/\b(no (pide|requiere|lleva|necesita|exige)|sin) poliza/.test(t)) return false
  if (/\b(requiere|pide|lleva|exige|necesita) poliza|poliza de/.test(t)) return true
  return null
}

function extraerPoliza(texto: string, correo: Correo, esOtrosi: boolean, notas: string[]): DatosPoliza {
  const oraciones = texto.split(/(?<=\.)\s+/).filter((o) => /p[óo]liza|garant[ií]a/i.test(o))
  const exigidas = oraciones.filter((o) => !/\bno (requiere|exige|se exige)|\bsin (p[óo]liza|garant)/i.test(o))
  const unidas = ` ${normalizar(exigidas.join(" "))} `
  const tipos: { tipo: string; pos: number }[] = []
  for (const [clave, tipo] of Object.entries(reglas.tipos_poliza)) {
    const pos = unidas.indexOf(` ${normalizar(clave)} `)
    if (pos >= 0 && !tipos.some((t) => t.tipo === tipo)) tipos.push({ tipo, pos })
  }
  const requiere = tipos.length > 0 || exigidas.some((o) => /constitu|otorgar|expedir/i.test(o))
  let conf = requiere ? 0.95 : 0.9
  if (requiere && exigidas.some((o) => /cuyo valor supere|para cada orden|en caso de que|cuando el valor/i.test(o))) {
    conf = 0.8
    notas.push("póliza: exigencia condicionada (solo para órdenes que superen un monto)")
  }
  if (requiere && esOtrosi) conf = 0.85
  const segunCorreo = correoMencionaPoliza(correo.cuerpo)
  if (segunCorreo !== null && segunCorreo !== requiere) {
    conf = 0.6
    notas.push(`póliza: el correo dice ${segunCorreo ? "que requiere" : "que no requiere"} póliza y el documento lo contrario`)
  }
  const lista = tipos.sort((a, b) => a.pos - b.pos).map((t) => t.tipo).join(";")
  return { requiere, tipos: requiere ? lista : "", confianza: { requiere_poliza: conf, tipo_poliza: requiere && !lista ? 0.5 : conf } }
}

// ---------- Ensamblado ----------

function esOtrosi(texto: string, adjunto: string): boolean {
  return /^\s*otro\s*s[ií]\b/i.test(texto) || /otrosi/.test(normalizar(adjunto))
}

export interface Extraccion {
  contrato: Contrato
  adjunto: AdjuntoContrato
  correo: Correo
}

export function extraerDeTexto(texto: string, adjunto: string, correo: Correo, comercial: string | null): Contrato {
  if (texto.trim() === "") throw new ErrorExtraccion(`el adjunto ${adjunto} está vacío`)
  const notas: string[] = []
  const otrosi = esOtrosi(texto, adjunto)
  const { preambulo, clausulas } = dividirClausulas(texto)
  const encabezado = texto.slice(0, 400)
  const id = /No\.?\s*([A-Z]{1,5}-\d{4}-\d{1,5})/.exec(encabezado)?.[1] ?? null
  if (!id) notas.push("id_contrato: el documento no trae número; se asignará AUTO-<año>-<secuencia>")
  const parte = extraerContraparte(texto, preambulo, notas)
  const objeto = otrosi ? { objeto: null, confianza: 0 } : extraerObjeto(clausulas)
  const valor = extraerValor(texto, clausulas, parte.pais, notas)
  const fechas = extraerFechas(texto, preambulo, clausulas, otrosi, notas)
  const poliza = extraerPoliza(texto, correo, otrosi, notas)
  if (otrosi) notas.push("documento: otrosí; los campos en null no se modifican en el maestro")
  return {
    id_contrato: id,
    cliente: parte.cliente,
    nit_cliente: parte.nit,
    pais: parte.pais,
    objeto: objeto.objeto,
    valor: valor.valor,
    valor_indeterminado: valor.indeterminado,
    moneda: valor.moneda,
    fecha_inicio: fechas.inicio,
    fecha_fin: fechas.fin,
    plazo_meses: fechas.plazoMeses,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipos,
    tipo_documento: otrosi ? "otrosi" : "contrato",
    comercial,
    confianza: {
      id_contrato: id ? 0.98 : 0,
      ...parte.confianza,
      objeto: objeto.confianza,
      ...valor.confianza,
      ...fechas.confianza,
      ...poliza.confianza,
    },
    notas,
  }
}

export function resolverComercial(r: Rutas, email: string): string | null {
  const encontrado = leerComerciales(r).find((c) => c.email.toLowerCase() === email.trim().toLowerCase())
  return encontrado?.nombre ?? null
}

/** Punto de entrada: lee el correo, ubica el adjunto de contrato y extrae sus datos. */
export function extraerMensaje(r: Rutas, mensajeId: string): Resultado<Extraccion> {
  const correo = leerCorreo(r, mensajeId)
  if (!correo) return fallo(`no existe el mensaje ${mensajeId} en el buzón`)
  const adjunto = adjuntoDeContrato(r, correo)
  if (!adjunto) return fallo(`el mensaje ${mensajeId} no trae adjunto de contrato (adjuntos: ${correo.adjuntos.join(", ") || "ninguno"})`)
  if (!adjunto.nombre.toLowerCase().endsWith(".txt")) return fallo(`formato no soportado para extracción: ${adjunto.nombre} (se requiere el texto extraído .txt)`)
  try {
    const contrato = extraerDeTexto(adjunto.texto, adjunto.nombre, correo, resolverComercial(r, correo.de))
    return ok({ contrato, adjunto, correo })
  } catch (e) {
    if (e instanceof ErrorExtraccion) return fallo(e.message)
    throw e
  }
}
