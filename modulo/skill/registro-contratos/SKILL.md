---
name: registro-contratos
description: Reglas de negocio del registro de contratos vigentes (RN1–RN7), esquema del maestro, cálculo de confianza y alertas. Úsala al clasificar, validar o registrar contratos y otrosíes.
---

<!-- Generado por scripts/sync-modulo.ts. No editar: la fuente es src/knowledge/registro-contratos.md -->

# Conocimiento del proceso: registro de contratos vigentes

## Contexto

- El maestro de contratos (Excel en SharePoint) quedó **congelado el 2026-05-30**. Desde entonces solo llegaban a administración los contratos con póliza.
- El buzón único `contratos@periferia-ficticia.com` recibe **todo** contrato firmado, con o sin póliza, y sus otrosíes y actas.
- No hay área legal interna: el agente no interpreta cláusulas jurídicas, solo registra datos y alerta.
- SharePoint se simula en `out/sharepoint/`; el maestro de trabajo es `out/sharepoint/maestro-contratos.csv` (copia del fixture, que nunca se modifica).

## Esquema del maestro (una fila por contrato)

| Columna | Regla |
|---|---|
| id_contrato | Número tal como aparece en el documento; si no existe, `AUTO-<año>-<secuencia>`. |
| cliente | Razón social de la contraparte (nunca Periferia). |
| nit_cliente | Identificador tributario sin dígito de verificación ni puntos. |
| pais | CO, EC, PE, PA o HN (por tipo/longitud del identificador y domicilio). |
| objeto | Máximo 200 caracteres. |
| valor | Sin separadores. `0` si es por demanda (`valor_indeterminado = true`). |
| moneda | COP, USD, PEN, PAB o HNL. |
| fecha_inicio / fecha_fin | YYYY-MM-DD. `fecha_fin` puede derivarse del plazo en meses. |
| requiere_poliza / tipo_poliza | Tipos separados por `;`. Vacío si no requiere. |
| estado_poliza | vigente, pendiente, vencida, no_aplica. Un registro nuevo con póliza nace `pendiente`. |
| comercial | Nombre resuelto desde `comerciales.json` por el correo remitente. |
| ruta_sharepoint | `Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`. |
| fecha_registro / fuente | Fecha de registro; fuente `buzon`, `manual` o `migracion`. |

## Reglas de negocio

- **RN1 Duplicado:** mismo `id_contrato` y mismos `valor`, `fecha_inicio` y `fecha_fin`. No se escribe nada; se reporta.
- **RN2 Actualización:** mismo `id_contrato` (o mismo `nit_cliente` con objeto similar ≥ 0.9) y algún campo distinto, o el documento es un otrosí. Se actualiza la fila y el cambio queda en `historial.jsonl`. En un otrosí, los campos que no menciona se conservan.
- **RN3 Nuevo:** sin coincidencia. Se inserta.
- **RN4 Rechazado:** sin adjunto de contrato (cotizaciones, propuestas, preguntas) o texto sin partes ni objeto identificables. Un otrosí de un contrato que no está en el maestro también se rechaza: hay que pedir el contrato original.
- **RN5 Revisión humana:** campos con confianza < 0.8, conflictos con el maestro (otro NIT u otra moneda para el mismo contrato) y cualquier valor distinto al extraído del documento exigen `confirmado = true`.
- **RN6:** el fixture es de solo lectura; la primera ejecución lo copia a `out/sharepoint/`.
- **RN7:** toda herramienta deja traza en `out/log.jsonl`.
- **Pólizas y otrosíes:** si un otrosí amplía el plazo de un contrato con póliza vigente, la póliza pasa a `pendiente` hasta que se acredite su ampliación.

## Cómo se calcula la confianza

| Situación | Confianza |
|---|---|
| Valor en números que coincide con el valor en letras | 0.99 |
| Fechas "desde … hasta …" coherentes con el plazo en meses | 0.98 |
| Dato explícito y sin ambigüedad | 0.9 – 0.97 |
| Fecha de fin derivada de inicio exacto + plazo en meses | 0.85 |
| Fecha de inicio cuando la firma solo indica mes y año (se asume día 1) | 0.8 |
| Prórroga automática (la fecha de fin real es incierta) | ≤ 0.75 |
| Valor por demanda / sin valor determinado (se registra 0) | 0.6 |
| Letras y números del valor no coinciden; correo contradice el documento | 0.6 |
| Fecha de fin derivada de una firma sin día | 0.5 |
| Dato ausente | 0 (valor null) |

## Alertas para gerencia

`out/alertas.md` tiene tres secciones: contratos que vencen en ≤ 60 días desde `hoy`, contratos con `requiere_poliza = true` y `estado_poliza ≠ vigente`, y contratos registrados o actualizados desde el corte del 2026-05-30 (el gap que se está cubriendo). Como contexto se listan también los contratos ya vencidos sin acta de terminación ni renovación registrada.

## Glosario

- **Otrosí:** documento que modifica un contrato existente (plazo, valor, alcance).
- **Contrato marco:** contrato sin valor determinado que se ejecuta mediante órdenes de servicio.
- **Póliza de cumplimiento / calidad / salarios y prestaciones / responsabilidad civil:** garantías que el contratista constituye a favor del cliente; las gestiona administración con el corredor.
