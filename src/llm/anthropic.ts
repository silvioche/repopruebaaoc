/** Implementación del adaptador para Claude (Anthropic Messages API). */
import Anthropic from "@anthropic-ai/sdk"
import type { AdaptadorLLM, MensajeLLM, PeticionLLM, RespuestaLLM } from "./adapter.ts"
import { ErrorProveedor } from "./adapter.ts"

type Bloque = Anthropic.Beta.BetaContentBlock
type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

export interface ConfigAnthropic {
  modelo: string
  esfuerzo: Esfuerzo
  maxTokensRespuesta: number
  timeoutMs: number
}

/**
 * Tras un fallback del servidor, lo anterior al último bloque `fallback` (salvo texto)
 * pertenece al intento rechazado y no debe reenviarse.
 */
function contenidoVigente(contenido: Bloque[]): Bloque[] {
  const corte = contenido.map((b) => b.type).lastIndexOf("fallback")
  if (corte < 0) return contenido
  return [...contenido.slice(0, corte).filter((b) => b.type === "text"), ...contenido.slice(corte + 1)]
}

function aMensajesAnthropic(mensajes: MensajeLLM[]): Anthropic.Beta.BetaMessageParam[] {
  return mensajes.map((m): Anthropic.Beta.BetaMessageParam => {
    if (m.rol === "asistente") {
      if (Array.isArray(m.nativo)) return { role: "assistant", content: m.nativo as Bloque[] }
      const contenido: Anthropic.Beta.BetaContentBlockParam[] = []
      if (m.texto) contenido.push({ type: "text", text: m.texto })
      for (const l of m.llamadas) contenido.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })
      return { role: "assistant", content: contenido }
    }
    return {
      role: "user",
      content: m.bloques.map((b): Anthropic.Beta.BetaContentBlockParam =>
        b.tipo === "texto"
          ? { type: "text", text: b.texto }
          : { type: "tool_result", tool_use_id: b.idLlamada, content: b.contenido, is_error: b.esError },
      ),
    }
  })
}

function traducirError(e: unknown): ErrorProveedor {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErrorProveedor("el proveedor de lenguaje no respondió a tiempo (timeout)")
  if (e instanceof Anthropic.AuthenticationError) return new ErrorProveedor("credencial del proveedor inválida o ausente en el servidor")
  if (e instanceof Anthropic.RateLimitError) return new ErrorProveedor("límite de uso del proveedor alcanzado; intenta de nuevo en un minuto")
  if (e instanceof Anthropic.APIConnectionError) return new ErrorProveedor("no hay conexión con el proveedor de lenguaje")
  if (e instanceof Anthropic.APIError) return new ErrorProveedor(`el proveedor respondió con error ${e.status ?? ""}`.trim())
  return new ErrorProveedor(e instanceof Error ? e.message : String(e))
}

export function crearAdaptadorAnthropic(cfg: ConfigAnthropic): AdaptadorLLM {
  // Lee ANTHROPIC_API_KEY del entorno del backend; nunca se registra ni se devuelve.
  const cliente = new Anthropic({ timeout: cfg.timeoutMs, maxRetries: 2 })
  return {
    proveedor: "anthropic",
    modelo: cfg.modelo,
    async enviar(p: PeticionLLM): Promise<RespuestaLLM> {
      let respuesta: Anthropic.Beta.BetaMessage
      try {
        respuesta = await cliente.beta.messages.create(
          {
            model: cfg.modelo,
            max_tokens: cfg.maxTokensRespuesta,
            system: p.sistema,
            cache_control: { type: "ephemeral" },
            output_config: { effort: cfg.esfuerzo },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            tools: p.herramientas.map((h) => ({
              name: h.nombre,
              description: h.descripcion,
              input_schema: h.esquema as Anthropic.Beta.BetaTool.InputSchema,
            })),
            messages: aMensajesAnthropic(p.mensajes),
          },
          { signal: p.senal },
        )
      } catch (e) {
        throw traducirError(e)
      }
      const contenido = contenidoVigente(respuesta.content)
      const texto = contenido.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
      const llamadas = contenido.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: b.input }] : []))
      const parada =
        respuesta.stop_reason === "refusal" ? "rechazo" : respuesta.stop_reason === "max_tokens" ? "limite_tokens" : llamadas.length ? "herramientas" : "fin"
      return {
        texto,
        llamadas,
        parada,
        nativo: contenido,
        uso: {
          entrada: respuesta.usage.input_tokens + (respuesta.usage.cache_creation_input_tokens ?? 0) + (respuesta.usage.cache_read_input_tokens ?? 0),
          salida: respuesta.usage.output_tokens,
          cacheLeidos: respuesta.usage.cache_read_input_tokens ?? 0,
        },
      }
    },
  }
}
