// Dónde viven los archivos. Dos drivers con la misma interfaz:
//   fs   - carpeta local, para desarrollo y para correr en tu propia máquina.
//   blob - Vercel Blob, para el deploy serverless (el filesystem de Vercel es de sólo lectura).
// El driver se elige solo: si hay BLOB_READ_WRITE_TOKEN, es blob.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const DATA_DIR = process.env.INMO3D_DATA ?
    path.resolve(process.env.INMO3D_DATA) : path.join(ROOT, 'data');

export const isBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
export const onVercel = process.env.VERCEL === '1';
export const driver = isBlob ? 'blob' : 'fs';

/** En Vercel sin Blob Store no hay dónde escribir: mejor decirlo claro y temprano. */
export function assertWritable() {
    if (onVercel && !isBlob) {
        throw new Error('Este deploy no tiene almacenamiento. Creá un Blob Store en Vercel ' +
            '(Storage → Create → Blob) y conectalo al proyecto: eso inyecta BLOB_READ_WRITE_TOKEN.');
    }
}

let _blob;
const blob = async () => (_blob ??= await import('@vercel/blob'));

// La base pública del store es fija; la aprendemos una vez y después armamos las URLs solos.
let base = null;
async function baseUrl() {
    if (base) return base;
    const { list } = await blob();
    const { blobs } = await list({ limit: 1 });
    if (blobs[0]) base = new URL(blobs[0].url).origin;
    if (!base) throw new Error('El Blob Store está vacío todavía.');
    return base;
}

const local = key => path.join(DATA_DIR, key);
const guard = (key) => {
    const file = path.resolve(local(key));
    if (!file.startsWith(path.resolve(DATA_DIR))) throw new Error('Ruta inválida.');
    return file;
};

/** Guarda bytes y devuelve la URL con la que el navegador los va a pedir. */
export async function put(key, data, contentType = 'application/octet-stream') {
    assertWritable();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!isBlob) {
        const file = guard(key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, buf);
        return { key, url: `/media/${key}`, bytes: buf.length };
    }
    const { put: blobPut } = await blob();
    const res = await blobPut(key, buf, {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType
    });
    base ??= new URL(res.url).origin;
    return { key, url: res.url, bytes: buf.length };
}

/** Lee bytes, tanto de una URL pública del Blob como de la carpeta local. */
export async function get(urlOrKey) {
    if (/^https?:/.test(urlOrKey)) {
        const res = await fetch(urlOrKey);
        if (!res.ok) throw new Error(`No pude leer ${urlOrKey} (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
    }
    const key = urlOrKey.replace(/^\/media\//, '');
    if (!isBlob) return fs.readFile(guard(key));
    return get(`${await baseUrl()}/${key}`);
}

export async function readJson(key) {
    try {
        if (!isBlob) return JSON.parse(await fs.readFile(guard(key), 'utf8'));
        // El query rompe la caché del CDN: después de guardar queremos leer lo recién escrito.
        const res = await fetch(`${await baseUrl()}/${key}?v=${Date.now()}`, { cache: 'no-store' });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

export async function writeJson(key, value) {
    await put(key, JSON.stringify(value, null, 2), 'application/json');
    return value;
}

/** Los ids de las propiedades: cada una es una carpeta con su property.json adentro. */
export async function folders() {
    if (!isBlob) {
        const names = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
        return names.filter(d => d.isDirectory()).map(d => d.name);
    }
    const { list } = await blob();
    const res = await list({ mode: 'folded' });
    base ??= res.blobs[0] && new URL(res.blobs[0].url).origin;
    return (res.folders ?? []).map(f => f.replace(/\/$/, ''));
}

export async function remove(prefix) {
    if (!isBlob) {
        await fs.rm(guard(prefix), { recursive: true, force: true });
        return;
    }
    const { list, del } = await blob();
    const { blobs } = await list({ prefix });
    if (blobs.length) await del(blobs.map(b => b.url));
}

export async function ensure() {
    if (!isBlob) await fs.mkdir(DATA_DIR, { recursive: true });
}
