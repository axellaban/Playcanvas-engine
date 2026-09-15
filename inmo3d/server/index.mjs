// Servidor de Inmo3D. Sin dependencias: sólo Node.
//  /                     -> panel de propiedades
//  /tour.html?id=...     -> visor 3D del tour
//  /engine/...           -> el motor PlayCanvas de este mismo repo (o CDN si no está compilado)
//  /media/<id>/...       -> fotos, splats y renders de cada propiedad
//  /api/...              -> API JSON
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, DATA_DIR, propDir, slug, listProperties, getProperty, createProperty,
    patchProperty, deleteProperty, saveProperty, ensureData } from './store.mjs';
import * as pipe from './pipeline.mjs';
import * as ai from './ai.mjs';

const ENGINE_ROOT = path.resolve(ROOT, '..');
const WEB = path.join(ROOT, 'web');
const CDN = 'https://cdn.jsdelivr.net/npm/playcanvas@2.23.0/build/playcanvas.mjs';

// .env casero, para no depender de nada.
for (const line of (await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ply': 'application/octet-stream',
    '.sog': 'application/octet-stream',
    '.spz': 'application/octet-stream',
    '.glb': 'model/gltf-binary',
    '.wasm': 'application/wasm',
    '.log': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};

const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'cache-control': 'no-cache', ...headers });
    res.end(body);
};
const json = (res, data, code = 200) => send(res, code, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' });
const fail = (res, err, code = 400) => json(res, { error: err instanceof Error ? err.message : String(err) }, code);

/**
 * Sirve un archivo impidiendo salirse de la carpeta permitida.
 * @param res
 * @param root
 * @param rel
 * @param root0
 * @param root0.download
 */
async function serveFile(res, root, rel, { download = false } = {}) {
    const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
    if (!file.startsWith(path.resolve(root))) return send(res, 403, 'Prohibido');
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return send(res, 404, 'No encontrado');
    const headers = {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': stat.size
    };
    if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    res.writeHead(200, headers);
    return pipeline(createReadStream(file), res).catch(() => {});
}

async function readJson(req, limit = 32 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit) throw new Error('Cuerpo demasiado grande.');
        chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

/**
 * Subida cruda: el navegador manda el archivo como body, el nombre va en la query.
 * @param req
 * @param dir
 * @param name
 */
async function saveUpload(req, dir, name) {
    await fs.mkdir(dir, { recursive: true });
    const ext = path.extname(name).toLowerCase() || '.bin';
    const file = `${slug(path.basename(name, ext), randomUUID().slice(0, 8))}${ext}`;
    const dest = path.join(dir, file);
    await pipeline(req, createWriteStream(dest));
    const { size } = await fs.stat(dest);
    return { file, bytes: size };
}

const need = async (res, id) => {
    const prop = await getProperty(id);
    if (!prop) json(res, { error: 'Propiedad inexistente.' }, 404);
    return prop;
};

async function api(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean).slice(1);   // saca 'api'
    const { method } = req;
    const q = url.searchParams;

    if (seg[0] === 'config' && method === 'GET') {
        return json(res, { ai: ai.config(), dataDir: DATA_DIR });
    }

    if (seg[0] !== 'properties') return json(res, { error: 'Ruta desconocida.' }, 404);

    if (seg.length === 1) {
        if (method === 'GET') return json(res, await listProperties());
        if (method === 'POST') return json(res, await createProperty((await readJson(req)).meta || {}), 201);
        return json(res, { error: 'Método no permitido.' }, 405);
    }

    const id = seg[1];
    const dir = propDir(id);
    const action = seg[2];

    // ---- la propiedad en sí
    if (!action) {
        if (method === 'GET') {
            const prop = await need(res, id);
            return prop && json(res, prop);
        }
        if (method === 'PATCH') {
            const prop = await patchProperty(id, await readJson(req));
            return prop ? json(res, prop) : json(res, { error: 'Propiedad inexistente.' }, 404);
        }
        if (method === 'DELETE') return json(res, { ok: await deleteProperty(id) });
        return json(res, { error: 'Método no permitido.' }, 405);
    }

    // ---- fotos
    if (action === 'photos') {
        const prop = await need(res, id);
        if (!prop) return;
        if (method === 'POST') {
            const up = await saveUpload(req, path.join(dir, 'photos'), q.get('name') || 'foto.jpg');
            prop.photos = prop.photos.filter(p => p.file !== up.file);
            prop.photos.push({ ...up, addedAt: new Date().toISOString() });
            await saveProperty(prop);
            return json(res, up, 201);
        }
        if (method === 'DELETE') {
            const file = seg[3];
            prop.photos = prop.photos.filter(p => p.file !== file);
            await fs.rm(path.join(dir, 'photos', path.basename(file)), { force: true });
            await saveProperty(prop);
            return json(res, { ok: true });
        }
    }

    // ---- splat ya entrenado (atajo: si ya tenés un .sog/.ply, no hace falta el pipeline)
    if (action === 'splat' && method === 'POST') {
        const prop = await need(res, id);
        if (!prop) return;
        const name = q.get('name') || 'model.sog';
        if (!/\.(?:sog|ply|spz|json)$/i.test(name)) {
            return fail(res, 'Formato no soportado: usá .sog, .ply (o .compressed.ply) o .spz.');
        }
        const up = await saveUpload(req, path.join(dir, 'splat'), name);
        prop.scene.splat = `splat/${up.file}`;
        prop.job = { status: 'done', step: 'listo', progress: 100, finishedAt: new Date().toISOString() };
        await saveProperty(prop);
        return json(res, { ...up, splat: prop.scene.splat }, 201);
    }

    // ---- reconstrucción
    if (action === 'reconstruct') {
        if (method === 'POST') {
            const body = await readJson(req);
            try {
                return json(res, await pipe.start(id, body), 202);
            } catch (e) {
                return fail(res, e);
            }
        }
        if (method === 'DELETE') return json(res, { stopped: pipe.stop(id) });
    }

    if (action === 'job' && method === 'GET') {
        const prop = await need(res, id);
        return prop && json(res, { job: prop.job, running: pipe.isRunning(id), log: await pipe.tail(id) });
    }

    // ---- IA
    if (action === 'ai' && method === 'POST') {
        const prop = await need(res, id);
        if (!prop) return;
        const photos = path.join(dir, 'photos');
        const body = await readJson(req);
        try {
            switch (seg[3]) {
                case 'audit': {
                    prop.ai.audit = { ...await ai.auditPhotos(prop, photos), at: new Date().toISOString() };
                    await saveProperty(prop);
                    return json(res, prop.ai.audit);
                }
                case 'listing': {
                    prop.ai.listing = { ...await ai.writeListing(prop, photos, body.extra || ''), at: new Date().toISOString() };
                    await saveProperty(prop);
                    return json(res, prop.ai.listing);
                }
                case 'rooms': {
                    prop.ai.rooms = { ...await ai.detectRooms(prop, photos), at: new Date().toISOString() };
                    await saveProperty(prop);
                    return json(res, prop.ai.rooms);
                }
                case 'ask':
                    return json(res, { answer: await ai.askAboutProperty(prop, body.question || '') });
                case 'stage': {
                    // body.image llega como data URL desde el visor (la vista renderizada del tour).
                    const m = String(body.image || '').match(/^data:([^;]+);base64,(.+)$/);
                    if (!m) return fail(res, 'Mandá la imagen como data URL base64.');
                    const out = await ai.stage({ b64: m[2], mime: m[1], style: body.style, room: body.room, notes: body.notes });
                    const file = `staged-${Date.now()}.${out.mime.includes('jpeg') ? 'jpg' : 'png'}`;
                    await fs.mkdir(path.join(dir, 'staged'), { recursive: true });
                    await fs.writeFile(path.join(dir, 'staged', file), Buffer.from(out.b64, 'base64'));
                    const entry = {
                        file: `staged/${file}`,
                        style: body.style || 'moderno',
                        room: body.room || '',
                        at: new Date().toISOString()
                    };
                    prop.ai.staged.unshift(entry);
                    await saveProperty(prop);
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

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname.startsWith('/api/')) return await api(req, res, url);

        // El motor: build local del fork; si no está compilado, caemos al CDN.
        if (url.pathname === '/engine/build/playcanvas.mjs') {
            const local = path.join(ENGINE_ROOT, 'build', 'playcanvas.mjs');
            if (await fs.access(local).then(() => true, () => false)) {
                return serveFile(res, ENGINE_ROOT, 'build/playcanvas.mjs');
            }
            return send(res, 302, '', { location: CDN });
        }
        if (url.pathname.startsWith('/engine/')) {
            return serveFile(res, ENGINE_ROOT, url.pathname.slice('/engine/'.length));
        }
        if (url.pathname.startsWith('/media/')) {
            return serveFile(res, DATA_DIR, url.pathname.slice('/media/'.length),
                { download: url.searchParams.has('download') });
        }

        const rel = url.pathname === '/' ? 'index.html' : url.pathname;
        return await serveFile(res, WEB, rel);
    } catch (e) {
        fail(res, e, 500);
    }
});

await ensureData();
const port = Number(process.env.PORT || 3113);
server.listen(port, () => {
    const c = ai.config();
    console.log(`\n  Inmo3D en http://localhost:${port}`);
    console.log(`  datos: ${DATA_DIR}`);
    console.log(`  IA texto: ${c.text ? c.textModel : 'sin configurar (falta ANTHROPIC_API_KEY)'}`);
    console.log(`  IA imagen: ${c.image ? c.imageProvider : 'sin configurar (INMO3D_IMAGE_PROVIDER)'}\n`);
});
