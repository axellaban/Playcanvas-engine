// Servidor local: sirve la UI, los archivos de las propiedades y el motor de este repo,
// y delega /api a la misma función que corre en Vercel (server/app.mjs).
//   /                     -> panel de propiedades
//   /tour.html?id=...     -> visor 3D del tour
//   /engine/...           -> el motor PlayCanvas de este repo (o CDN si no está compilado)
//   /media/<id>/...       -> fotos, splats y renders de cada propiedad
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ROOT, DATA_DIR, ensureData } from './store.mjs';
import { api } from './app.mjs';
import * as ai from './ai.mjs';
import { enLaRed } from './red.mjs';

const ENGINE_ROOT = path.resolve(ROOT, '..');
const WEB = path.join(ROOT, 'public');
const CDN = 'https://cdn.jsdelivr.net/npm/playcanvas@2.23.0-beta.9';

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

/** Sirve un archivo impidiendo salirse de la carpeta permitida. */
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
            return send(res, 302, '', { location: `${CDN}/build/playcanvas.mjs` });
        }
        if (url.pathname.startsWith('/engine/scripts/')) {
            const rel = url.pathname.slice('/engine/'.length);
            const local = path.join(ENGINE_ROOT, rel);
            if (await fs.access(local).then(() => true, () => false)) {
                return serveFile(res, ENGINE_ROOT, rel);
            }
            return send(res, 302, '', { location: `${CDN}/${rel}` });
        }
        if (url.pathname.startsWith('/engine/')) {
            return serveFile(res, ENGINE_ROOT, url.pathname.slice('/engine/'.length));
        }
        if (url.pathname.startsWith('/media/')) {
            return serveFile(res, DATA_DIR, url.pathname.slice('/media/'.length),
                { download: url.searchParams.has('download') });
        }

        return await serveFile(res, WEB, url.pathname === '/' ? 'index.html' : url.pathname);
    } catch (e) {
        send(res, e.status || 500, JSON.stringify({ error: e.message }), { 'content-type': 'application/json' });
    }
});

await ensureData().catch(e => console.warn(`  aviso: ${e.message}`));
const port = Number(process.env.PORT || 3113);
server.listen(port, () => {
    const c = ai.config();
    console.log(`\n  Inmo3D en http://localhost:${port}`);
    for (const ip of enLaRed()) {
        console.log(`  Desde el celular (misma wifi): http://${ip}:${port}`);
    }
    console.log(`  datos: ${DATA_DIR}`);
    console.log(`  IA texto: ${c.text ? c.textModel : 'sin configurar (falta ANTHROPIC_API_KEY)'}`);
    console.log(`  IA imagen: ${c.image ? c.imageProvider : 'sin configurar (INMO3D_IMAGE_PROVIDER)'}\n`);
});
