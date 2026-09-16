// El modelo de datos. Una propiedad = una carpeta (local o en el Blob) con su property.json,
// sus fotos, su splat y lo que generó la IA. Sin base de datos: todo es portable y copiable.
import * as storage from './storage.mjs';

export { DATA_DIR, ROOT, driver, isBlob, onVercel } from './storage.mjs';

const KEY = id => `${id}/property.json`;

/** Slug seguro para usar como id o nombre de archivo. */
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
    photos: [],                    // { file, url, bytes, addedAt }
    video: null,                   // { file, url, bytes } — alternativa a las fotos
    scene: {
        splat: null,               // clave del archivo
        splatUrl: null,            // URL con la que lo pide el visor
        yaw: 0,                    // grados, para enderezar la nube
        pitch: 0,
        roll: 0,
        scale: 1,
        floorY: null,              // altura del piso (se fija con un click en el visor)
        eyeHeight: 1.62,           // altura de los ojos al caminar
        metersPerUnit: 1,          // calibración métrica
        exposure: 1,
        autoRotate: false
    },
    tour: [],                      // { id, name, desc, pos:[x,y,z], look:[x,y,z] }
    hotspots: [],                  // { id, title, body, pos:[x,y,z] }
    measures: [],                  // { id, label, a:[x,y,z], b:[x,y,z], meters }
    ai: { audit: null, listing: null, rooms: null, staged: [] },
    job: null                      // { id, status, step, progress, error, startedAt, finishedAt }
});

export const ensureData = () => storage.ensure();

export const getProperty = id => storage.readJson(KEY(id));

export async function saveProperty(prop) {
    prop.updatedAt = new Date().toISOString();
    await storage.writeJson(KEY(prop.id), prop);
    return prop;
}

export async function listProperties() {
    await storage.ensure();
    const ids = await storage.folders();
    const props = await Promise.all(ids.map(getProperty));
    return props.filter(Boolean).map(p => ({
        id: p.id,
        meta: p.meta,
        photos: p.photos.length,
        hasSplat: !!p.scene.splatUrl,
        job: p.job && { status: p.job.status, step: p.job.step },
        cover: p.ai?.staged?.[0]?.url ?? p.photos[0]?.url ?? null,
        updatedAt: p.updatedAt
    })).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createProperty(meta = {}) {
    storage.assertWritable();
    const base = slug(meta.title || meta.address, 'propiedad');
    let id = base;
    for (let i = 2; await getProperty(id); i++) id = `${base}-${i}`;
    return saveProperty(defaults(id, meta));
}

/** Merge superficial por sección: el cliente manda sólo lo que cambió. */
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
    await storage.remove(`${id}/`);
    return true;
}

/** Guarda un archivo dentro de la carpeta de la propiedad y devuelve { key, url, bytes }. */
export function putMedia(id, folder, name, data, contentType) {
    const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.bin').toLowerCase();
    const file = `${slug(name.replace(/\.[^.]+$/, ''), Date.now().toString(36))}${ext}`;
    return storage.put(`${id}/${folder}/${file}`, data, contentType).then(r => ({ ...r, file }));
}

export const getMedia = urlOrKey => storage.get(urlOrKey);
