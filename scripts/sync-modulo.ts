/**
 * Genera modulo/agent.md y modulo/skill/registro-contratos/SKILL.md a partir de las fuentes
 * que usa la aplicación (agent/prompt.md y src/knowledge/registro-contratos.md), para que el
 * módulo y la app no diverjan. Con --check solo verifica y sale con 1 si hay diferencias.
 *   node scripts/sync-modulo.ts [--check]
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const leer = (rel: string) => fs.readFileSync(path.join(raiz, rel), "utf8").trim()

const AVISO = "<!-- Generado por scripts/sync-modulo.ts. No editar: la fuente es"

const destinos: Record<string, string> = {
  "modulo/agent.md": [
    "---",
    "description: Punto único de recepción de contratos — clasifica correos del buzón, extrae datos con confianza, registra en el maestro de SharePoint y genera alertas de vencimiento y pólizas.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    `${AVISO} agent/prompt.md -->`,
    "",
    leer("agent/prompt.md"),
    "",
  ].join("\n"),
  "modulo/skill/registro-contratos/SKILL.md": [
    "---",
    "name: registro-contratos",
    "description: Reglas de negocio del registro de contratos vigentes (RN1–RN7), esquema del maestro, cálculo de confianza y alertas. Úsala al clasificar, validar o registrar contratos y otrosíes.",
    "---",
    "",
    `${AVISO} src/knowledge/registro-contratos.md -->`,
    "",
    leer("src/knowledge/registro-contratos.md"),
    "",
  ].join("\n"),
}

const verificar = process.argv.includes("--check")
let divergentes = 0
for (const [rel, contenido] of Object.entries(destinos)) {
  const archivo = path.join(raiz, rel)
  const actual = fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8") : ""
  if (actual === contenido) {
    console.log(`✔ ${rel} al día`)
    continue
  }
  if (verificar) {
    divergentes++
    console.log(`✘ ${rel} difiere de su fuente (ejecuta npm run sync-modulo)`)
  } else {
    fs.mkdirSync(path.dirname(archivo), { recursive: true })
    fs.writeFileSync(archivo, contenido, "utf8")
    console.log(`↻ ${rel} regenerado`)
  }
}
process.exit(divergentes === 0 ? 0 : 1)
