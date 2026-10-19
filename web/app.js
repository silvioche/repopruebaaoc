// Front de chat sin dependencias: historial, llamadas a herramientas en vivo (SSE) y confirmación humana.

const $ = (sel) => document.querySelector(sel)
const almacenar = {
  leer(clave) {
    try { return localStorage.getItem(clave) } catch { return null }
  },
  escribir(clave, valor) {
    try { localStorage.setItem(clave, valor) } catch { /* sin almacenamiento local */ }
  },
}

const estado = {
  sesion: almacenar.leer("sesion") || nuevaSesionId(),
  clave: almacenar.leer("clave") || "",
  ocupado: false,
}
almacenar.escribir("sesion", estado.sesion)

const SUGERENCIAS = [
  "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.",
  "¿Qué mensajes hay pendientes en el buzón?",
  "Genera el reporte de alertas con fecha 2026-09-03",
]

function nuevaSesionId() {
  const aleatorio = crypto.getRandomValues(new Uint32Array(2))
  return `s-${Date.now().toString(36)}-${aleatorio[0].toString(36)}${aleatorio[1].toString(36)}`
}

// ---------- Markdown mínimo y seguro (se escapa todo antes de dar formato) ----------

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function enLinea(s) {
  return escapar(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,;:]|$)/g, "$1<em>$2</em>")
}

function celdas(linea) {
  return linea.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"))
}

function markdown(texto) {
  const lineas = String(texto || "").replace(/\r/g, "").split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^```/.test(l)) {
      const bloque = []
      i++
      while (i < lineas.length && !/^```/.test(lineas[i])) bloque.push(lineas[i++])
      i++
      html.push(`<pre><code>${escapar(bloque.join("\n"))}</code></pre>`)
    } else if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{3,}/.test(lineas[i + 1] || "")) {
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(`<div class="tabla-desplazable"><table><thead><tr>${cab.map((c) => `<th>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`)
    } else if (/^#{1,4}\s/.test(l)) {
      const nivel = Math.min(4, l.match(/^#+/)[0].length + 1)
      html.push(`<h${nivel}>${enLinea(l.replace(/^#+\s*/, ""))}</h${nivel}>`)
      i++
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordenada = /^\s*\d+\./.test(l)
      const items = []
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) items.push(lineas[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))
      const tag = ordenada ? "ol" : "ul"
      html.push(`<${tag}>${items.map((x) => `<li>${enLinea(x)}</li>`).join("")}</${tag}>`)
    } else if (/^---+\s*$/.test(l)) {
      html.push("<hr>")
      i++
    } else if (l.trim() === "") {
      i++
    } else {
      const parrafo = []
      while (i < lineas.length && lineas[i].trim() !== "" && !/^(#|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lineas[i])) parrafo.push(lineas[i++])
      if (parrafo.length === 0) parrafo.push(lineas[i++])
      html.push(`<p>${parrafo.map(enLinea).join("<br>")}</p>`)
    }
  }
  return html.join("")
}

// ---------- API ----------

function cabeceras() {
  const h = { "content-type": "application/json" }
  if (estado.clave) h["x-access-key"] = estado.clave
  return h
}

async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, { ...opciones, headers: { ...cabeceras(), ...(opciones.headers || {}) } })
  const cuerpo = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(cuerpo.error || `HTTP ${res.status}`)
  return cuerpo
}

// ---------- Render del chat ----------

const contenedor = $("#mensajes")

function desplazar() {
  contenedor.scrollTop = contenedor.scrollHeight
}

function burbujaUsuario(texto) {
  const div = document.createElement("div")
  div.className = "burbuja usuario"
  div.innerHTML = `<div class="rol">Analista</div>${escapar(texto)}`
  contenedor.append(div)
  desplazar()
}

function crearBurbujaAgente() {
  const div = document.createElement("div")
  div.className = "burbuja agente"
  div.innerHTML = `<div class="rol">Agente</div><div class="herramientas"></div><div class="cuerpo"></div>`
  contenedor.append(div)
  desplazar()
  return div
}

function formatoJson(valor) {
  try {
    return JSON.stringify(typeof valor === "string" ? JSON.parse(valor) : valor, null, 2)
  } catch {
    return String(valor)
  }
}

function tarjetaHerramienta(llamada, enCurso = false) {
  const d = document.createElement("details")
  d.className = "tool"
  d.dataset.id = llamada.id
  const estadoHtml = enCurso ? `<span class="estado run">…</span>` : llamada.ok ? `<span class="estado ok">✓</span>` : `<span class="estado err">✗</span>`
  const resumen = enCurso ? "ejecutando" : llamada.resumen
  d.innerHTML = `<summary>${estadoHtml}<span class="nombre">${escapar(llamada.nombre)}</span><span class="resumen" title="${escapar(resumen)}">${escapar(resumen)}</span></summary>
    <div class="etiqueta">Argumentos</div><pre>${escapar(formatoJson(llamada.args))}</pre>
    ${enCurso ? "" : `<div class="etiqueta">Resultado</div><pre>${escapar(formatoJson(llamada.resultado))}</pre>`}`
  return d
}

function propuestaConfirmacion(p) {
  const campos = p.campos.map((c) => `${c.campo.replace(/_/g, " ")} ${c.valor_propuesto || "(vacío)"}`).join(" y ")
  return `Confirmo para ${p.mensaje_id}: ${campos}`
}

function bloqueConfirmacion(pendientes) {
  const div = document.createElement("div")
  div.className = "confirmacion"
  const tablas = pendientes
    .map((p) => `<p><strong>${escapar(p.mensaje_id)}</strong> · ${escapar(p.clasificacion)}</p>
      <div class="tabla-desplazable"><table><thead><tr><th>Campo</th><th>Valor propuesto</th><th>Confianza</th><th>Motivo</th></tr></thead>
      <tbody>${p.campos.map((c) => `<tr><td>${escapar(c.campo)}</td><td>${escapar(c.valor_propuesto || "(vacío)")}</td><td>${c.confianza ?? "—"}</td><td>${escapar(c.motivo)}</td></tr>`).join("")}</tbody></table></div>`)
    .join("")
  div.innerHTML = `<h3>⚠️ El agente espera tu confirmación antes de registrar</h3>${tablas}<div class="botones"></div>`
  const botones = div.querySelector(".botones")
  for (const p of pendientes) {
    const confirmar = document.createElement("button")
    confirmar.className = "btn"
    confirmar.type = "button"
    confirmar.textContent = `Confirmar valores de ${p.mensaje_id}`
    confirmar.onclick = () => enviar(propuestaConfirmacion(p))
    const corregir = document.createElement("button")
    corregir.className = "btn sec"
    corregir.type = "button"
    corregir.textContent = "Corregir antes de confirmar"
    corregir.onclick = () => {
      $("#texto").value = propuestaConfirmacion(p)
      $("#texto").focus()
    }
    botones.append(confirmar, corregir)
  }
  return div
}

function completarBurbuja(burbuja, r) {
  const herramientas = burbuja.querySelector(".herramientas")
  herramientas.replaceChildren(...(r.toolCalls || []).map((t) => tarjetaHerramienta(t)))
  const cuerpo = burbuja.querySelector(".cuerpo")
  cuerpo.className = "cuerpo md"
  cuerpo.innerHTML = markdown(r.reply ?? r.texto)
  if (r.error) burbuja.classList.add("error")
  if (r.needsConfirmation && r.pendientes?.length) burbuja.append(bloqueConfirmacion(r.pendientes))
  desplazar()
}

// ---------- Envío con streaming de eventos ----------

async function enviar(texto) {
  if (estado.ocupado || !texto.trim()) return
  estado.ocupado = true
  $("#enviar").disabled = true
  document.querySelectorAll(".confirmacion .btn").forEach((b) => (b.disabled = true))
  burbujaUsuario(texto)
  $("#texto").value = ""
  const burbuja = crearBurbujaAgente()
  const cuerpo = burbuja.querySelector(".cuerpo")
  const herramientas = burbuja.querySelector(".herramientas")
  cuerpo.innerHTML = `<div class="pensando">pensando…</div>`
  try {
    const res = await fetch("/api/chat/stream", { method: "POST", headers: cabeceras(), body: JSON.stringify({ sessionId: estado.sesion, message: texto }) })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const lector = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let bufer = ""
    let final = null
    for (;;) {
      const { value, done } = await lector.read()
      if (done) break
      bufer += value
      let corte
      while ((corte = bufer.indexOf("\n\n")) >= 0) {
        const bloque = bufer.slice(0, corte)
        bufer = bufer.slice(corte + 2)
        const evento = /^event: (.+)$/m.exec(bloque)?.[1]
        const datos = /^data: (.+)$/m.exec(bloque)?.[1]
        if (!evento || !datos) continue
        const e = JSON.parse(datos)
        if (evento === "tool_call") herramientas.append(tarjetaHerramienta({ id: e.id, nombre: e.nombre, args: e.args }, true))
        if (evento === "tool_result") herramientas.querySelector(`[data-id="${CSS.escape(e.llamada.id)}"]`)?.replaceWith(tarjetaHerramienta(e.llamada))
        if (evento === "pensando") cuerpo.innerHTML = `<div class="pensando">pensando… (iteración ${e.iteracion})</div>`
        if (evento === "fin") final = e
        desplazar()
      }
    }
    if (!final) throw new Error("la conexión se cerró antes de terminar")
    completarBurbuja(burbuja, final)
    if (final.uso) $("#uso").textContent = `${final.uso.sesion.toLocaleString("es-CO")} / ${final.uso.tope.toLocaleString("es-CO")} tokens`
  } catch (e) {
    completarBurbuja(burbuja, { reply: `No pude comunicarme con el agente: ${e.message}`, error: true, toolCalls: [] })
  } finally {
    estado.ocupado = false
    $("#enviar").disabled = false
    refrescarLateral()
  }
}

// ---------- Panel lateral ----------

const COLUMNAS = ["id_contrato", "cliente", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro"]

async function refrescarLateral() {
  try {
    const { filas } = await api("/api/maestro")
    $("#vista-maestro").innerHTML = `<p class="leyenda">out/sharepoint/maestro-contratos.csv · ${filas.length} filas · resaltadas las registradas después del corte (2026-05-30)</p>
      <div class="tabla-desplazable"><table><thead><tr>${COLUMNAS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>
      ${filas.map((f) => `<tr class="${f.fecha_registro > "2026-05-30" ? "nueva" : ""}">${COLUMNAS.map((c) => `<td>${escapar(f[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    const { markdown: md } = await api("/api/alertas")
    $("#vista-alertas").innerHTML = md ? markdown(md) : `<p class="leyenda">Aún no se ha generado out/alertas.md. Pídele al agente el reporte de alertas.</p>`
  } catch (e) {
    $("#vista-maestro").innerHTML = `<p class="leyenda">No se pudo cargar el maestro: ${escapar(e.message)}</p>`
  }
}

document.querySelectorAll(".pestana").forEach((p) =>
  p.addEventListener("click", () => {
    document.querySelectorAll(".pestana").forEach((x) => x.classList.toggle("activa", x === p))
    $("#vista-maestro").hidden = p.dataset.vista !== "maestro"
    $("#vista-alertas").hidden = p.dataset.vista !== "alertas"
  }),
)

// ---------- Arranque ----------

async function cargarHistorial() {
  contenedor.replaceChildren()
  $("#sesion").textContent = estado.sesion
  try {
    const s = await api(`/api/sessions/${estado.sesion}`)
    for (const t of s.historial) {
      if (t.rol === "usuario") burbujaUsuario(t.texto)
      else completarBurbuja(crearBurbujaAgente(), { ...t, reply: t.texto })
    }
    $("#uso").textContent = `${(s.tokens.entrada + s.tokens.salida).toLocaleString("es-CO")} tokens`
  } catch {
    const b = crearBurbujaAgente()
    completarBurbuja(b, { reply: "Hola. Soy el agente de registro de contratos. Puedo procesar el buzón, pedirte confirmación de los campos dudosos y generar el reporte de alertas. Prueba con una de las sugerencias.", toolCalls: [] })
  }
}

function pintarSugerencias() {
  $("#sugerencias").replaceChildren(
    ...SUGERENCIAS.map((s) => {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "chip"
      b.textContent = s.length > 70 ? `${s.slice(0, 68)}…` : s
      b.title = s
      b.onclick = () => enviar(s)
      return b
    }),
  )
}

async function iniciar() {
  try {
    const h = await api("/api/health")
    $("#proveedor").textContent = `${h.provider} · ${h.model}`
    $("#aviso-simulado").hidden = h.provider !== "simulado"
    $("#panel-clave").hidden = !(h.requiereClave && !estado.clave)
    $("#reiniciar").hidden = !h.permiteReinicio
  } catch {
    $("#proveedor").textContent = "backend no disponible"
  }
  pintarSugerencias()
  await cargarHistorial()
  refrescarLateral()
}

$("#formulario").addEventListener("submit", (e) => {
  e.preventDefault()
  enviar($("#texto").value)
})
$("#texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    enviar($("#texto").value)
  }
})
$("#nueva").addEventListener("click", () => {
  estado.sesion = nuevaSesionId()
  almacenar.escribir("sesion", estado.sesion)
  cargarHistorial()
})
$("#reiniciar").addEventListener("click", async () => {
  try {
    await api("/api/reset", { method: "POST", body: "{}" })
    estado.sesion = nuevaSesionId()
    almacenar.escribir("sesion", estado.sesion)
    await cargarHistorial()
    refrescarLateral()
  } catch (e) {
    completarBurbuja(crearBurbujaAgente(), { reply: `No se pudo reiniciar: ${e.message}`, error: true, toolCalls: [] })
  }
})
$("#guardar-clave").addEventListener("click", () => {
  estado.clave = $("#clave").value.trim()
  almacenar.escribir("clave", estado.clave)
  $("#panel-clave").hidden = true
  iniciar()
})

iniciar()
