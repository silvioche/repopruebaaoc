# Agente de Registro de Contratos Vigentes

Agente conversacional que actúa como **punto único de recepción** del buzón de contratos: clasifica los correos, extrae los datos del contrato con nivel de confianza por campo, detecta nuevos / actualizaciones (otrosíes) / duplicados / rechazos, registra en el maestro simulado de SharePoint, archiva el documento y genera el reporte de alertas de vencimiento y pólizas. Antes de registrar un dato dudoso le pide confirmación a la analista.

El planteamiento completo (arquitectura, ciclo del agente, costos, regla de gobierno, decisiones) está en **[SOLUCION.md](SOLUCION.md)**.

## Link de prueba

**URL pública:** https://registro-contratos-atbp.onrender.com

Desplegado en Render (plan gratuito) desde `render.yaml`. Notas:
- Si el servicio estuvo inactivo unos 15 minutos, la primera visita tarda de 30 a 60 segundos en despertarlo.
- Corre en **modo simulado** mientras no se configure `ANTHROPIC_API_KEY` en el panel de Render; `GET /api/health` indica el proveedor activo.
- El disco es efímero: `out/` vuelve al estado inicial en cada reinicio o redespliegue. El botón «Reiniciar datos» hace lo mismo a demanda.

Si el despliegue define `ACCESS_KEY`, el front pide la clave al abrirlo (se entrega por separado, nunca en el repositorio).

## Arranque local (un comando)

Requisitos: Node 22.18+ (recomendado 24, que ejecuta TypeScript de forma nativa) o Bun 1.x.

```bash
npm install && npm run dev        # Node  → http://localhost:3000
bun install && bun src/server.ts  # Bun   → http://localhost:3000
```

Sin `ANTHROPIC_API_KEY` el backend arranca en **modo simulado**: un planificador determinista que usa las mismas herramientas, el mismo ciclo y el mismo front, y entiende instrucciones básicas. Para usar el modelo de lenguaje:

```bash
cp .env.example .env   # y completa ANTHROPIC_API_KEY
npm run dev
```

## Verificación sin modelo

```bash
npm run demo          # = node demo.ts   ·   con Bun: bun run demo.ts
npm test              # pruebas del ciclo (CA1/CA3/CA5) + demo + coherencia de modulo/
```

`demo.ts` limpia `out/`, procesa los 6 mensajes llamando directamente a las herramientas, muestra que `msg-006` **no** se registra en la primera pasada, hace la segunda llamada con `confirmado: true`, genera `out/alertas.md`, prueba casos malos (HU-6) y comprueba los invariantes. Sale con código 1 si algo falla.

## Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clave del proveedor. Solo vive en el backend. |
| `LLM_PROVIDER` | `anthropic` si hay clave, si no `simulado` | Selección del adaptador. |
| `LLM_MODEL` | `claude-opus-5-5` | Modelo de Claude. |
| `LLM_EFFORT` | `medium` | Esfuerzo de razonamiento (`low`…`max`). |
| `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` | `16000` / `90000` | Tope de salida y timeout por llamada al proveedor. |
| `MAX_ITERACIONES` | `25` | Tope de iteraciones modelo↔herramientas por turno (CA1). |
| `MAX_TOKENS_SESION` | `400000` | Tope de tokens por sesión. |
| `RATE_LIMIT_POR_MINUTO` | `20` | Peticiones de chat por IP y minuto. |
| `ACCESS_KEY` | vacío | Si se define, protege el chat con la cabecera `x-access-key`. |
| `ALLOW_RESET` | `true` | Habilita `POST /api/reset` (botón «Reiniciar datos»). |
| `PORT` | `3000` | Puerto HTTP. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientes[], error, uso }` |
| `POST` | `/api/chat/stream` | Igual, como stream SSE: eventos `pensando`, `tool_call`, `tool_result`, `texto` y `fin` (respuesta completa). |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión, tokens y pendientes de confirmación. |
| `GET` | `/api/health` | `{ ok, provider, model, herramientas[], … }` sin exponer claves. |
| `GET` | `/api/maestro` | Filas actuales de `out/sharepoint/maestro-contratos.csv`. |
| `GET` | `/api/alertas` | Contenido de `out/alertas.md` (o `null`). |
| `POST` | `/api/reset` | Borra `out/` para volver al estado inicial de la demo. |

## Prompt de ejemplo

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Luego: `confirmo el valor 0 y la fecha fin 2027-08-31` → `msg-006` queda registrado.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/                  conocimiento: registro-contratos.md + reglas.json (umbrales editables)
src/tools/contratos.ts          herramientas zod → contratos_<export>
src/dominio/                    lógica determinista: extracción, validación, registro, alertas, archivos
src/agente/                     ciclo del agente, sesiones, registro de herramientas, carga del prompt
src/llm/                        adapter.ts (interfaz) · anthropic.ts · simulado.ts
src/server.ts                   API HTTP (node:http) + estáticos
web/                            front de chat (HTML/CSS/JS sin dependencias)
fixtures/reto-02/               insumos entregados (solo lectura)
modulo/                         bonus: agente empaquetado (generado desde las mismas fuentes)
demo.ts · scripts/              verificación sin modelo, pruebas del ciclo, sync del módulo
out/                            generado en ejecución (no se versiona)
```

## Despliegue

- **Render:** el repositorio trae `render.yaml` (Blueprint). Crear el servicio desde el repo y cargar `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) como secretos en el panel.
- **Docker:** `docker build -t contratos . && docker run -p 3000:3000 --env-file .env contratos`.

El sistema de archivos de un servicio gratuito es efímero: `out/` se pierde al reiniciar, lo que equivale a volver al estado inicial (igual que el botón «Reiniciar datos»).
