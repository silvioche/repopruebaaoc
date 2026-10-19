/** Selección del proveedor por variables de entorno. */
import type { AdaptadorLLM } from "./adapter.ts"
import { crearAdaptadorAnthropic } from "./anthropic.ts"
import { crearAdaptadorSimulado } from "./simulado.ts"

const ESFUERZOS = ["low", "medium", "high", "xhigh", "max"] as const

export function crearAdaptador(entorno: NodeJS.ProcessEnv): AdaptadorLLM {
  const proveedor = entorno.LLM_PROVIDER ?? (entorno.ANTHROPIC_API_KEY ? "anthropic" : "simulado")
  if (proveedor === "simulado") return crearAdaptadorSimulado()
  if (proveedor === "anthropic") {
    const esfuerzo = ESFUERZOS.find((e) => e === entorno.LLM_EFFORT) ?? "medium"
    return crearAdaptadorAnthropic({
      modelo: entorno.LLM_MODEL ?? "claude-opus-5-5",
      esfuerzo,
      maxTokensRespuesta: Number(entorno.LLM_MAX_TOKENS ?? 16000),
      timeoutMs: Number(entorno.LLM_TIMEOUT_MS ?? 90_000),
    })
  }
  throw new Error(`LLM_PROVIDER desconocido: ${proveedor} (usa anthropic o simulado)`)
}
