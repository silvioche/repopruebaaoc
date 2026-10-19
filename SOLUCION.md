# SOLUCIÓN — Agente de Registro de Contratos Vigentes

## 1. Problema en una frase

El maestro de contratos está congelado desde el 2026-05-30 y solo recibe lo que trae póliza, así que **nadie sabe qué contratos están vigentes, cuáles vencen ni qué pólizas faltan**. Le duele a la **analista administrativa** (dueña del maestro y de las pólizas), a la **gerencia** (sin visibilidad de vencimientos ni riesgo) y a la empresa, que depende de una persona que ya no está.

## 2. Arquitectura

```
┌───────────────────────────┐  POST /api/chat/stream (SSE)  ┌──────────────────────────────────────────────┐
│ web/  (HTML+CSS+JS)       │ ────────────────────────────▶ │ src/server.ts   (node:http, sin framework)   │
│ · historial del chat      │ ◀──── tool_call / tool_result │ · valida cuerpo, clave opcional, rate-limit  │
│ · tarjetas de herramienta │       / fin                   │ · un turno a la vez por sesión               │
│ · banner de confirmación  │                               └───────────────┬──────────────────────────────┘
│ · panel maestro + alertas │                                               │
└───────────────────────────┘                               ┌───────────────▼──────────────────────────────┐
                                                            │ src/agente/ciclo.ts                          │
       agent/prompt.md ─────┐                               │ prompt → modelo → herramientas → … (≤ 25)    │
 src/knowledge/*.md ────────┼─▶ src/agente/prompt.ts ──────▶│ · guardia de confirmación humana (CA3)       │
                            │                               │ · pendientes → needsConfirmation             │
                            │                               │ · tope de tokens por sesión                  │
                            │                               └───────┬──────────────────────┬───────────────┘
                            │                                       │                      │
                            │                    ┌──────────────────▼─────┐   ┌────────────▼──────────────┐
                            │                    │ src/llm/adapter.ts     │   │ src/agente/herramientas.ts│
                            │                    │ enviar(peticion)       │   │ zod → JSON Schema,        │
                            │                    │ ├ anthropic.ts (Claude)│   │ valida antes de ejecutar  │
                            │                    │ └ simulado.ts (reglas) │   └────────────┬──────────────┘
                            │                    └────────────────────────┘                │
                            │                                                ┌─────────────▼──────────────┐
 src/knowledge/reglas.json ─┴──────────────────────────────────────────────▶ │ src/tools/contratos.ts     │◀── demo.ts
   (umbral 0.8, 60 días, corte, tipos de póliza…)                            │ (contratos_<export>)       │◀── modulo/tools
                                                                             └─────────────┬──────────────┘
                                                                             ┌─────────────▼──────────────┐
                                                                             │ src/dominio/               │
                                                                             │ extracción · validación ·  │
                                                                             │ registro · alertas · buzón │
                                                                             └──────┬──────────────┬──────┘
                                                                                    │              │
                                                                   fixtures/reto-02/ (lectura)   out/ (escritura)
                                                                   buzón, maestro, comerciales   sharepoint/maestro-contratos.csv
                                                                                                 sharepoint/Contratos/<año>/<cliente>/
                                                                                                 sharepoint/historial.jsonl
                                                                                                 procesados.json · log.jsonl
                                                                                                 alertas.md · sesiones/
```

| Pieza | Dónde vive | Qué cambia cuando… |
|---|---|---|
| **Comportamiento** (cómo conversa, orden de trabajo, cómo pide confirmación) | `agent/prompt.md` | cambia el tono o el flujo de la conversación |
| **Conocimiento** (RN1–RN7, esquema, tabla de confianza, glosario) | `src/knowledge/registro-contratos.md` | cambia la explicación del proceso |
| **Parámetros de negocio** (umbral 0.8, 60 días, fecha de corte, similitud 0.9, tipos de póliza, monedas por país) | `src/knowledge/reglas.json` | cambia una regla numérica — sin tocar código ni servidor |
| **Ejecución** | `src/tools/contratos.ts` + `src/dominio/` | cambia una regla de extracción o de registro |

El servidor no conoce ninguna regla de negocio: solo transporta mensajes y ejecuta el ciclo.

## 3. Ciclo del agente

`src/agente/ciclo.ts → ejecutarTurno()`:

1. Se agrega el mensaje de la usuaria al historial (si el turno anterior se cortó por un error, se completa ese mismo mensaje para que el historial siga siendo válido).
2. **Bucle con tope** (`MAX_ITERACIONES`, 25 por defecto): se llama a `llm.enviar({ sistema, mensajes, herramientas })`. Si la respuesta no trae llamadas a herramientas, ese texto es la respuesta del turno. Si las trae, se ejecuta cada una, se emite `tool_call`/`tool_result` al front por SSE y los resultados vuelven al modelo.
3. **Tope alcanzado (CA1):** no se corta en seco; el agente responde con una lista determinista de lo que hizo, qué mensajes quedaron procesados y cómo continuar.
4. **Tope de tokens por sesión:** antes de cada llamada se compara el acumulado contra `MAX_TOKENS_SESION`.
5. **Errores (CA5):** un error del proveedor (timeout, autenticación, límite de uso, conexión) se traduce a un mensaje claro en `ErrorProveedor`, se muestra en el chat, se registra en `out/log.jsonl` y la sesión sigue viva. Un error de herramienta vuelve al modelo como `tool_result` con `is_error`, y el prompt le pide continuar con el siguiente mensaje.

**Confirmación humana (CA3) — por diseño, no solo por prompt:**

- El ciclo mantiene un mapa de **pendientes**: un `contratos_validar` con `requiere_revision` no vacío (o un `contratos_registrar` rechazado por "requiere revisión") deja el mensaje pendiente con el detalle campo por campo; un registro exitoso lo retira.
- Al cerrar el turno, `needsConfirmation = pendientes.length > 0` y la respuesta incluye `pendientes[]`. El front pinta un **banner ámbar** con la tabla campo / valor propuesto / confianza / motivo y botones «Confirmar» y «Corregir antes de confirmar».
- **Guardia:** una llamada a `contratos_registrar` con `confirmado: true` solo se ejecuta si ese `mensaje_id` estaba pendiente **al terminar el turno anterior**, es decir, si la usuaria ya vio la pregunta. Si el modelo intenta confirmar por su cuenta, la llamada se bloquea y vuelve como error. Probado en `scripts/prueba-ciclo.ts`.
- **El modelo no puede colar valores:** `contratos_registrar` vuelve a extraer el documento y compara campo por campo lo que el modelo propone contra la extracción determinista. Cualquier diferencia (un valor "redondeado", una fecha inferida) entra en `requiere_revision` y exige `confirmado: true`. La confianza que envíe el modelo se ignora: siempre se usa la de la extracción. Así, CA2 no depende de que el modelo obedezca.

**Trazabilidad (CA4):** toda ejecución de herramienta (desde el chat o desde `demo.ts`) queda en `out/log.jsonl` como `{ ts, herramienta, mensaje_id, ok, resumen, sesion }`, y en el historial visible de la sesión (`GET /api/sessions/:id`) con argumentos y resultado.

**Adaptador LLM:** `AdaptadorLLM.enviar(peticion) → RespuestaLLM` con tipos propios (`MensajeLLM`, `LlamadaHerramienta`, `UsoTokens`). `anthropic.ts` traduce a la Messages API de Claude; el contenido nativo del asistente se reenvía intacto en los turnos siguientes (lo exige el razonamiento de los modelos actuales). `simulado.ts` es un planificador de reglas que implementa la misma interfaz: cambiar de proveedor no toca el ciclo.

## 4. Elección del modelo y costo

- **Proveedor / modelo:** Anthropic, `claude-opus-5-5`, con esfuerzo `medium`, caché de prompt automático (`cache_control` de nivel superior) y `fallbacks: "default"` (si el modelo declina por política, el servidor reintenta con el modelo recomendado dentro de la misma llamada).
- **Por qué:** el trabajo del modelo aquí es **orquestar** herramientas, seguir reglas estrictas (no afirmar valores, no confirmar sin permiso) y redactar tablas claras en español. Lo que más importa es seguir bien las instrucciones en flujos largos con herramientas; la precisión de los datos no depende del modelo, porque la extracción es determinista. Se configura con `LLM_MODEL`: para bajar costos se puede usar `claude-haiku-5-5` sin tocar código.
- **Costo estimado** (precios de lista: Opus 5.5 USD 4 / 20 por millón de tokens de entrada / salida, lectura de caché USD 0.20; Haiku 5.5 USD 0.10 / 0.50). **Son estimaciones, no mediciones**: no corrí el lote completo contra la API con clave.

| Supuesto por lote de 6 mensajes | Valor |
|---|---|
| Prefijo fijo (system prompt + conocimiento + esquemas de 6 herramientas) | ≈ 5 000 tokens |
| Resultados de herramientas (≈ 19 llamadas) | ≈ 9 000 tokens |
| Iteraciones (agrupando llamadas paralelas) | ≈ 10 |
| Entrada acumulada (el historial se reenvía en cada iteración) | ≈ 120 000 tokens, ~85 % leído de caché |
| Salida (llamadas + razonamiento + respuesta final) | ≈ 8 000 tokens |

| Modelo | Por lote de 6 | **Por caso** |
|---|---|---|
| Opus 5.5 con caché | ≈ USD 0.20 entrada + 0.16 salida ≈ **USD 0.36** | **≈ USD 0.06** |
| Opus 5.5 sin caché | ≈ USD 0.64 | ≈ USD 0.11 |
| Haiku 5.5 con caché | ≈ USD 0.01 | ≈ USD 0.002 |

A unos 40 contratos al mes, el costo con Opus sería de unos USD 2–3 al mes; el tope por sesión (`MAX_TOKENS_SESION = 400k`) limita el gasto de una sola sesión a unos USD 2 en el peor caso. El modo simulado cuesta 0.

## 5. Estrategia de extracción

Todo es determinista (`src/dominio/extraccion.ts` + `texto.ts`), sin modelo. El documento se divide en preámbulo y cláusulas (`PRIMERA.`, `SEGUNDA.`…) y cada dato se busca en su cláusula:

| Dato | Cómo se encuentra | Cómo se valida |
|---|---|---|
| **Número** | `No. XX-AAAA-NNN` en el encabezado (para otrosíes, el contrato al que modifica). | Ausente → `null`; se asigna `AUTO-<año>-<secuencia>` al registrar. |
| **Partes** | Cada `NIT/RUC/RTN <número>` del preámbulo; el nombre es el texto anterior hasta `Entre`, `y` o `),`. Se descarta Periferia (NIT propio en `reglas.json`). | Razón social con su capitalización real tomada del bloque de firmas (0.97); si no aparece, *title case* (0.85). |
| **NIT / país** | NIT sin DV ni puntos. País por tipo y longitud del identificador (NIT→CO, RUC 13→EC, RUC 11→PE, RTN→HN) **y** por el domicilio (Quito, Lima…). | Coinciden → 0.97; solo identificador → 0.85; se contradicen → 0.6. |
| **Objeto** | Cláusula `OBJETO`, sin el arranque «EL CONTRATISTA se obliga a…», recortada a 200 caracteres sin partir palabras. | Recortado → 0.85. |
| **Valor / moneda** | Cifra con código ISO entre paréntesis (`COP $265.000.000`, `USD 120,000.00`); el separador decimal se infiere. **El valor en letras se convierte a número** («DOSCIENTOS SESENTA Y CINCO MILLONES») y se compara con la cifra. | Coinciden → 0.99; no coinciden → 0.6. «No tiene valor determinado» → `0`, `valor_indeterminado`, 0.6. Código fuera de COP/USD/PEN/PAB/HNL → `{ ok:false, "moneda desconocida" }`. |
| **Plazo** | Cláusula `PLAZO`: fechas «desde X hasta Y» (incluidas las escritas como «primero (1) de agosto de 2026»), plazo en meses, «a partir de la firma» + fecha de firma, «suscrito el…» en otrosíes. | Fechas coherentes con el plazo → 0.98; fin derivado de un inicio exacto → 0.85; firma solo con mes → inicio día 1 (0.8) y fin al último día del mes (0.5); prórroga automática → ≤ 0.75. Fecha imposible (31 de febrero) → `{ ok:false }`. |
| **Póliza** | Oraciones con «póliza» o «garantía» que no estén negadas; tipos según el diccionario de `reglas.json`, en orden de aparición. | Exigencia condicionada («para cada orden que supere…») → 0.8; **el correo del comercial se usa como verificación cruzada**: si dice lo contrario que el documento → 0.6. |

**Dónde entra el modelo y dónde no.** El modelo **no** extrae, no calcula y no decide la clasificación: solo decide **qué herramienta llamar**, presenta los resultados y convierte la respuesta de la analista («confirmo el valor 0…») en una llamada con `confirmado: true`. Puede **proponer** un valor (por ejemplo, si la analista le dicta una fecha corregida), pero ese valor entra como diferencia frente a la extracción y exige confirmación humana. `contratos_leer_pdf` le permite leer literalmente un adjunto si la analista pregunta por una cláusula.

**Resultado sobre los fixtures** (`npm run demo`): msg-001 nuevo con póliza pendiente · msg-002 nuevo `no_aplica` · msg-003 actualización (valor 350 000→520 000 PEN, fin 2027-05-01→2027-11-01, historial) · msg-004 duplicado sin escritura · msg-005 rechazado (cotización) · msg-006 nuevo con `requiere_revision = [valor, fecha_fin]`, registrado solo tras la confirmación.

## 6. Regla de gobierno — «Ningún contrato sin buzón»

> Propuesta de una página para aprobación de la Gerencia General. Vigencia: desde el 1 de octubre de 2026.

**1. Canal único.** Todo contrato con un cliente se envía a **contratos@periferia-ficticia.com**. Es el único canal válido: lo que llega por correo personal, chat o en papel se considera **no recibido**. El buzón lo administra el **Coordinador(a) de Administración y Finanzas** como **dueño del maestro** (responde la pregunta abierta del PRD: sin área legal interna, el dueño es Administración, no Comercial). Tiene un suplente nombrado, para que el proceso no dependa de una sola persona. El agente es el primer receptor y la analista administrativa es la operadora diaria.

**2. Obligación del comercial.** El comercial que cierra el negocio envía, **dentro de los 3 días hábiles siguientes a la firma**:
- el **contrato firmado por ambas partes** en PDF con texto (no foto ni escaneo);
- todo **otrosí, adenda, acta de inicio, suspensión, terminación o liquidación**, con el mismo plazo;
- **siempre**, requiera póliza o no.

Formato del asunto: `[CONTRATO|OTROSI|ACTA] <Cliente> – <N.º contrato> – <objeto breve>`, por ejemplo `[OTROSI] Minera Los Andes – CT-2026-011 – Ampliación plazo`. Un adjunto por documento; las cotizaciones y propuestas no se envían a este buzón.

**3. Acuse automático.** En **menos de 15 minutos hábiles** el agente responde al remitente con: número asignado o detectado, clasificación (nuevo / actualización / duplicado / rechazado), ruta de archivo y, si aplica, los campos que quedaron en revisión y la fecha en que la analista los resolverá (máximo **2 días hábiles**). Si el remitente no está en el catálogo de comerciales, el acuse va con copia al dueño del maestro.

**4. Excepciones y escalamiento.**

| Situación | Qué pasa | A quién se escala |
|---|---|---|
| Contrato **sin firma** de alguna de las partes | Se registra como *borrador*, no cuenta como vigente; se pide la versión firmada. | Comercial; a los 5 días hábiles, su director comercial. |
| Contrato **sin valor** (marco / por demanda) | Se registra con valor 0 previa confirmación de la analista; las órdenes de servicio se envían como `[ACTA]`. | Analista confirma; con dudas, Coordinación Administrativa. |
| Póliza exigida no constituida a los **10 días** de la firma | Alerta roja en el reporte. | Coordinación Administrativa → Gerencia General. |
| Otrosí de un contrato que no está en el maestro | Rechazo con motivo; se pide el contrato original. | Comercial; si no aparece, se trata en la campaña de cierre del gap. |
| Contrato enviado **fuera de plazo** | Se registra igual y se marca «tardío» en el indicador del comercial. | Reporte mensual a la dirección comercial. |
| Cláusulas atípicas (multas, exclusividad, propiedad intelectual) | El agente no las interpreta; se marcan para asesoría jurídica externa. | Gerencia General. |

**Consecuencia del incumplimiento:** un contrato que no está en el maestro **no se factura** (Finanzas verifica el número de contrato antes de emitir la primera factura) y el incumplimiento se refleja en la evaluación trimestral del comercial.

**5. Cierre del gap (junio–agosto 2026) en una campaña.** Duración: **2 semanas**.
1. *Semana 1, día 1:* Finanzas extrae la lista de **clientes facturados entre el 2026-05-30 y el 2026-09-30** y la cruza con el maestro → lista de contratos «facturados sin registro».
2. *Día 2:* cada comercial recibe su lista y tiene **5 días hábiles** para enviar al buzón, con el asunto normal, todos los contratos, otrosíes y actas de ese período (con o sin póliza).
3. El agente los procesa en lote como cualquier otro mensaje (deduplicación por NIT antes que por nombre); la analista resuelve la cola de revisión diariamente.
4. *Semana 2:* la Coordinación revisa los pendientes uno a uno con cada comercial; lo que siga sin documento se escala a Gerencia y se marca *sin soporte* en el maestro.
5. **Cierre:** acta con el % de cobertura alcanzado; meta ≥ 95 % de contratos facturados con registro.

**6. Indicador mensual.** **Cobertura del maestro** = contratos con facturación en el mes que existen en el maestro ÷ contratos con facturación en el mes. Meta ≥ 98 %. Se acompaña de dos indicadores secundarios: **oportunidad** (% de contratos recibidos ≤ 3 días hábiles después de la firma, meta ≥ 90 %) y **pólizas al día** (% de pólizas exigidas en estado vigente, meta 100 %). Los publica la analista el quinto día hábil de cada mes, junto con `alertas.md`.

## 7. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Extracción 100 % determinista**; el modelo solo orquesta. | Extraer con el LLM (mejor *recall* ante formatos nuevos). | El riesgo principal del PRD es que el modelo redondee o invente valores. Con regex + verificación cruzada (letras↔números, plazo↔fechas, correo↔documento), cada valor es reproducible y auditable, y `demo.ts` es determinista. Costo: un formato de contrato muy distinto baja la confianza y cae en revisión humana, que es el comportamiento deseado. |
| 2 | **`contratos_registrar` re-extrae y compara** con lo que propone el modelo. | Confiar en el `contrato` que llega como argumento. | Convierte CA2 en una garantía de diseño: un valor alterado nunca llega al maestro sin confirmación humana. Costo: se extrae dos veces (milisegundos). |
| 3 | **Guardia de confirmación en el ciclo** (solo confirma lo que quedó pendiente en el turno anterior). | Detectar «sí / confirmo» con palabras clave, o confiar solo en el prompt. | Las palabras clave fallan con frases naturales; el prompt solo es una sugerencia. La guardia estructural asegura que siempre hubo una pregunta antes; el modelo decide si la respuesta realmente confirma. |
| 4 | **Bucle manual** sobre la Messages API detrás de un adaptador propio. | El *tool runner* del SDK, o un framework de agentes. | El PRD exige una interfaz `enviar()` propia e intercambiable, e interceptar cada llamada (guardia, SSE, log, pendientes). El bucle tiene unas 100 líneas y se lee de un vistazo. |
| 5 | **`node:http` + front sin dependencias**, TypeScript ejecutado de forma nativa por Node 24 / Bun. | Express/Fastify + React + build. | Menos dependencias, arranque en segundos, nada que compilar. Dependencias en tiempo de ejecución: solo `zod` (obligatorio) y `@anthropic-ai/sdk`. Costo: el front es más artesanal (el markdown lo renderiza un parser propio que escapa el HTML primero). |
| 6 | **Adaptador «simulado»** cuando no hay clave. | Que el link falle sin clave. | El link sigue siendo demostrable (ciclo, herramientas, confirmación, front) aunque la clave expire o se agote en la defensa. Está marcado de forma visible en la interfaz para no confundirlo con el LLM. |
| 7 | Un otrosí que **amplía el plazo** de un contrato con póliza vigente deja la póliza en `pendiente`. | Mantenerla `vigente`. | El propio otrosí de msg-003 exige ampliar las garantías; hasta que se acredite, el riesgo existe y debe salir en el reporte. |

## 8. Supuestos

- Los fixtures se copian sin cambios a `fixtures/reto-02/`; el agente nunca escribe ahí.
- `contratos_registrar` también **marca como procesados los duplicados y rechazados** (sin tocar el maestro), para que no reaparezcan en `leer_buzon`. RN1 («no se escribe nada») se interpreta como «nada en el maestro ni en el historial».
- **msg-006:** la firma dice «agosto de 2026» sin día. Se asume `fecha_inicio = 2026-08-01` (confianza 0.8, en el umbral: no bloquea pero queda anotado) y `fecha_fin = 2027-08-31` (último día del mes en que vence el plazo; es el valor que confirma el ejemplo del PRD). La póliza condicionada a órdenes > COP 100 M se registra como `requiere_poliza = true` / `cumplimiento`.
- La moneda de msg-006 (COP) se infiere del código que aparece en la cláusula de garantías.
- Remitente desconocido (msg-006): se registra con `comercial` vacío y una advertencia, sin bloquear.
- Conflictos con el maestro que exigen revisión: otro NIT u otra moneda para el mismo `id_contrato`. Los cambios de valor o fechas de un otrosí son la actualización esperada, no un conflicto.
- `fecha_registro` es el `hoy` que indica la usuaria (así la demo es determinista); si no lo indica, la fecha del sistema.
- La sección «registrados desde el corte» incluye altas y actualizaciones posteriores al 2026-05-30, tomadas de `historial.jsonl`.
- Los otrosíes se archivan como `<id>-otrosi-<n>.txt` junto al contrato; `ruta_sharepoint` sigue apuntando al contrato original.
- `out/` es un estado compartido por todos los visitantes del link (es un único maestro). El botón «Reiniciar datos» lo devuelve al estado inicial.

## 9. Cobertura

| HU / requisito | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | `tiene_contrato` según el encabezado del adjunto; la cotización sale como `rechazado` con motivo. Producción: conector Microsoft Graph a Exchange. |
| HU-2 Extraer | Hecho | Esquema 7.2, confianza por campo, `null`/0 si falta. `leer_pdf` es **parcial**: lee adjuntos de texto; el PDF nativo devuelve error claro (falta un parser de PDF y OCR para escaneos). |
| HU-3 Validar | Hecho | RN1–RN4, `requiere_revision` con detalle, diferencias con el maestro, comercial resuelto contra `comerciales.json`. |
| HU-4 Registrar y archivar | Hecho | Copia del maestro, carpetas `Contratos/<año>/<cliente>/`, `historial.jsonl`, `procesados.json`, escritura atómica del CSV. Producción: API de SharePoint/Graph y bloqueo de concurrencia. |
| HU-5 Alertas | Hecho | Tres secciones + contexto de vencidos; `hoy` como argumento. Producción: envío programado a gerencia. |
| HU-6 Errores | Hecho | `{ ok:false, error }` legibles; la demo prueba 6 casos malos; el lote nunca aborta. |
| CA1–CA5 | Hecho | `scripts/prueba-ciclo.ts` cubre la guardia de confirmación, el tope de iteraciones, el error del proveedor y la validación zod. |
| Front | Hecho | Historial, «pensando», tarjetas de herramientas en vivo (SSE), banner de confirmación, panel del maestro y alertas, modo oscuro, vista móvil. |
| `demo.ts` | Hecho | Sin clave; determinista salvo marcas de tiempo; código de salida 1 si falla un invariante. |
| Bonus `modulo/` | Hecho | `tools/contratos.ts` reexporta el mismo módulo; `agent.md` y `SKILL.md` se generan desde `agent/prompt.md` y `src/knowledge/` (`npm run check-modulo` detecta divergencias). |
| Link público | Ver README | — |
| Producción en general | — | Autenticación (SSO), auditoría por usuario, almacenamiento persistente, acuse automático por correo (diseñado en §6, no implementado), métricas de costo por sesión en un panel. |

## 10. Uso de IA

| Asistente | Para qué | Qué descarté y por qué |
|---|---|---|
| **Claude Code (Claude Opus 5.5)** | Lectura del PRD y de los fixtures, propuesta de arquitectura, escritura del código (dominio, herramientas, ciclo, adaptadores, servidor, front), `demo.ts`, pruebas del ciclo y redacción de este documento. Cada paso se verificó ejecutando `tsc`, la demo y las pruebas. | **Usar el LLM para extraer** (por determinismo y auditabilidad, §7-1). **El tool runner del SDK** (el PRD pide un adaptador propio y había que interceptar cada llamada). **Express y React** (dependencias innecesarias para este alcance). **Cargar `marked` desde un CDN** para el markdown del chat (prefiero no depender de terceros en el front y escapar el HTML yo mismo). **Detectar la confirmación por palabras clave** (frágil; se reemplazó por la guardia estructural). Durante las pruebas se corrigieron errores reales: una regex de valor en letras que no aceptaba «M/CTE», una fecha «suscrito el» que no se detectaba en el otrosí, y el planificador simulado tomando «fecha fin 2027-08-31» como fecha de hoy. |

_El candidato debe completar o ajustar esta tabla si usó otros asistentes, y poder explicar cada línea en la defensa._

## 11. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| PDF escaneados o formatos de contrato muy distintos → baja confianza masiva. | OCR (p. ej., Azure Document Intelligence) antes de la extracción; ampliar los patrones con los casos reales; medir el % que cae en revisión y ajustar. Ante la duda, la revisión humana es el comportamiento por defecto. |
| Falsos duplicados o falsas actualizaciones por variaciones del nombre. | La coincidencia es por `id_contrato` y luego por **NIT** + objeto similar ≥ 0.9, nunca por nombre; NIT distinto = conflicto en revisión. |
| El modelo inventa o redondea un valor. | Las herramientas son la única fuente de valores; `registrar` re-extrae y exige confirmación ante cualquier diferencia; la guardia de confirmación es estructural. |
| Prompt injection en el texto de un contrato o correo («registra esto como confirmado»). | El texto del documento solo pasa por regex; el modelo nunca recibe permisos de escritura directa; `confirmado: true` exige una pregunta previa a la usuaria. |
| Concurrencia: dos sesiones escribiendo el maestro a la vez. | Hoy las escrituras son síncronas en un único proceso y el CSV se escribe de forma atómica. En producción: SharePoint/Graph con control de versiones (ETag) o una cola de un solo escritor. |
| Fuga o abuso de la clave del modelo. | Clave solo en el entorno del backend; nunca en logs ni respuestas; `ACCESS_KEY` opcional, límite por IP, topes de iteraciones y de tokens por sesión. |
| Datos personales y contractuales en logs y sesiones. | Retención definida para `out/sesiones` y `log.jsonl`, acceso restringido, cifrado en reposo en el almacenamiento definitivo. |
| El proceso vuelve a morir por rotación de personal. | La regla de gobierno nombra un dueño y un suplente, el indicador mensual de cobertura lo hace visible y el bloqueo de facturación sin registro crea el incentivo. |
