# Inmo3D

**Sacás fotos de una casa → sale un tour 3D navegable → la IA hace el resto del trabajo inmobiliario.**

Construido adentro de este fork del motor [PlayCanvas](https://github.com/playcanvas/engine), que ya trae
soporte nativo de 3D Gaussian Splatting con streaming, LOD y WebXR. El tour corre en cualquier navegador,
sin plugins y sin app: se comparte con un link o se embebe en el portal de la inmobiliaria.

```
📷 fotos  ──► COLMAP/GLOMAP ──► 3DGS ──► .sog ──► 🏠 tour web ──► 🤖 IA
   80-200      poses de           nube de   comprimido   órbita,        auditoría de captura
   tomas       cámara             gaussians  10-20x       caminata,      ambientes + guion
                                                          medición,      aviso listo para publicar
                                                          hotspots       home staging virtual
                                                                         chat con el interesado
```

---

## Probarlo en un minuto (sin GPU, sin fotos, sin internet)

```bash
cd inmo3d
node ../build.mjs --format esm --type rel   # compila el motor de este repo (una sola vez)
npm run demo                               # genera una casa sintética de ejemplo
npm start                                  # http://localhost:3113
```

Abrí <http://localhost:3113/tour.html?id=demo-casa-del-parque>: es una casa de 10 × 8 m con cocina,
estar, comedor y dormitorio, generada como nube de gaussians por `tools/demo-splat.mjs`. Sirve para
recorrer el visor completo antes de tener un escaneo real.

> Si no compilás el motor, el servidor cae al CDN de PlayCanvas y funciona igual.
> Las funciones de IA son opcionales: sin API keys el resto anda perfecto.

---

## El flujo real

### 1. Sacar las fotos

Es el 80% del resultado final. Nada de lo que venga después arregla una captura pobre.

- **80 a 200 fotos** por propiedad. Menos de 20 ni lo intenta.
- **60-80% de solape** entre tomas consecutivas: cada foto tiene que compartir la mayor parte del
  encuadre con la anterior. Caminá de a pasos cortos, no saltes de un rincón al otro.
- **Foco y exposición bloqueados**, HDR apagado, ISO bajo. Las fotos tienen que ser consistentes
  entre sí, no bonitas por separado.
- **Órbita por ambiente**: una vuelta completa pegado a las paredes mirando al centro, otra desde el
  centro mirando hacia afuera, y una pasada de detalle en lo que querés destacar.
- **Persianas arriba, luces prendidas, nada en movimiento.** Cortinas al viento, mascotas y personas
  rompen la reconstrucción.
- **Cuidado con espejos y ventanas quemadas**: el algoritmo los interpreta como profundidad real.
- Nada de fotos extraídas de video con paneo: salen con motion blur.

Subilas al panel (arrastrar y soltar) y apretá **🔍 Auditar captura**: la IA mira las fotos y te
devuelve qué ambientes cubriste, qué falta fotografiar y qué tomas conviene repetir — *antes* de
gastar horas de GPU.

### 2. Reconstruir

Botón **🧱 Reconstruir en 3D**. Por atrás corre [`pipeline/reconstruct.sh`](pipeline/README.md):
COLMAP o GLOMAP resuelven las poses de cámara, un entrenador de Gaussian Splatting genera la nube, y
`@playcanvas/splat-transform` la comprime al `.sog` que este motor carga nativo. El panel muestra
etapa, progreso y log en vivo.

**¿No tenés GPU?** Entrená afuera y usá **⬆ Subir splat ya entrenado**: sirve cualquier `.ply`,
`.compressed.ply`, `.spz` o `.sog` de [SuperSplat](https://superspl.at), Polycam, Luma, Scaniverse,
Postshot o Nerfstudio. Todo lo demás del producto funciona igual.

### 3. Armar el tour

En el visor, con la escena cargada:

| Herramienta | Para qué |
|---|---|
| 🧭 **Enderezar escena** | Los escaneos salen con la orientación de la cámara, no de la casa. Girás hasta que el piso quede horizontal. |
| ⬇ **Piso** | Un click en el suelo fija la altura de caminata. |
| 📐 **Calibrar** | Marcás dos puntos de algo que sepas cuánto mide (una puerta = 2,05 m) y **todas las medidas pasan a ser metros reales**. La fotogrametría no tiene escala propia: sin este paso las distancias son relativas. |
| 🎯 **Ubicar paradas** | Te parás donde querés que arranque cada parada y hacés click en lo que tiene que mirar. |
| 📍 **Hotspot** | Notas ancladas en el espacio 3D ("mesada de granito", "DVH orientación noroeste"). |
| 📏 **Medir** | Distancias reales, guardadas con la propiedad. El interesado también puede medir. |
| 🚶 / 🛰 | Caminata (click en el piso = teletransporte, WASD, arrastrar para mirar) u órbita. |
| 🥽 **VR** | Si el dispositivo tiene WebXR, se recorre en visor. |

Atajos: `espacio` cambia de modo, `m` mide, `1-9` salta de parada, `Esc` cancela.

### 4. Vender

- **✍️ Escribir aviso** — título, descripción para portal, bullets, SEO, mensaje de WhatsApp y caption
  de Instagram. Incluye una lista de *lo que la IA no pudo verificar*, para que nadie publique un dato
  inventado.
- **🚪 Detectar ambientes** — identifica cada ambiente, propone el orden más vendedor del recorrido y
  escribe el texto de cada parada. Un botón lo convierte en las paradas del tour.
- **✨ Home staging virtual** — encuadrás un ambiente en el visor, elegís estilo y la IA lo amuebla
  respetando paredes, ventanas, perspectiva y luz. Comparás con un slider antes/después. También en
  reversa: `vacio` despeja un ambiente lleno de muebles.
- **💬 Consultas** — el interesado pregunta dentro del tour y le responde un asistente que sólo usa los
  datos cargados y las mediciones hechas en el visor. Si no sabe algo, ofrece coordinar visita en vez
  de inventar.
- **Compartir** — link directo o `<iframe>` listo para pegar, con `?ui=min` para el modo visitante
  (sin herramientas de edición).

---

## Configuración

```bash
cp .env.example .env
npm install          # sólo hace falta para la IA (@anthropic-ai/sdk)
```

| Variable | Default | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Texto y visión: auditoría, ambientes, aviso, chat |
| `INMO3D_TEXT_MODEL` | `claude-opus-5` | Modelo de Claude |
| `INMO3D_EFFORT` | `medium` | Cuánto razona el modelo: `low` … `max`. Más = mejor y más caro |
| `INMO3D_IMAGE_PROVIDER` | `gemini` | Home staging: `gemini`, `openai` o `none` |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | — | Según el proveedor elegido |
| `INMO3D_MAX_PHOTOS` | `12` | Cuántas fotos ve la IA por pedido (se reparten de punta a punta del set) |
| `PORT` | `3113` | Puerto del servidor |
| `INMO3D_DATA` | `inmo3d/data` | Dónde viven las propiedades |

Anthropic no genera imágenes: el staging usa un proveedor aparte. Es el único pedazo que necesita
otro servicio.

---

## Cómo está armado

```
inmo3d/
├── server/          Node puro, cero dependencias de runtime
│   ├── index.mjs      HTTP + API + estáticos + proxy del motor
│   ├── store.mjs      una propiedad = una carpeta con su JSON (sin base de datos)
│   ├── pipeline.mjs   lanza la reconstrucción y sigue su progreso
│   └── ai.mjs         Claude (texto y visión) + proveedor de imagen enchufable
├── web/
│   ├── index.html     panel: ficha, fotos, reconstrucción, IA, compartir
│   ├── tour.html      visor
│   └── src/
│       ├── viewer.mjs   el motor: splat, cámaras, picking, captura de frame
│       ├── tour-ui.mjs  paradas, hotspots, medición, staging, chat, minimapa
│       └── panel.mjs    el panel
├── pipeline/        reconstruct.sh + Dockerfile (COLMAP + GLOMAP + OpenSplat)
└── tools/
    └── demo-splat.mjs   casa sintética para probar sin GPU
```

Decisiones que vale la pena conocer:

- **El servidor no tiene dependencias.** Las fotos se suben como cuerpo crudo del POST, así que no hace
  falta parser de multipart. El SDK de Anthropic se importa de forma perezosa: sin API key, el resto
  del producto anda igual.
- **Los datos son archivos.** Copiás `data/<propiedad>/` y te llevaste todo: fotos, splat, tour,
  medidas y lo que generó la IA. Nada queda atrapado en una base.
- **El motor sale de este repo.** `/engine/build/playcanvas.mjs` sirve el build local del fork; si no
  está compilado, redirige al CDN. Cualquier cambio que le hagas al motor se ve acá.
- **Caminar sin física.** No hay Ammo ni malla de colisión: el piso se fija con un click y el
  teletransporte usa el `Picker` del motor contra la nube de gaussians. Menos piezas, más rápido.
- **La escala se calibra, no se adivina.** La fotogrametría reconstruye la forma, no el tamaño.
  Por eso `metersPerUnit` se fija midiendo algo conocido, y ahí recién las medidas son metros.

## API

```
GET    /api/config                            qué está configurado
GET    /api/properties                        listado
POST   /api/properties                        alta          { meta }
GET    /api/properties/:id                    detalle completo
PATCH  /api/properties/:id                    merge por sección (tour, hotspots, scene, meta…)
DELETE /api/properties/:id
POST   /api/properties/:id/photos?name=x.jpg  subida (cuerpo crudo)
POST   /api/properties/:id/splat?name=x.sog   subir un splat ya entrenado
POST   /api/properties/:id/reconstruct        arranca el pipeline  { sfm, trainer, steps }
GET    /api/properties/:id/job                estado + log
POST   /api/properties/:id/ai/{audit|rooms|listing|ask|stage}
```

## Sobre hombros de gigantes

| Pieza | Proyecto |
|---|---|
| Render de gaussians, WebXR, LOD | [PlayCanvas Engine](https://github.com/playcanvas/engine) (este repo) |
| Compresión a `.sog` | [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform) |
| Edición y limpieza de splats | [SuperSplat](https://github.com/playcanvas/supersplat) |
| Poses de cámara | [COLMAP](https://github.com/colmap/colmap) · [GLOMAP](https://github.com/colmap/glomap) |
| Entrenamiento 3DGS | [brush](https://github.com/ArthurBrussee/brush) · [OpenSplat](https://github.com/pierotofy/OpenSplat) · [Nerfstudio](https://docs.nerf.studio) |
| Texto y visión | [Claude](https://docs.anthropic.com) |

## Lo que todavía no hace

Para que nadie se lleve una sorpresa:

- No extrae el plano en planta automáticamente (el minimapa es esquemático, no un plano acotado).
- No limpia sola los artefactos flotantes del escaneo: para eso, por ahora, SuperSplat.
- El staging genera una imagen, no muebles 3D dentro de la escena.
- Un solo usuario, sin login: pensado para correr en la máquina de la inmobiliaria o detrás de un proxy.
- El pipeline necesita GPU. Sin GPU, el camino es entrenar afuera y subir el `.ply`/`.sog`.
