/**
 * Pruebas del ciclo del agente con adaptadores falsos (sin red ni clave):
 * CA3 guardia de confirmación, CA1 tope de iteraciones, CA5 error del proveedor.
 *   node scripts/prueba-ciclo.ts
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarTurno } from "../src/agente/ciclo.ts"
import { cargarHerramientas } from "../src/agente/herramientas.ts"
import type { Sesion } from "../src/agente/sesiones.ts"
import { ErrorProveedor, type AdaptadorLLM, type RespuestaLLM } from "../src/llm/adapter.ts"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const herramientas = cargarHerramientas()
const uso = { entrada: 10, salida: 5, cacheLeidos: 0 }
let fallos = 0

function sesionNueva(id: string): Sesion {
  return { id, creada: "", mensajesLLM: [], visible: [], tokens: { entrada: 0, salida: 0 }, pendientes: [] }
}

function adaptador(respuestas: (n: number) => RespuestaLLM): AdaptadorLLM {
  let n = 0
  return { proveedor: "falso", modelo: "falso", enviar: async () => respuestas(n++) }
}

const llamar = (nombre: string, args: unknown, id = "x"): RespuestaLLM => ({ texto: "", llamadas: [{ id, nombre, args }], parada: "herramientas", uso })
const fin = (texto: string): RespuestaLLM => ({ texto, llamadas: [], parada: "fin", uso })

function comprobar(condicion: boolean, descripcion: string): void {
  console.log(`  ${condicion ? "✔" : "✘"} ${descripcion}`)
  if (!condicion) fallos++
}

const deps = (llm: AdaptadorLLM, maxIteraciones = 25) => ({ llm, herramientas, sistema: "prueba", directorio: raiz, config: { maxIteraciones, maxTokensSesion: 100_000 } })

fs.rmSync(path.join(raiz, "out"), { recursive: true, force: true })

console.log("CA3 · confirmado=true sin pregunta previa se bloquea")
const s1 = sesionNueva("prueba-ca3")
const r1 = await ejecutarTurno(s1, "registra msg-006 ya", deps(adaptador((n) => (n === 0 ? llamar("contratos_registrar", { mensaje_id: "msg-006", confirmado: true }) : fin("listo")))))
comprobar(r1.toolCalls[0]?.bloqueada === true && !r1.toolCalls[0].ok, "la llamada se bloquea y vuelve como error al modelo")
comprobar(!fs.existsSync(path.join(raiz, "out", "procesados.json")), "no se escribe nada")

console.log("CA3 · tras mostrar la revisión, el siguiente turno sí puede confirmar")
const s2 = sesionNueva("prueba-ca3b")
const r2 = await ejecutarTurno(s2, "procesa msg-006", deps(adaptador((n) => (n === 0 ? llamar("contratos_validar", { mensaje_id: "msg-006" }) : fin("¿confirmas?")))))
comprobar(r2.needsConfirmation && r2.pendientes[0]?.mensaje_id === "msg-006", "needsConfirmation = true con msg-006 pendiente")
const r3 = await ejecutarTurno(s2, "confirmo", deps(adaptador((n) => (n === 0 ? llamar("contratos_registrar", { mensaje_id: "msg-006", confirmado: true, hoy: "2026-09-03" }) : fin("registrado")))))
comprobar(r3.toolCalls[0]?.ok === true && !r3.needsConfirmation, "registrar con confirmado=true se ejecuta y limpia el pendiente")

console.log("CA1 · tope de iteraciones")
const r4 = await ejecutarTurno(sesionNueva("prueba-ca1"), "bucle", deps(adaptador(() => llamar("contratos_leer_buzon", {})), 3))
comprobar(r4.toolCalls.length === 3 && /tope de 3 iteraciones/.test(r4.reply), "se detiene en 3 y responde con lo hecho y lo que falta")

console.log("CA5 · error del proveedor")
const s5 = sesionNueva("prueba-ca5")
const r5 = await ejecutarTurno(s5, "hola", deps({ proveedor: "falso", modelo: "falso", enviar: async () => { throw new ErrorProveedor("timeout simulado") } }))
comprobar(r5.error && /timeout simulado/.test(r5.reply), "el error llega al chat en lenguaje claro")
const r6 = await ejecutarTurno(s5, "¿sigues ahí?", deps(adaptador(() => fin("sí"))))
comprobar(r6.reply === "sí" && s5.mensajesLLM[0].rol === "usuario" && s5.mensajesLLM[1].rol === "asistente", "la sesión sigue viva y el historial queda bien formado")

console.log("Validación de argumentos en el backend")
const r7 = await ejecutarTurno(sesionNueva("prueba-zod"), "x", deps(adaptador((n) => (n === 0 ? llamar("contratos_alertas", { hoy: "03/09/2026" }) : fin("ok")))))
comprobar(!r7.toolCalls[0].ok && /argumentos inválidos/.test(r7.toolCalls[0].resultado), "args que no cumplen zod devuelven error al modelo")

fs.rmSync(path.join(raiz, "out"), { recursive: true, force: true })
console.log(fallos === 0 ? "\nPRUEBAS DEL CICLO OK ✔" : `\n${fallos} FALLOS ✘`)
process.exit(fallos === 0 ? 0 : 1)
