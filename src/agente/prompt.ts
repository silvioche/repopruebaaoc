/** Compone el system prompt: comportamiento (agent/prompt.md) + conocimiento (src/knowledge/). */
import fs from "node:fs"
import path from "node:path"

export function cargarSistema(directorio: string): string {
  const comportamiento = fs.readFileSync(path.join(directorio, "agent", "prompt.md"), "utf8").trim()
  const conocimiento = fs.readFileSync(path.join(directorio, "src", "knowledge", "registro-contratos.md"), "utf8").trim()
  return `${comportamiento}\n\n---\n\n${conocimiento}\n`
}
