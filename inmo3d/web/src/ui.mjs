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
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
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
