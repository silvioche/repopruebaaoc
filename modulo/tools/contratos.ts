/**
 * Herramientas del agente empaquetadas para otras plataformas de agentes.
 * No es una copia: reexporta exactamente el módulo que usa la aplicación, sin depender del servidor.
 * Cada export es una herramienta `{ description, args (zod), execute(args, ctx) }` → nombre `contratos_<export>`.
 * `ctx.directory` debe apuntar a la raíz que contiene fixtures/reto-02/ y donde se escribirá out/.
 */
export * from "../../src/tools/contratos.ts"
