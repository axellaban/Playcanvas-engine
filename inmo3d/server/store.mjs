// Almacenamiento en disco. Una propiedad = una carpeta con su JSON, sus fotos,
// su splat y lo que genere la IA. Sin base de datos: todo es portable y copiable.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const DATA_DIR = process.env.INMO3D_DATA ?
    path.resolve(process.env.INMO3D_DATA) : path.join(ROOT, 'data');

export const propDir = id => path.join(DATA_DIR, id);
const propFile = id => path.join(propDir(id), 'property.json');

/**
 * Slug seguro para usar como id o nombre de archivo.
 * @param s
 * @param fallback
 */
export const slug = (s, fallback = 'item') => {
    const out = String(s ?? '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return out || fallback;
};

const defaults = (id, meta = {}) => ({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: {
        title: 'Propiedad sin título',
        address: '',
        city: '',
        operation: 'venta',        // venta | alquiler
        type: 'casa',              // casa | departamento | ph | local | terreno
        price: null,
        currency: 'USD',
        expenses: null,
        bedrooms: null,
        bathrooms: null,
        garage: null,
        areaCovered: null,         // m2 cubiertos
        areaTotal: null,           // m2 totales
        year: null,
        language: 'es',
        notes: '',
        ...meta
    },
    photos: [],                    // { file, bytes, addedAt }
    scene: {
        splat: null,               // ruta relativa dentro de la carpeta de la propiedad
        yaw: 0,                    // grados, para enderezar la nube
        pitch: 0,
        roll: 0,
        scale: 1,
        floorY: null,              // altura del piso (se fija con un click en el visor)
        eyeHeight: 1.62,           // altura de los ojos al caminar
        exposure: 1,
        autoRotate: false
    },
    tour: [],                      // { id, name, desc, pos:[x,y,z], look:[x,y,z] }
    hotspots: [],                  // { id, title, body, pos:[x,y,z] }
    measures: [],                  // { id, label, a:[x,y,z], b:[x,y,z], meters }
    ai: { audit: null, listing: null, rooms: null, staged: [] },
    job: null                      // { id, status, step, progress, log, error, startedAt, finishedAt }
});

export async function ensureData() {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function listProperties() {
    await ensureData();
    const ids = await fs.readdir(DATA_DIR).catch(() => []);
    const out = [];
    for (const id of ids) {
        const p = await getProperty(id);
        if (p) {
            out.push({
                id: p.id,
                meta: p.meta,
                photos: p.photos.length,
                hasSplat: !!p.scene.splat,
                job: p.job && { status: p.job.status, step: p.job.step },
                cover: p.ai?.staged?.[0]?.file ?? p.photos[0]?.file ?? null,
                updatedAt: p.updatedAt
            });
        }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getProperty(id) {
    try {
        return JSON.parse(await fs.readFile(propFile(id), 'utf8'));
    } catch {
        return null;
    }
}

export async function saveProperty(prop) {
    prop.updatedAt = new Date().toISOString();
    await fs.mkdir(propDir(prop.id), { recursive: true });
    await fs.writeFile(propFile(prop.id), JSON.stringify(prop, null, 2));
    return prop;
}

export async function createProperty(meta = {}) {
    await ensureData();
    const base = slug(meta.title || meta.address, 'propiedad');
    let id = base;
    for (let i = 2; await getProperty(id); i++) id = `${base}-${i}`;
    const prop = defaults(id, meta);
    await fs.mkdir(path.join(propDir(id), 'photos'), { recursive: true });
    await fs.mkdir(path.join(propDir(id), 'splat'), { recursive: true });
    await fs.mkdir(path.join(propDir(id), 'staged'), { recursive: true });
    return saveProperty(prop);
}

/**
 * Merge superficial por sección: el cliente manda sólo lo que cambió.
 * @param id
 * @param patch
 */
export async function patchProperty(id, patch) {
    const prop = await getProperty(id);
    if (!prop) return null;
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'id' || k === 'createdAt') continue;
        if (v && !Array.isArray(v) && typeof v === 'object' && prop[k] && typeof prop[k] === 'object') {
            Object.assign(prop[k], v);
        } else {
            prop[k] = v;
        }
    }
    return saveProperty(prop);
}

export async function deleteProperty(id) {
    if (!await getProperty(id)) return false;
    await fs.rm(propDir(id), { recursive: true, force: true });
    return true;
}
