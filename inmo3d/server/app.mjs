// La API. Corre igual como servidor local (server/index.mjs) o como función de Vercel (api/).
import * as store from './store.mjs';
import * as storage from './storage.mjs';
import * as jobs from './jobs.mjs';
import * as ai from './ai.mjs';
import { authStatus, requireAdmin, login, logout } from './auth.mjs';

const json = (res, data, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
};
const fail = (res, err, code = 400) => json(res, { error: err instanceof Error ? err.message : String(err) }, code);

/** El runtime de Vercel a veces ya parseó el cuerpo; si no, lo leemos del stream. */
export async function readJson(req, limit = 8 * 1024 * 1024) {
    if (req.body !== undefined && req.body !== null) {
        return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    }
    const buf = await readRaw(req, limit);
    return buf.length ? JSON.parse(buf.toString()) : {};
}

export async function readRaw(req, limit = 8 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit) {
            throw new Error('El archivo es demasiado grande para subirlo por acá. ' +
                'En Vercel el límite por request es 4,5 MB: los archivos grandes van directo al Blob.');
        }
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

/** Emite el token para que el navegador suba directo al Blob, sin pasar por la función. */
async function blobUploadToken(req, res) {
    if (!storage.isBlob) return fail(res, 'Este servidor no usa Vercel Blob.', 409);
    if (!storage.canClientUpload) {
        return fail(res, 'La subida directa al Blob necesita BLOB_READ_WRITE_TOKEN. ' +
            'Agregá el token en la conexión del store, o enlazá el splat por URL.', 409);
    }
    const { handleUpload } = await import('@vercel/blob/client');
    const body = await readJson(req);
    const result = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
            requireAdmin(req);
            const rutaValida = /^[a-z0-9-]+\/(?:photos\/[a-z0-9.-]+\.(?:jpe?g|png|webp)|splat\/[a-z0-9.-]+\.(?:sog|ply|spz)|video\/[a-z0-9.-]+\.(?:mp4|mov|m4v|webm))$/;
            if (!rutaValida.test(pathname)) throw new Error('Ruta de subida inválida.');
            if (!await store.getProperty(pathname.split('/')[0])) throw new Error('Propiedad inexistente.');
            return {
                allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp',
                    'video/mp4', 'video/quicktime', 'video/webm', 'application/octet-stream'],
                addRandomSuffix: false,
                allowOverwrite: true,
                maximumSizeInBytes: 1024 * 1024 * 1024
            };
        },
        onUploadCompleted: async () => { /* el cliente confirma con POST .../attach */ }
    });
    return json(res, result);
}

export async function api(req, res, url) {
    const seg = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    const { method } = req;
    const q = url.searchParams;

    if (seg[0] === 'config' && method === 'GET') {
        return json(res, {
            ai: ai.config(),
            storage: storage.driver,
            vercel: storage.onVercel,
            worker: await jobs.worker(),
            writable: !(storage.onVercel && !storage.isBlob),
            clientUpload: storage.canClientUpload,
            blobVars: storage.blobVars(),
            auth: authStatus(req)
        });
    }

    if (seg[0] === 'auth' && method === 'POST' && seg.length === 2) {
        if (seg[1] === 'login') {
            login(req, res, (await readJson(req, 4096)).token);
            return json(res, { ok: true });
        }
        if (seg[1] === 'logout') {
            logout(req, res);
            return json(res, { ok: true });
        }
    }
    // El SDK verifica la firma del callback de Blob; sólo la emisión exige sesión.
    if (seg[0] === 'blob' && seg[1] === 'upload' && method === 'POST') return blobUploadToken(req, res);

    // ---- cola de reconstrucción (las usa el worker con GPU)
    if (seg[0] === 'jobs') {
        requireAdmin(req);
        if (seg[1] === 'next' && method === 'POST') {
            const { worker: nombre } = await readJson(req);
            return json(res, await jobs.tomar(nombre || 'worker'));
        }
        if (seg[1] && method === 'POST') {
            const body = await readJson(req);
            if (body.splatUrl || body.error) return json(res, await jobs.terminar(seg[1], body));
            return json(res, await jobs.avance(seg[1], body));
        }
        return json(res, { error: 'Ruta desconocida.' }, 404);
    }

    if (seg[0] !== 'properties') return json(res, { error: 'Ruta desconocida.' }, 404);
    if (method !== 'GET' && method !== 'HEAD') requireAdmin(req);

    if (seg.length === 1) {
        if (method === 'GET') {
            // Cada propiedad es pública por su link; la cartera completa no.
            requireAdmin(req);
            return json(res, await store.listProperties());
        }
        if (method === 'POST') return json(res, await store.createProperty((await readJson(req)).meta || {}), 201);
        return json(res, { error: 'Método no permitido.' }, 405);
    }

    const id = seg[1];
    if (!/^[a-z0-9-]+$/.test(id)) return fail(res, 'Identificador de propiedad inválido.');
    const action = seg[2];

    if (!action) {
        if (method === 'GET') {
            const prop = await store.getProperty(id);
            return prop ? json(res, prop) : json(res, { error: 'Propiedad inexistente.' }, 404);
        }
        if (method === 'PATCH') {
            const prop = await store.patchProperty(id, await readJson(req));
            return prop ? json(res, prop) : json(res, { error: 'Propiedad inexistente.' }, 404);
        }
        if (method === 'DELETE') return json(res, { ok: await store.deleteProperty(id) });
        return json(res, { error: 'Método no permitido.' }, 405);
    }

    const prop = await store.getProperty(id);
    if (!prop) return json(res, { error: 'Propiedad inexistente.' }, 404);

    // ---- fotos (subida directa, para archivos chicos y para el servidor local)
    if (action === 'photos') {
        if (method === 'POST') {
            const name = q.get('name') || 'foto.jpg';
            const media = await store.putMedia(id, 'photos', name, await readRaw(req),
                req.headers['content-type'] || 'image/jpeg');
            const entry = { ...media, addedAt: new Date().toISOString() };
            // Con ?register=0 sólo se guardan los bytes: quien sube en paralelo registra
            // todo junto al final con /attach, y así un lote no se pisa a sí mismo.
            if (q.get('register') === '0') return json(res, entry, 201);
            prop.photos = [...prop.photos.filter(p => p.file !== entry.file), entry];
            await store.saveProperty(prop);
            return json(res, entry, 201);
        }
        if (method === 'DELETE') {
            const file = seg[3];
            prop.photos = prop.photos.filter(p => p.file !== file);
            await store.saveProperty(prop);
            return json(res, { ok: true });
        }
    }

    // ---- splat ya entrenado: archivo chico por acá, o URL pública / Blob por attach
    if (action === 'video' && method === 'POST') {
        const name = q.get('name') || 'recorrido.mp4';
        const media = await store.putMedia(id, 'video', name, await readRaw(req, 64 * 1024 * 1024),
            req.headers['content-type'] || 'video/mp4');
        prop.video = media;
        await store.saveProperty(prop);
        return json(res, media, 201);
    }

    if (action === 'splat' && method === 'POST') {
        const name = q.get('name') || 'model.sog';
        if (!/\.(?:sog|ply|spz|json)$/i.test(name)) {
            return fail(res, 'Formato no soportado: usá .sog, .ply (o .compressed.ply) o .spz.');
        }
        const media = await store.putMedia(id, 'splat', name, await readRaw(req, 64 * 1024 * 1024));
        prop.scene.splat = media.key;
        prop.scene.splatUrl = media.url;
        prop.job = { status: 'done', step: 'listo', progress: 100, finishedAt: new Date().toISOString() };
        await store.saveProperty(prop);
        return json(res, media, 201);
    }

    // ---- registrar un archivo que ya está subido (Blob directo o URL externa)
    if (action === 'attach' && method === 'POST') {
        const body = await readJson(req);

        // Alta por lote: un solo escritor para todo el conjunto de fotos.
        if (Array.isArray(body.photos)) {
            const seen = new Set(body.photos.map(p => p.file));
            prop.photos = [
                ...prop.photos.filter(p => !seen.has(p.file)),
                ...body.photos
                .filter(p => p.file && p.url)
                .map(p => ({ file: p.file, url: p.url, bytes: p.bytes ?? 0, addedAt: new Date().toISOString() }))
            ];
            await store.saveProperty(prop);
            return json(res, { ok: true, photos: prop.photos.length }, 201);
        }

        const { kind, url: fileUrl, file, bytes } = body;
        if (!/^https?:\/\//.test(fileUrl || '')) return fail(res, 'Mandá una URL http(s) válida.');
        if (kind === 'video') {
            prop.video = { file: file || fileUrl.split('/').pop(), url: fileUrl, bytes: bytes ?? 0 };
            await store.saveProperty(prop);
            return json(res, { ok: true, video: prop.video }, 201);
        }
        if (kind === 'splat') {
            if (!/\.(?:sog|ply|spz)(?:$|\?)/i.test(fileUrl)) {
                return fail(res, 'La URL tiene que terminar en .sog, .ply o .spz.');
            }
            prop.scene.splat = file || fileUrl;
            prop.scene.splatUrl = fileUrl;
            prop.job = { status: 'done', step: 'listo', progress: 100, finishedAt: new Date().toISOString() };
        } else {
            const entry = { file: file || fileUrl.split('/').pop(), url: fileUrl, bytes: bytes ?? 0, addedAt: new Date().toISOString() };
            prop.photos = [...prop.photos.filter(p => p.file !== entry.file), entry];
        }
        await store.saveProperty(prop);
        return json(res, { ok: true, scene: prop.scene, photos: prop.photos.length }, 201);
    }

    // ---- reconstrucción (sólo donde hay disco y binarios: local o Docker)
    if (action === 'reconstruct') {
        if (method === 'POST') {
            try {
                return json(res, await jobs.encolar(id, await readJson(req)), 202);
            } catch (e) {
                return fail(res, e, e.status);
            }
        }
        if (method === 'DELETE') return json(res, { cancelado: await jobs.cancelar(id) });
    }

    if (action === 'job' && method === 'GET') {
        return json(res, { job: prop.job, worker: await jobs.worker() });
    }

    // ---- IA
    if (action === 'ai' && method === 'POST') {
        const body = await readJson(req);
        try {
            switch (seg[3]) {
                case 'audit':
                    prop.ai.audit = { ...await ai.auditPhotos(prop), at: new Date().toISOString() };
                    await store.saveProperty(prop);
                    return json(res, prop.ai.audit);
                case 'listing':
                    prop.ai.listing = { ...await ai.writeListing(prop, body.extra || ''), at: new Date().toISOString() };
                    await store.saveProperty(prop);
                    return json(res, prop.ai.listing);
                case 'rooms':
                    prop.ai.rooms = { ...await ai.detectRooms(prop), at: new Date().toISOString() };
                    await store.saveProperty(prop);
                    return json(res, prop.ai.rooms);
                case 'ask':
                    return json(res, { answer: await ai.askAboutProperty(prop, body.question || '') });
                case 'stage': {
                    // body.image llega como data URL desde el visor (la vista renderizada del tour).
                    const m = String(body.image || '').match(/^data:([^;]+);base64,(.+)$/);
                    if (!m) return fail(res, 'Mandá la imagen como data URL base64.');
                    const out = await ai.stage({ b64: m[2], mime: m[1], style: body.style, room: body.room, notes: body.notes });
                    const name = `staged-${Date.now()}.${out.mime.includes('jpeg') ? 'jpg' : 'png'}`;
                    const media = await store.putMedia(id, 'staged', name, Buffer.from(out.b64, 'base64'), out.mime);
                    const entry = { ...media, style: body.style || 'moderno', room: body.room || '', at: new Date().toISOString() };
                    prop.ai.staged.unshift(entry);
                    await store.saveProperty(prop);
                    return json(res, entry, 201);
                }
                default:
                    return json(res, { error: 'Acción de IA desconocida.' }, 404);
            }
        } catch (e) {
            return fail(res, e, 502);
        }
    }

    return json(res, { error: 'Ruta desconocida.' }, 404);
}

/** Punto de entrada para la función serverless. */
export default async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/index' || url.pathname === '/api') {
        url.pathname = `/api/${url.searchParams.get('__path') || ''}`;
        url.searchParams.delete('__path');
    }
    try {
        await api(req, res, url);
    } catch (e) {
        if (!res.headersSent) fail(res, e, e.status || 500);
    }
}
