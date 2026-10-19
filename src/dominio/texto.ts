/** Utilidades de texto deterministas: normalización, números, fechas y similitud. */

export function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

export function normalizar(s: string): string {
  return sinAcentos(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

const SUFIJOS_SOCIETARIOS = /\s+(s a s|s a c|s a|s de r l|ltda|sas|sac|inc|llc|corp)$/

export function slug(razonSocial: string): string {
  return normalizar(razonSocial).replace(SUFIJOS_SOCIETARIOS, "").replace(/\s+/g, "-")
}

const CONECTORES = new Set(["de", "del", "la", "las", "los", "y", "e", "el"])

/** "INDUSTRIAS DELTA S.A.S." → "Industrias Delta S.A.S." */
export function tituloRazonSocial(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((palabra, i) => {
      if (palabra.includes(".") && palabra.replace(/\./g, "").length <= 4) return palabra.toUpperCase()
      if (i > 0 && CONECTORES.has(palabra)) return palabra
      return palabra.charAt(0).toUpperCase() + palabra.slice(1)
    })
    .join(" ")
}

/** Coeficiente de Sørensen–Dice sobre bigramas de caracteres del texto normalizado. */
export function similitud(a: string, b: string): number {
  const bigramas = (s: string): Map<string, number> => {
    const t = normalizar(s).replace(/\s+/g, " ")
    const mapa = new Map<string, number>()
    for (let i = 0; i < t.length - 1; i++) {
      const bg = t.slice(i, i + 2)
      mapa.set(bg, (mapa.get(bg) ?? 0) + 1)
    }
    return mapa
  }
  const ba = bigramas(a)
  const bb = bigramas(b)
  let total = 0
  let comunes = 0
  for (const n of ba.values()) total += n
  for (const n of bb.values()) total += n
  for (const [bg, n] of ba) comunes += Math.min(n, bb.get(bg) ?? 0)
  return total === 0 ? 0 : (2 * comunes) / total
}

/** "265.000.000" → 265000000 · "120,000.00" → 120000 · "1.500,50" → 1500.5 */
export function parsearNumero(crudo: string): number | null {
  const s = crudo.replace(/\s/g, "").replace(/[.,]$/, "")
  const ultimoSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","))
  let entero = s
  let decimales = ""
  if (ultimoSep >= 0 && /^\d{1,2}$/.test(s.slice(ultimoSep + 1))) {
    entero = s.slice(0, ultimoSep)
    decimales = s.slice(ultimoSep + 1)
  }
  entero = entero.replace(/[.,]/g, "")
  if (!/^\d+$/.test(entero)) return null
  return Number(decimales ? `${entero}.${decimales}` : entero)
}

const VALORES_PALABRA: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600,
  seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
}

/** Convierte un importe en letras ("DOSCIENTOS SESENTA Y CINCO MILLONES DE PESOS") a número. */
export function palabrasANumero(texto: string): number | null {
  let total = 0
  let grupo = 0
  let reconocido = false
  for (const token of normalizar(texto).split(" ")) {
    if (token === "y") continue
    if (token in VALORES_PALABRA) {
      grupo += VALORES_PALABRA[token]
    } else if (token === "mil") {
      grupo = (grupo || 1) * 1000
    } else if (token === "millon" || token === "millones") {
      total += (grupo || 1) * 1_000_000
      grupo = 0
    } else if (reconocido) {
      break
    } else {
      return null
    }
    reconocido = true
  }
  return reconocido ? total + grupo : null
}

export const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}
const PATRON_MES = Object.keys(MESES).join("|")

export interface FechaEncontrada {
  iso: string
  valida: boolean
  textual: string
  indice: number
}

function aIso(anio: number, mes: number, dia: number): string {
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
}

function fechaExiste(anio: number, mes: number, dia: number): boolean {
  const f = new Date(Date.UTC(anio, mes - 1, dia))
  return f.getUTCMonth() === mes - 1 && f.getUTCDate() === dia
}

/** Encuentra fechas del tipo "primero (1) de agosto de 2026" o "30 días del mes de julio de 2026". */
export function fechasEnTexto(texto: string): FechaEncontrada[] {
  const patron = new RegExp(
    `\\(?(\\d{1,2})\\)?\\s+(?:d[ií]as\\s+del\\s+mes\\s+)?de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`,
    "gi",
  )
  const encontradas: FechaEncontrada[] = []
  for (const m of texto.matchAll(patron)) {
    const dia = Number(m[1])
    const mes = MESES[sinAcentos(m[2]).toLowerCase()]
    const anio = Number(m[3])
    encontradas.push({ iso: aIso(anio, mes, dia), valida: fechaExiste(anio, mes, dia), textual: m[0], indice: m.index ?? 0 })
  }
  return encontradas
}

/** "en el mes de agosto de 2026" → { anio: 2026, mes: 8 } */
export function mesEnTexto(texto: string): { anio: number; mes: number } | null {
  const m = new RegExp(`mes\\s+de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`, "i").exec(texto)
  return m ? { anio: Number(m[2]), mes: MESES[sinAcentos(m[1]).toLowerCase()] } : null
}

export function sumarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number)
  const destino = new Date(Date.UTC(a, m - 1 + meses, 1))
  const ultimoDia = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate()
  destino.setUTCDate(Math.min(d, ultimoDia))
  return destino.toISOString().slice(0, 10)
}

export function sumarDias(iso: string, dias: number): string {
  const f = new Date(`${iso}T00:00:00Z`)
  f.setUTCDate(f.getUTCDate() + dias)
  return f.toISOString().slice(0, 10)
}

export function ultimoDiaDelMes(anio: number, mes: number): string {
  return new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10)
}

export function diasEntre(desdeIso: string, hastaIso: string): number {
  return Math.round((Date.parse(`${hastaIso}T00:00:00Z`) - Date.parse(`${desdeIso}T00:00:00Z`)) / 86_400_000)
}

/** Recorta a `max` caracteres sin partir palabras. */
export function recortar(s: string, max: number): { texto: string; recortado: boolean } {
  if (s.length <= max) return { texto: s, recortado: false }
  const corte = s.slice(0, max - 1)
  return { texto: `${corte.slice(0, corte.lastIndexOf(" "))}…`, recortado: true }
}
