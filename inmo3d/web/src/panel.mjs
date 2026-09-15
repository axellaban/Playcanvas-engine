// Panel: alta de propiedades, carga de fotos, reconstrucción 3D y las herramientas de IA.
import { h, $, api, toast, busy, money, copy } from './ui.mjs';

const view = $('#view');
let CFG = { ai: { text: false, image: false } };

const media = (id, file) => `/media/${id}/${file}`;

// ---------------------------------------------------------------- listado

async function renderList() {
    const props = await api('/properties');
    view.replaceChildren(
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '16px' } },
            h('h1', {}, 'Propiedades'),
            h('small.dim', {}, `${props.length} en el sistema`)),
        props.length ? h('div.grid.props', {}, props.map(card)) :
            h('div.card', { style: { textAlign: 'center', padding: '48px' } },
                h('h2', {}, 'Todavía no hay ninguna propiedad'),
                h('p.dim', {}, 'Creá una, subí entre 80 y 200 fotos de la casa y armá el tour 3D.'),
                h('button.btn.primary', { onclick: newProperty }, 'Crear la primera'))
    );
}

function card(p) {
    const cover = p.cover ? media(p.id, p.cover) : null;
    return h('article.card', { style: { padding: '12px', cursor: 'pointer' }, onclick: () => go(`#/p/${p.id}`) },
        h('div.thumb', { style: cover ? { backgroundImage: `url(${cover})` } : {} }, cover ? '' : 'sin fotos'),
        h('h3', { style: { margin: '12px 0 2px' } }, p.meta.title),
        h('small.dim', {}, [p.meta.address, p.meta.city].filter(Boolean).join(', ') || 'sin dirección'),
        h('div', { style: { margin: '10px 0 8px', fontWeight: '700' } }, money(p.meta.price, p.meta.currency)),
        h('div.chips', {},
            h('span.chip', {}, `${p.photos} fotos`),
            p.hasSplat ? h('span.chip.ok', {}, '3D listo') :
                p.job?.status === 'running' ? h('span.chip.warn', {}, `reconstruyendo: ${p.job.step}`) :
                    h('span.chip', {}, 'sin 3D')));
}

async function newProperty() {
    const title = prompt('Nombre de la propiedad', 'Casa en Palermo');
    if (!title) return;
    const p = await api('/properties', { method: 'POST', body: { meta: { title } } });
    go(`#/p/${p.id}`);
}

// ---------------------------------------------------------------- detalle

async function renderDetail(id) {
    const prop = await api(`/properties/${id}`);
    const save = async (patch) => {
        Object.assign(prop, await api(`/properties/${id}`, { method: 'PATCH', body: patch }));
    };

    view.replaceChildren(
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' } },
            h('button.btn.ghost.sm', { onclick: () => go('#/') }, '← Propiedades'),
            h('h1', { style: { margin: 0, flex: '1' } }, prop.meta.title),
            prop.scene.splat && h('a.btn.primary', { href: `/tour.html?id=${id}`, target: '_blank' }, '▶ Abrir tour 3D'),
            h('button.btn.ghost.sm', {
                onclick: async () => {
                    if (confirm('¿Borrar la propiedad y todos sus archivos?')) {
                        await api(`/properties/${id}`, { method: 'DELETE' });
                        go('#/');
                    }
                }
            }, 'Borrar')),
        h('div.grid.two', {},
            h('div.grid', {}, sectionPhotos(prop, save), sectionScene(prop), sectionShare(prop)),
            h('div.grid', {}, sectionFicha(prop, save), sectionAI(prop, save)))
    );
}

// ---- ficha

function field(label, key, meta, save, opts = {}) {
    const el = h(opts.options ? 'select' : 'input', {
        value: meta[key] ?? '',
        ...(opts.options ? {} : { type: opts.type || 'text' }),
        onchange: () => {
            const v = opts.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
            save({ meta: { [key]: v } });
        }
    }, opts.options?.map(o => h('option', { value: o, selected: meta[key] === o }, o)));
    return h('div', {}, h('label', {}, label), el);
}

function sectionFicha(prop, save) {
    const m = prop.meta;
    return h('div.card', {},
        h('h2', {}, 'Ficha'),
        field('Título', 'title', m, save),
        h('div.row', {}, field('Dirección', 'address', m, save), field('Ciudad', 'city', m, save)),
        h('div.row3', {},
            field('Operación', 'operation', m, save, { options: ['venta', 'alquiler'] }),
            field('Tipo', 'type', m, save, { options: ['casa', 'departamento', 'ph', 'local', 'terreno'] }),
            field('Moneda', 'currency', m, save, { options: ['USD', 'ARS', 'EUR'] })),
        h('div.row3', {},
            field('Precio', 'price', m, save, { type: 'number' }),
            field('Expensas', 'expenses', m, save, { type: 'number' }),
            field('Año', 'year', m, save, { type: 'number' })),
        h('div.row3', {},
            field('Dormitorios', 'bedrooms', m, save, { type: 'number' }),
            field('Baños', 'bathrooms', m, save, { type: 'number' }),
            field('Cocheras', 'garage', m, save, { type: 'number' })),
        h('div.row', {},
            field('m² cubiertos', 'areaCovered', m, save, { type: 'number' }),
            field('m² totales', 'areaTotal', m, save, { type: 'number' })),
        h('label', {}, 'Notas para la IA (lo que no se ve en las fotos)'),
        h('textarea', {
            rows: 3,
            value: m.notes || '',
            onchange: e => save({ meta: { notes: e.target.value } })
        }));
}

// ---- fotos

function sectionPhotos(prop, save) {
    const grid = h('div.photos', {}, prop.photos.map(p => h('figure', {},
        h('img', { src: media(prop.id, `photos/${p.file}`), loading: 'lazy' }),
        h('button', {
            title: 'Quitar',
            onclick: async (e) => {
                e.target.closest('figure').remove();
                await api(`/properties/${prop.id}/photos/${p.file}`, { method: 'DELETE' });
            }
        }, '✕'))));

    const count = h('small.dim', {}, `${prop.photos.length} fotos`);
    const drop = h('div.drop', {},
        h('div', { style: { fontSize: '1.6rem' } }, '📷'),
        h('div', {}, h('b', {}, 'Arrastrá las fotos acá')),
        h('label.btn.sm', { style: { display: 'inline-flex', margin: '8px' } }, 'o elegir archivos',
            h('input', {
                type: 'file',
                multiple: true,
                accept: 'image/*',
                style: { display: 'none' },
                onchange: e => upload([...e.target.files])
            })),
        h('div', {}, h('small', {}, 'Lo ideal: 80-200 fotos, con 60-80% de solape entre tomas.')));

    drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        upload([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
    });

    async function upload(files) {
        if (!files.length) return;
        let done = 0;
        for (const file of files) {
            drop.style.opacity = 0.6;
            count.textContent = `subiendo ${++done}/${files.length}…`;
            const up = await api(`/properties/${prop.id}/photos?name=${encodeURIComponent(file.name)}`,
                { method: 'POST', raw: file, headers: { 'content-type': file.type } });
            prop.photos.push(up);
            grid.append(h('figure', {}, h('img', { src: media(prop.id, `photos/${up.file}`) })));
        }
        drop.style.opacity = 1;
        count.textContent = `${prop.photos.length} fotos`;
        toast(`${files.length} foto(s) subidas.`);
    }

    return h('div.card', {},
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('h2', { style: { margin: 0, flex: 1 } }, 'Fotos'), count),
        h('div', { style: { height: '10px' } }), drop, grid);
}

// ---- escena 3D

function sectionScene(prop) {
    const bar = h('i', { style: { width: `${prop.job?.progress || 0}%` } });
    const status = h('div.dim', { style: { fontSize: '.82rem', margin: '8px 0' } });
    const log = h('pre.log.hide');
    const opts = {
        sfm: h('select', {}, ['glomap', 'colmap'].map(o => h('option', {}, o))),
        trainer: h('select', {}, ['brush', 'opensplat', 'nerfstudio'].map(o => h('option', {}, o))),
        steps: h('input', { type: 'number', value: 15000, step: 1000 })
    };

    const paint = (job, running, text) => {
        bar.style.width = `${job?.progress || 0}%`;
        status.textContent = !job ? 'Todavía no se reconstruyó.' :
            job.status === 'running' || running ? `Reconstruyendo — etapa: ${job.step}` :
                job.status === 'error' ? `Falló: ${job.error}` : 'Listo: el tour 3D está disponible.';
        if (text) {
            log.textContent = text;
            log.classList.remove('hide');
            log.scrollTop = log.scrollHeight;
        }
    };
    paint(prop.job, false);

    let timer;
    async function poll() {
        const { job, running, log: text } = await api(`/properties/${prop.id}/job`);
        paint(job, running, text);
        if (running) {
            timer = setTimeout(poll, 2500);
        } else {
            clearTimeout(timer);
            if (job?.status === 'done') {
                toast('¡Reconstrucción lista! Abrí el tour.');
                setTimeout(() => location.reload(), 900);
            }
        }
    }
    if (prop.job?.status === 'running') poll();

    const run = h('button.btn.primary', {});
    run.textContent = '🧱 Reconstruir en 3D';
    run.onclick = busy(run, async () => {
        await api(`/properties/${prop.id}/reconstruct`, {
            method: 'POST',
            body: { sfm: opts.sfm.value, trainer: opts.trainer.value, steps: Number(opts.steps.value) }
        });
        toast('Arrancó la reconstrucción. Puede tardar de minutos a horas.');
        poll();
    });

    const up = h('input', {
        type: 'file',
        accept: '.sog,.ply,.spz',
        style: { display: 'none' },
        onchange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            toast(`Subiendo ${file.name}…`);
            await api(`/properties/${prop.id}/splat?name=${encodeURIComponent(file.name)}`,
                { method: 'POST', raw: file });
            toast('Splat cargado.');
            location.reload();
        }
    });

    return h('div.card', {},
        h('h2', {}, 'Escena 3D'),
        h('p.dim', { style: { marginTop: 0, fontSize: '.85rem' } },
            'Las fotos se convierten en una nube de Gaussians con COLMAP + un entrenador 3DGS, y se comprimen a ',
            h('code.mono', {}, '.sog'), ', el formato que este motor carga con streaming y LOD.'),
        h('div.row3', {},
            h('div', {}, h('label', {}, 'SfM'), opts.sfm),
            h('div', {}, h('label', {}, 'Entrenador'), opts.trainer),
            h('div', {}, h('label', {}, 'Pasos'), opts.steps)),
        h('div', { style: { display: 'flex', gap: '8px', margin: '14px 0 10px', flexWrap: 'wrap' } },
            run,
            h('button.btn', { onclick: () => up.click() }, '⬆ Subir splat ya entrenado'), up,
            prop.scene.splat && h('a.btn.ghost', { href: media(prop.id, prop.scene.splat), download: true },
                `Descargar ${prop.scene.splat.slice(prop.scene.splat.lastIndexOf('.'))}`)),
        h('div.bar', {}, bar), status, log);
}

// ---- IA

function sectionAI(prop, save) {
    const out = h('div');
    const paint = () => out.replaceChildren(
        prop.ai.audit && block('Auditoría de captura', auditView(prop.ai.audit)),
        prop.ai.rooms && block('Ambientes y guion', roomsView(prop, save)),
        prop.ai.listing && block('Aviso', listingView(prop.ai.listing)));

    const btn = (label, path, after) => {
        const b = h('button.btn', { disabled: !CFG.ai.text });
        b.textContent = label;
        b.onclick = busy(b, async () => {
            const res = await api(`/properties/${prop.id}/ai/${path}`, { method: 'POST', body: {} });
            after(res);
            paint();
            toast('Listo.');
        });
        return b;
    };

    paint();
    return h('div.card', {},
        h('h2', {}, '🤖 IA generativa'),
        !CFG.ai.text && h('p.chip.warn', {}, 'Falta ANTHROPIC_API_KEY: cargala en inmo3d/.env'),
        h('p.dim', { style: { marginTop: '4px', fontSize: '.85rem' } },
            'Mira las fotos y devuelve trabajo terminado: qué falta fotografiar, cómo se llama cada ambiente y el aviso listo para publicar.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '10px 0' } },
            btn('🔍 Auditar captura', 'audit', r => (prop.ai.audit = r)),
            btn('🚪 Detectar ambientes', 'rooms', r => (prop.ai.rooms = r)),
            btn('✍️ Escribir aviso', 'listing', r => (prop.ai.listing = r))),
        out);
}

const block = (title, body) => h('details', { open: true, style: { marginTop: '12px' } },
    h('summary', { style: { cursor: 'pointer', fontWeight: '700', margin: '6px 0' } }, title), body);

function auditView(a) {
    const score = a.puntaje ?? 0;
    return h('div', {},
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', {
                style: {
                    fontSize: '1.7rem',
                    fontWeight: '800',
                    color: score > 70 ? 'var(--accent2)' : score > 45 ? 'var(--warn)' : '#ff5b5b'
                }
            }, String(score)),
            h('div', {}, h('b', {}, a.veredicto || ''),
                h('div.chips', { style: { marginTop: '4px' } },
                    h('span', { class: `chip ${a.listoParaReconstruir ? 'ok' : 'warn'}` },
                        a.listoParaReconstruir ? 'listo para reconstruir' : 'conviene sacar más fotos'),
                    a.cobertura?.solapeEstimado && h('span.chip', {}, `solape ${a.cobertura.solapeEstimado}`)))),
        a.cobertura?.ambientesDetectados?.length && h('div', {},
            h('label', {}, 'Ambientes detectados'),
            h('div.chips', {}, a.cobertura.ambientesDetectados.map(r => h('span.chip', {}, r)))),
        a.cobertura?.faltantes?.length && h('div', {},
            h('label', {}, 'Falta cubrir'),
            h('div.chips', {}, a.cobertura.faltantes.map(r => h('span.chip.warn', {}, r)))),
        a.tomasQueFaltan?.length && h('div', {}, h('label', {}, 'Tomas que faltan'),
            h('ul', { style: { margin: '0', paddingLeft: '18px', fontSize: '.86rem' } },
                a.tomasQueFaltan.map(t => h('li', {}, t)))),
        a.problemas?.length && h('div', {}, h('label', {}, 'Problemas detectados'),
            h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '.86rem' } },
                a.problemas.map(p => h('li', {}, h('b', {}, `${p.foto}: `), `${p.problema} → ${p.solucion}`)))));
}

function roomsView(prop, save) {
    const rooms = prop.ai.rooms?.ambientes ?? [];
    const seed = h('button.btn.sm', {
        onclick: async () => {
            const order = prop.ai.rooms.ordenDelTour?.length ? prop.ai.rooms.ordenDelTour : rooms.map(r => r.nombre);
            const tour = order.map((name, i) => {
                const r = rooms.find(x => x.nombre === name) ?? { nombre: name };
                return { id: `wp${i}`, name, desc: r.texto || '', pos: null, look: null };
            });
            await save({ tour });
            toast('Paradas creadas. Ubicalas en el visor con "Ubicar paradas".');
        }
    }, '➕ Convertir en paradas del tour');

    return h('div', {},
        prop.ai.rooms.guion && h('p', { style: { fontSize: '.88rem' } }, prop.ai.rooms.guion),
        h('div.chips', {}, rooms.map(r => h('span.chip.hot', {}, `${r.nombre}${r.m2Estimados ? ` · ${r.m2Estimados} m²` : ''}`))),
        h('div', { style: { marginTop: '10px' } }, seed));
}

function listingView(l) {
    const txt = [l.titulo, '', l.bajada, '', l.descripcion, '',
        ...(l.destacados || []).map(d => `• ${d}`)].join('\n');
    return h('div', {},
        h('h3', {}, l.titulo),
        h('p', { style: { fontStyle: 'italic', color: 'var(--dim)' } }, l.bajada),
        h('p', { style: { whiteSpace: 'pre-wrap', fontSize: '.88rem' } }, l.descripcion),
        l.destacados?.length && h('ul', { style: { fontSize: '.86rem', paddingLeft: '18px' } },
            l.destacados.map(d => h('li', {}, d))),
        l.advertencias?.length && h('div', {}, h('label', {}, 'A verificar antes de publicar'),
            h('div.chips', {}, l.advertencias.map(a => h('span.chip.warn', {}, a)))),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } },
            h('button.btn.sm', { onclick: () => copy(txt, 'Aviso') }, 'Copiar aviso'),
            l.whatsapp && h('button.btn.sm', { onclick: () => copy(l.whatsapp, 'Mensaje') }, 'Copiar WhatsApp'),
            l.instagram && h('button.btn.sm', { onclick: () => copy(l.instagram, 'Caption') }, 'Copiar Instagram'),
            l.seo?.length && h('button.btn.sm', { onclick: () => copy(l.seo.join(', '), 'SEO') }, 'Copiar SEO')));
}

// ---- compartir

function sectionShare(prop) {
    const url = `${location.origin}/tour.html?id=${prop.id}`;
    const embed = `<iframe src="${url}&ui=min" width="100%" height="560" style="border:0;border-radius:14px" allow="xr-spatial-tracking; fullscreen"></iframe>`;
    return h('div.card', {},
        h('h2', {}, 'Compartir'),
        h('label', {}, 'Link del tour'),
        h('div', { style: { display: 'flex', gap: '6px' } },
            h('input', { value: url, readonly: true }),
            h('button.btn.sm', { onclick: () => copy(url, 'Link') }, 'Copiar')),
        h('label', {}, 'Embeber en el portal / la web de la inmobiliaria'),
        h('div', { style: { display: 'flex', gap: '6px' } },
            h('input.mono', { value: embed, readonly: true }),
            h('button.btn.sm', { onclick: () => copy(embed, 'Embed') }, 'Copiar')));
}

// ---------------------------------------------------------------- router

const go = (hash) => {
    location.hash = hash;
};

async function route() {
    view.replaceChildren(h('div.card', {}, h('span.spin'), ' cargando…'));
    try {
        const m = location.hash.match(/^#\/p\/(.+)$/);
        await (m ? renderDetail(m[1]) : renderList());
    } catch (e) {
        view.replaceChildren(h('div.card', {}, h('h2', {}, 'Ups'), h('p', {}, e.message),
            h('button.btn', { onclick: () => go('#/') }, 'Volver')));
    }
}

window.addEventListener('hashchange', route);
$('#new-prop').onclick = newProperty;

CFG = await api('/config');
$('#ai-state').textContent = CFG.ai.text ?
    `IA: ${CFG.ai.textModel}${CFG.ai.image ? ` + ${CFG.ai.imageProvider}` : ''}` : 'IA sin configurar';
$('#ai-state').className = CFG.ai.text ? 'chip ok' : 'chip warn';
route();
