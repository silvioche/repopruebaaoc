/**
 * Acceso a archivos: fixtures (solo lectura) y out/ (escritura).
 * Todas las rutas se resuelven desde ctx.directory; los identificadores que llegan
 * del modelo se validan antes de tocar el disco para evitar path traversal.
 */
import fs from "node:fs"
import path from "node:path"
import { COLUMNAS_MAESTRO, type Comercial, type Correo, type FilaMaestro } from "./tipos.ts"

export interface Rutas {
  raiz: string
  fixtures: string
  buzon: string
  maestroFixture: string
  comerciales: string
  out: string
  sharepoint: string
  maestro: string
  historial: string
  procesados: string
  log: string
  alertas: string
}

export function rutas(directorio: string): Rutas {
  const fixtures = path.join(directorio, "fixtures", "reto-02")
  const out = path.join(directorio, "out")
  const sharepoint = path.join(out, "sharepoint")
  return {
    raiz: directorio,
    fixtures,
    buzon: path.join(fixtures, "buzon"),
    maestroFixture: path.join(fixtures, "maestro-contratos.csv"),
    comerciales: path.join(fixtures, "comerciales.json"),
    out,
    sharepoint,
    maestro: path.join(sharepoint, "maestro-contratos.csv"),
    historial: path.join(sharepoint, "historial.jsonl"),
    procesados: path.join(out, "procesados.json"),
    log: path.join(out, "log.jsonl"),
    alertas: path.join(out, "alertas.md"),
  }
}

const ID_MENSAJE = /^msg-[A-Za-z0-9_-]{1,40}$/

export function validarIdMensaje(id: string): string | null {
  return ID_MENSAJE.test(id) ? null : `mensaje_id inválido: "${id}" (formato esperado msg-XXX)`
}

// ---------- CSV (RFC 4180 simplificado) ----------

function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let entreComillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"'
        i++
      } else if (c === '"') entreComillas = false
      else campo += c
    } else if (c === '"') entreComillas = true
    else if (c === ",") {
      fila.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++
      fila.push(campo)
      if (fila.some((v) => v !== "")) filas.push(fila)
      fila = []
      campo = ""
    } else campo += c
  }
  fila.push(campo)
  if (fila.some((v) => v !== "")) filas.push(fila)
  return filas
}

function celdaCsv(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// ---------- Maestro ----------

/** RN6: la primera ejecución copia el fixture a out/sharepoint; el fixture nunca se modifica. */
export function asegurarMaestro(r: Rutas): void {
  if (fs.existsSync(r.maestro)) return
  fs.mkdirSync(r.sharepoint, { recursive: true })
  fs.copyFileSync(r.maestroFixture, r.maestro)
}

export function leerMaestro(r: Rutas): FilaMaestro[] {
  asegurarMaestro(r)
  const [encabezado, ...filas] = parsearCsv(fs.readFileSync(r.maestro, "utf8"))
  return filas.map((celdas) => {
    const fila = {} as FilaMaestro
    for (const col of COLUMNAS_MAESTRO) fila[col] = celdas[encabezado.indexOf(col)] ?? ""
    return fila
  })
}

export function escribirMaestro(r: Rutas, filas: FilaMaestro[]): void {
  const lineas = [COLUMNAS_MAESTRO.join(","), ...filas.map((f) => COLUMNAS_MAESTRO.map((c) => celdaCsv(f[c])).join(","))]
  const temporal = `${r.maestro}.tmp`
  fs.writeFileSync(temporal, `${lineas.join("\n")}\n`, "utf8")
  fs.renameSync(temporal, r.maestro)
}

// ---------- Buzón ----------

export function listarIdsBuzon(r: Rutas): string[] {
  return fs
    .readdirSync(r.buzon, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_MENSAJE.test(d.name))
    .map((d) => d.name)
    .sort()
}

export function leerCorreo(r: Rutas, id: string): Correo | null {
  const archivo = path.join(r.buzon, id, "correo.json")
  if (!fs.existsSync(archivo)) return null
  return JSON.parse(fs.readFileSync(archivo, "utf8")) as Correo
}

export function rutaAdjunto(r: Rutas, id: string, adjunto: string): string | null {
  if (path.basename(adjunto) !== adjunto) return null
  const archivo = path.join(r.buzon, id, adjunto)
  return fs.existsSync(archivo) ? archivo : null
}

export function leerComerciales(r: Rutas): Comercial[] {
  return JSON.parse(fs.readFileSync(r.comerciales, "utf8")) as Comercial[]
}

// ---------- Procesados, historial y log ----------

export interface MarcaProcesado {
  ts: string
  clasificacion: string
  accion: string
  id_contrato: string | null
}

export function leerProcesados(r: Rutas): Record<string, MarcaProcesado> {
  if (!fs.existsSync(r.procesados)) return {}
  return JSON.parse(fs.readFileSync(r.procesados, "utf8")) as Record<string, MarcaProcesado>
}

export function marcarProcesado(r: Rutas, mensajeId: string, marca: MarcaProcesado): void {
  const actuales = leerProcesados(r)
  actuales[mensajeId] = marca
  fs.mkdirSync(r.out, { recursive: true })
  fs.writeFileSync(r.procesados, `${JSON.stringify(actuales, null, 2)}\n`, "utf8")
}

export function agregarJsonl(archivo: string, registro: object): void {
  fs.mkdirSync(path.dirname(archivo), { recursive: true })
  fs.appendFileSync(archivo, `${JSON.stringify(registro)}\n`, "utf8")
}

export function leerJsonl<T>(archivo: string): T[] {
  if (!fs.existsSync(archivo)) return []
  return fs
    .readFileSync(archivo, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T)
}

/** Copia el documento al árbol tipo SharePoint y devuelve la ruta relativa a out/sharepoint. */
export function archivarDocumento(r: Rutas, origen: string, relativa: string): string {
  const destino = path.join(r.sharepoint, ...relativa.split("/"))
  fs.mkdirSync(path.dirname(destino), { recursive: true })
  fs.copyFileSync(origen, destino)
  return relativa
}
