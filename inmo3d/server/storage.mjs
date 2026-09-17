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

// El SDK se autentica de dos maneras: con el token read-write, o con el store id más el
// OIDC que Vercel inyecta en la función. Con cualquiera de las dos alcanza para leer y escribir.
export const isBlob = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
// La subida directa navegador -> Blob sí necesita el token: es lo único que lo pide.
export const canClientUpload = !!process.env.BLOB_READ_WRITE_TOKEN;
export const onVercel = process.env.VERCEL === '1';
export const driver = isBlob ? 'blob' : 'fs';

/** Qué variables del Blob ve el deploy. Sólo los nombres: los valores nunca salen de acá. */
export const blobVars = () => Object.keys(process.env)
.filter(k => k.startsWith('BLOB_') || k === 'VERCEL_OIDC_TOKEN').sort();

/** En Vercel sin Blob Store no hay dónde escribir: mejor decirlo claro y temprano. */
export function assertWritable() {
    if (onVercel && !isBlob) {
        throw Object.assign(new Error('Este deploy no tiene almacenamiento. Creá un Blob Store en ' +
            'Vercel (Storage → Create Database → Blob) y conectalo al proyecto.'), { status: 503 });
    }
}

let _blob;
const blob = async () => (_blob ??= await import('@vercel/blob'));

/**
 * El SDK avisa en inglés; acá lo traducimos a qué hacer. Devuelve null si el mensaje no es
 * ninguno de los conocidos. Va aparte y sin tocar nada de afuera para poder probarlo.
 * @param {string} mensaje - Lo que dijo el SDK.
 * @returns {string|null} Qué hacer, o null si no lo reconocemos.
 */
export function explicarFalloBlob(mensaje) {
    const texto = String(mensaje ?? '');
    if (/No blob credentials|No read-write token/i.test(texto)) {
        return 'El Blob Store está conectado pero falta la credencial. En Vercel: ' +
            'Storage → tu store → Connect Project tildando "Add a read-write token env var", ' +
            'o copiá el BLOB_READ_WRITE_TOKEN del store y pegalo como variable de entorno del ' +
            'proyecto. Después, Redeploy.';
    }
    // Un store suspendido asusta: la app deja de ver las propiedades y parece que se borraron.
    // No se borraron. Lo primero que dice el mensaje es eso, antes que cualquier instrucción.
    if (/suspend/i.test(texto)) {
        return 'Tus propiedades NO se borraron: siguen guardadas. Lo que pasa es que el ' +
            'almacenamiento (Vercel Blob) está suspendido, así que la app no puede leerlas. ' +
            'Entrá a Vercel → Storage → tu Blob store y reactivalo; suele suspenderse por ' +
            'pasarse del límite del plan gratis. En cuanto vuelva, todo aparece como estaba.';
    }
    if (/quota|limit exceeded|payment|billing/i.test(texto)) {
        return 'El almacenamiento (Vercel Blob) rechazó la operación por límites de la cuenta. ' +
            'Tus propiedades no se borraron. Revisá el plan del store en Vercel → Storage.';
    }
    return null;
}

async function withBlob(fn) {
    try {
        return await fn(await blob());
    } catch (e) {
        const explicado = explicarFalloBlob(e.message);
        if (explicado) throw Object.assign(new Error(explicado), { status: 503 });
        throw e;
    }
}

// Un store recién creado todavía no tiene nada adentro. Eso no es una falla, y hay que poder
// distinguirlo de un store que no contesta: son la misma cara —no hay datos— con consecuencias
// opuestas. Uno es normal el primer día; el otro es que no se pueden leer las propiedades.
export const VACIO = 'blob-vacio';

// La base pública del store es fija; la aprendemos una vez y después armamos las URLs solos.
let base = null;
async function baseUrl() {
    if (base) return base;
    const { blobs } = await withBlob(({ list }) => list({ limit: 1 }));
    if (blobs[0]) base = new URL(blobs[0].url).origin;
    if (!base) throw Object.assign(new Error('El Blob Store está vacío todavía.'), { code: VACIO });
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
    const res = await withBlob(({ put: blobPut }) => blobPut(key, buf, {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType
    }));
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

/**
 * Qué significa lo que contestó el almacenamiento. La regla es una sola y es la que importa:
 * un archivo que no está devuelve null, pero un archivo que no se pudo leer tiene que explotar.
 * Confundir las dos cosas fue el peor bug que tuvo esto: con el store suspendido, cada
 * propiedad se leía como "no está", el listado quedaba vacío y la app le decía al dueño que no
 * tenía ninguna propiedad. Nada se había borrado, pero eso no había forma de saberlo.
 * @param {number} estado - El código HTTP que devolvió el almacenamiento.
 * @returns {'ok'|'no-esta'|'falla'} Qué hacer con esa respuesta.
 */
export function interpretar(estado) {
    if (estado >= 200 && estado < 300) return 'ok';
    if (estado === 404 || estado === 410) return 'no-esta';
    return 'falla';
}

export async function readJson(key) {
    if (!isBlob) {
        const texto = await fs.readFile(guard(key), 'utf8').catch((e) => {
            if (e.code === 'ENOENT') return null;
            throw e;
        });
        return texto === null ? null : JSON.parse(texto);
    }
    let raiz;
    try {
        raiz = await baseUrl();
    } catch (e) {
        // Store vacío: todavía no hay nada guardado, y eso sí es un "no está".
        if (e.code === VACIO) return null;
        throw e;
    }
    // El query rompe la caché del CDN: después de guardar queremos leer lo recién escrito.
    const res = await fetch(`${raiz}/${key}?v=${Date.now()}`, { cache: 'no-store' });
    const que = interpretar(res.status);
    if (que === 'no-esta') return null;
    if (que === 'falla') {
        throw Object.assign(new Error(`No pude leer ${key} del almacenamiento (HTTP ${res.status}). ` +
            'Tus propiedades no se borraron; el almacenamiento no está contestando.'), { status: 503 });
    }
    return res.json();
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
    const res = await withBlob(({ list }) => list({ mode: 'folded' }));
    base ??= res.blobs[0] && new URL(res.blobs[0].url).origin;
    return (res.folders ?? []).map(f => f.replace(/\/$/, ''));
}

export async function remove(prefix) {
    if (!isBlob) {
        await fs.rm(guard(prefix), { recursive: true, force: true });
        return;
    }
    const { blobs } = await withBlob(({ list }) => list({ prefix }));
    if (blobs.length) await withBlob(({ del }) => del(blobs.map(b => b.url)));
}

export async function ensure() {
    // En serverless sin Blob no hay dónde escribir: mejor el mensaje con la solución
    // que un ENOENT del filesystem de sólo lectura.
    assertWritable();
    if (!isBlob) await fs.mkdir(DATA_DIR, { recursive: true });
}
