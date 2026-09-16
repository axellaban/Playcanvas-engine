// Utilidades mínimas de DOM y de API. Sin framework: la app es chica y así carga instantáneo.
export function h(tag, props = {}, ...kids) {
    const [name, ...cls] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (cls.length) el.className = cls.join(' ');
    for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className += ` ${v}`;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k in el && k !== 'list') {
            // Algunas propiedades son sólo de lectura según el elemento (select.type, por ejemplo).
            try {
                el[k] = v;
            } catch {
                el.setAttribute(k, v);
            }
        } else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(3)) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const res = await fetch(`/api${path}`, {
        method,
        headers: raw ? headers : { 'content-type': 'application/json', ...headers },
        body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`La API respondió HTTP ${res.status} sin JSON en /api${path}. Revisá el despliegue del servidor.`);
    }
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
    return data;
}

let toastEl;
export function toast(msg, bad = false, ms = 4200) {
    toastEl?.remove();
    toastEl = h('div.toast', { class: bad ? 'bad' : '' }, msg);
    document.body.append(toastEl);
    setTimeout(() => toastEl?.remove(), ms);
}

/**
 * Envuelve una acción async: deshabilita el botón, muestra spinner y reporta el error.
 * @param btn
 * @param fn
 */
export function busy(btn, fn) {
    return async (...args) => {
        const label = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> trabajando…';
        try {
            return await fn(...args);
        } catch (e) {
            toast(e.message, true, 8000);
        } finally {
            btn.disabled = false;
            btn.innerHTML = label;
        }
    };
}

export const money = (n, cur = 'USD') => (n === null || n === undefined || n === '' ? '—' :
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n));

export const copy = async (text, what = 'Texto') => {
    await navigator.clipboard.writeText(text);
    toast(`${what} copiado al portapapeles.`);
};

let _cfg;
/** La configuración del servidor (qué IA hay, qué almacenamiento, si puede reconstruir). */
export async function config(refresh = false) {
    if (refresh) _cfg = null;
    _cfg ??= await api('/config');
    return _cfg;
}

const safeName = name => name.normalize('NFD').replace(/\p{Diacritic}/gu, '')
.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Achica la foto antes de subirla. No es sólo por el peso: al modelo de visión le llegan
 * mejor 1800 px que 12 MP, y cuesta bastante menos.
 */
async function decode(file) {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (bmp) return bmp;
    // Safari resuelve por <img> algunos formatos que createImageBitmap rechaza.
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    } catch {
        return null;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
}

export async function downscale(file, max = 1800, quality = 0.84) {
    if (!file.type.startsWith('image/')) return file;
    const bmp = await decode(file);
    if (!bmp) return file;
    const w = bmp.width || bmp.naturalWidth, hgt = bmp.height || bmp.naturalHeight;
    const k = Math.min(1, max / Math.max(w, hgt));
    // Un HEIC chico igual se convierte: el servidor y el modelo sólo entienden jpg/png/webp.
    const raro = !/^image\/(?:jpeg|png|webp)$/.test(file.type);
    if (k === 1 && file.size < 2.5e6 && !raro) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(hgt * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', quality);
    });
    if (!blob) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
}

/**
 * Sube un archivo. Con Vercel Blob va directo del navegador al storage (así no choca
 * contra el límite de 4,5 MB por request de las funciones); local pasa por el servidor.
 */
export async function putFile(id, kind, file, name = file.name, register = true) {
    const cfg = await config();
    const clean = safeName(name);
    // Sin token read-write no se puede subir directo: el archivo pasa por la función,
    // que aguanta hasta 4,5 MB. Para un splat grande queda la opción de enlazarlo por URL.
    if (cfg.storage === 'blob' && cfg.clientUpload) {
        let upload;
        try {
            ({ upload } = await import('@vercel/blob/client'));
        } catch {
            throw new Error('No pude cargar el cliente de Vercel Blob. Si es un splat, pegá su URL pública.');
        }
        const folder = kind === 'splat' ? 'splat' : 'photos';
        const blob = await upload(`${id}/${folder}/${clean}`, file, {
            access: 'public',
            handleUploadUrl: '/api/blob/upload',
            contentType: file.type || 'application/octet-stream'
        });
        if (register) {
            await api(`/properties/${id}/attach`, {
                method: 'POST', body: { kind, url: blob.url, file: clean, bytes: file.size }
            });
        }
        return { file: clean, url: blob.url, bytes: file.size };
    }
    const route = kind === 'splat' ? 'splat' : 'photos';
    const skip = !register && kind !== 'splat' ? '&register=0' : '';
    return api(`/properties/${id}/${route}?name=${encodeURIComponent(clean)}${skip}`, {
        method: 'POST', raw: file, headers: { 'content-type': file.type || 'application/octet-stream' }
    });
}
