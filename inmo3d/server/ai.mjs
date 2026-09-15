// Capa de IA generativa.
//  - Texto y visión: Claude (SDK oficial @anthropic-ai/sdk).
//  - Imagen (home staging virtual): proveedor enchufable (Gemini u OpenAI).
// Todo es opcional: si no hay API keys, el resto de la app sigue funcionando.
import fs from 'node:fs/promises';
import path from 'node:path';

const TEXT_MODEL = process.env.INMO3D_TEXT_MODEL || 'claude-opus-5';
const EFFORT = process.env.INMO3D_EFFORT || 'medium';
const IMAGE_PROVIDER = (process.env.INMO3D_IMAGE_PROVIDER || 'none').toLowerCase();
const MAX_PHOTOS = Number(process.env.INMO3D_MAX_PHOTOS || 12);

const MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/jpeg'
};

let _client;
/** Import perezoso: el SDK sólo hace falta si realmente se usa la IA. */
async function claudeClient() {
    if (_client) return _client;
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error('Falta ANTHROPIC_API_KEY (copiá .env.example a .env y cargá tu key).');
    }
    let Anthropic;
    try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
        throw new Error('Falta el SDK: corré `npm install` dentro de inmo3d/.');
    }
    _client = new Anthropic();
    return _client;
}

export function config() {
    return {
        text: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
        textModel: TEXT_MODEL,
        effort: EFFORT,
        image: IMAGE_PROVIDER !== 'none' &&
            !!(IMAGE_PROVIDER === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY),
        imageProvider: IMAGE_PROVIDER
    };
}

/**
 * Toma como mucho MAX_PHOTOS repartidas de punta a punta del set.
 * @param list
 * @param n
 */
function sample(list, n = MAX_PHOTOS) {
    if (list.length <= n) return list;
    const step = list.length / n;
    return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}

async function imageBlocks(dir, files) {
    const blocks = [];
    for (const file of sample(files)) {
        const ext = path.extname(file).toLowerCase();
        const media_type = MIME[ext];
        if (!media_type) continue;
        const buf = await fs.readFile(path.join(dir, file)).catch(() => null);
        // El límite de la API es ~5 MB por imagen: las más pesadas se saltean con aviso.
        if (!buf || buf.length > 4.5 * 1024 * 1024) continue;
        blocks.push({ type: 'text', text: `Foto: ${file}` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type, data: buf.toString('base64') } });
    }
    return blocks;
}

async function ask(system, content, { maxTokens = 8000 } = {}) {
    const client = await claudeClient();
    const res = await client.messages.create({
        model: TEXT_MODEL,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        system,
        messages: [{ role: 'user', content }]
    });
    if (res.stop_reason === 'refusal') {
        throw new Error(`El modelo declinó la solicitud (${res.stop_details?.category ?? 'sin categoría'}).`);
    }
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/**
 * El modelo devuelve JSON; toleramos que venga envuelto en prosa o en ```json.
 * @param text
 * @param text
 * @param text
 * @param text
 * @param text
 * @param text
 * @param text
 * @param text
 * @param text
 * @param text
 */
function parseJson(text) {
    const fenced = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    const raw = (fenced ? fenced[1] : text).trim();
    try {
        return JSON.parse(raw);
    } catch { /* seguimos con el recorte por llaves */ }
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
        try {
            return JSON.parse(raw.slice(s, e + 1));
        } catch { /* cae al error de abajo */ }
    }
    throw new Error(`No pude interpretar la respuesta del modelo como JSON:\n${raw.slice(0, 400)}`);
}

const ficha = prop => JSON.stringify({ ...prop.meta, fotos: prop.photos.length }, null, 1);

const JSON_ONLY = 'Respondé ÚNICAMENTE con JSON válido, sin texto alrededor ni bloques de código.';

// ---------------------------------------------------------------- auditoría de captura

const AUDIT_SYS = `Sos un técnico especialista en fotogrametría y 3D Gaussian Splatting aplicado a inmuebles.
Evaluás si un set de fotos alcanza para reconstruir un tour 3D nítido, y das instrucciones concretas
de recaptura. Conocés los requisitos reales: 60-80% de solape entre tomas consecutivas, foco fijo y
exposición bloqueada, ISO bajo, sin HDR ni paneo de video, cobertura en órbita alrededor de cada
ambiente más una pasada de detalle, evitar espejos y ventanas quemadas, no mover objetos entre tomas.
${JSON_ONLY}`;

export async function auditPhotos(prop, dir) {
    const files = prop.photos.map(p => p.file);
    if (!files.length) throw new Error('La propiedad todavía no tiene fotos.');
    const blocks = await imageBlocks(dir, files);
    const text = await ask(AUDIT_SYS, [
        { type: 'text',
            text: `Ficha de la propiedad:\n${ficha(prop)}\n\nTotal de fotos subidas: ${files.length}${
                files.length > MAX_PHOTOS ? ` (te muestro ${MAX_PHOTOS} repartidas)` : ''}` },
        ...blocks,
        { type: 'text', text: `Devolvé este JSON exacto:
{
  "puntaje": 0-100,
  "veredicto": "una línea, en español rioplatense",
  "listoParaReconstruir": true|false,
  "cobertura": { "ambientesDetectados": ["..."], "faltantes": ["..."], "solapeEstimado": "alto|medio|bajo" },
  "problemas": [ { "foto": "nombre.jpg", "problema": "...", "severidad": "alta|media|baja", "solucion": "..." } ],
  "tomasQueFaltan": [ "instrucción concreta de qué fotografiar y desde dónde" ],
  "consejosDeCaptura": [ "..." ]
}` }
    ]);
    return parseJson(text);
}

// ---------------------------------------------------------------- copy del aviso

const LISTING_SYS = `Sos redactor publicitario inmobiliario. Escribís avisos que venden sin mentir:
sólo afirmás lo que se ve en las fotos o figura en la ficha, nunca inventás metros, ambientes,
orientación, antigüedad ni servicios. Nada de clichés vacíos ("excelente oportunidad única").
Frases cortas, concretas, sensoriales. Escribís en el idioma indicado, registro rioplatense si es español.
${JSON_ONLY}`;

export async function writeListing(prop, dir, extra = '') {
    const blocks = await imageBlocks(dir, prop.photos.map(p => p.file));
    const text = await ask(LISTING_SYS, [
        { type: 'text', text: `Ficha:\n${ficha(prop)}\n\nIdioma: ${prop.meta.language || 'es'}\n${extra}` },
        ...blocks,
        { type: 'text', text: `Devolvé este JSON exacto:
{
  "titulo": "máx 70 caracteres",
  "bajada": "una línea de gancho",
  "descripcion": "3 a 5 párrafos listos para portal inmobiliario",
  "destacados": ["6 a 8 bullets cortos"],
  "fichaTecnica": { "ambientes": "...", "estado": "...", "luzNatural": "...", "terminaciones": "..." },
  "publicoIdeal": "a quién le sirve esta propiedad y por qué",
  "seo": ["8 a 12 palabras clave de búsqueda"],
  "whatsapp": "mensaje breve para mandar a un interesado",
  "instagram": "caption con 3 hashtags",
  "advertencias": ["cosas que el modelo NO pudo verificar y conviene chequear antes de publicar"]
}` }
    ], { maxTokens: 12000 });
    return parseJson(text);
}

// ---------------------------------------------------------------- ambientes y guion del tour

const ROOMS_SYS = `Sos un arquitecto que arma recorridos guiados de propiedades. A partir de las fotos
identificás los ambientes, los ordenás en el recorrido más vendedor (de lo más impactante a lo
funcional) y escribís el texto que se lee en cada parada del tour 3D. ${JSON_ONLY}`;

export async function detectRooms(prop, dir) {
    const blocks = await imageBlocks(dir, prop.photos.map(p => p.file));
    const text = await ask(ROOMS_SYS, [
        { type: 'text', text: `Ficha:\n${ficha(prop)}` },
        ...blocks,
        { type: 'text', text: `Devolvé este JSON exacto:
{
  "ambientes": [ { "nombre": "Living", "tipo": "living|cocina|dormitorio|baño|patio|garage|otro",
                   "fotos": ["archivo.jpg"], "m2Estimados": 0,
                   "texto": "2 frases para la parada del tour",
                   "puntosFuertes": ["..."], "aMejorar": ["..."] } ],
  "ordenDelTour": ["Living", "Cocina"],
  "guion": "párrafo de bienvenida para arrancar el tour"
}` }
    ]);
    return parseJson(text);
}

// ---------------------------------------------------------------- preguntas del interesado

const ASK_SYS = `Sos el asistente de una inmobiliaria atendiendo a un interesado dentro del tour 3D.
Respondés corto (máximo 4 frases), cordial y honesto. Usás SÓLO los datos de la propiedad que te paso,
incluidas las mediciones hechas en el visor. Si algo no está en los datos, decís que lo consultás con
el asesor y ofrecés coordinar una visita. Nunca inventás precios, medidas ni condiciones.`;

export function askAboutProperty(prop, question) {
    const ctx = {
        ficha: prop.meta,
        ambientes: prop.ai?.rooms?.ambientes?.map(r => ({ nombre: r.nombre, m2: r.m2Estimados, texto: r.texto })),
        paradasDelTour: prop.tour.map(t => ({ nombre: t.name, texto: t.desc })),
        medicionesEnElVisor: prop.measures.map(m => ({ que: m.label, metros: m.meters })),
        destacados: prop.ai?.listing?.destacados
    };
    return ask(ASK_SYS, `Datos de la propiedad:\n${JSON.stringify(ctx, null, 1)}\n\nPregunta del interesado: ${question}`,
        { maxTokens: 1500 });
}

// ---------------------------------------------------------------- home staging virtual

const STYLES = {
    moderno: 'estilo moderno contemporáneo, muebles de líneas limpias, paleta neutra con un acento cálido',
    escandinavo: 'estilo escandinavo, madera clara, textiles blancos y grises, mucha luz',
    industrial: 'estilo industrial, metal negro, cuero, ladrillo a la vista',
    clasico: 'estilo clásico elegante, maderas nobles, textiles con textura',
    minimalista: 'minimalista, poquísimos muebles, superficies despejadas',
    vacio: 'ambiente completamente vacío y despejado, sin muebles ni objetos personales'
};

const stagePrompt = (style, room, notes) => `Virtual home staging for a real estate listing.
Keep the architecture EXACTLY as in the photo: same walls, windows, doors, floor, ceiling, camera angle,
perspective and lighting direction. Do not move, add or remove any structural element.
${style === 'vacio' ?
        'Remove all furniture, clutter and personal items; leave a clean, empty, freshly maintained room.' :
        `Furnish and decorate this ${room || 'room'} tastefully: ${STYLES[style] || style}. Add believable furniture at
realistic scale, soft natural light, tidy surfaces. Remove clutter and personal items.`}
Photorealistic, architectural photography, no text, no watermark, no people.
${notes || ''}`;

async function stageWithGemini(b64, mime, prompt) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Falta GEMINI_API_KEY.');
    const model = process.env.INMO3D_GEMINI_MODEL || 'gemini-2.5-flash-image';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }]
        })
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const part = json.candidates?.[0]?.content?.parts?.find(p => p.inline_data || p.inlineData);
    const data = part?.inline_data?.data ?? part?.inlineData?.data;
    if (!data) throw new Error('Gemini no devolvió imagen.');
    return { b64: data, mime: part?.inline_data?.mime_type ?? part?.inlineData?.mimeType ?? 'image/png' };
}

async function stageWithOpenAI(b64, mime, prompt) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Falta OPENAI_API_KEY.');
    const form = new FormData();
    form.append('model', process.env.INMO3D_OPENAI_IMAGE_MODEL || 'gpt-image-1');
    form.append('prompt', prompt);
    form.append('image', new Blob([Buffer.from(b64, 'base64')], { type: mime }), 'scene.png');
    const res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const data = json.data?.[0]?.b64_json;
    if (!data) throw new Error('OpenAI no devolvió imagen.');
    return { b64: data, mime: 'image/png' };
}

/**
 * Recibe la vista renderizada del tour (o una foto) y devuelve la versión amueblada.
 * @param root0
 * @param root0.b64
 * @param root0.mime
 * @param root0.style
 * @param root0.room
 * @param root0.notes
 */
export async function stage({ b64, mime = 'image/png', style = 'moderno', room = '', notes = '' }) {
    const prompt = stagePrompt(style, room, notes);
    if (IMAGE_PROVIDER === 'gemini') return { ...await stageWithGemini(b64, mime, prompt), prompt };
    if (IMAGE_PROVIDER === 'openai') return { ...await stageWithOpenAI(b64, mime, prompt), prompt };
    throw new Error('No hay proveedor de imagen configurado (INMO3D_IMAGE_PROVIDER).');
}
