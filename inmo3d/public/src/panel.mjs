// Panel: alta de propiedades, carga de fotos, reconstrucción 3D y las herramientas de IA.
import { h, $, api, toast, busy, money, copy, config, putFile, downscale } from './ui.mjs';

const view = $('#view');
let CFG = { ai: { text: false, image: false }, storage: 'fs', canReconstruct: true };

// ---------------------------------------------------------------- listado

/**
 * Abre un departamento real escaneado, servido por la propia app. Sirve para dos cosas: ver
 * cómo se siente un recorrido terminado antes de tener el propio, y mostrárselo a un cliente
 * sin depender de que haya una reconstrucción lista. Va en una propiedad aparte para no
 * pisarle la escena a ninguna de verdad.
 */
async function verEjemplo(props) {
    if (!CFG.auth?.authenticated) return toast('Iniciá sesión para ver el ejemplo.', true);
    const ya = props.find(p => p.meta.title.startsWith('Ejemplo'));
    const prop = ya || await api('/properties', {
        method: 'POST', body: { meta: { title: 'Ejemplo: departamento escaneado' } }
    });
    await api(`/properties/${prop.id}/attach`, {
        method: 'POST',
        body: { kind: 'splat', url: `${location.origin}/ejemplo/departamento.sog` }
    });
    location.href = `/tour.html?id=${prop.id}`;
}

async function renderList() {
    const props = await api('/properties');
    const ejemplo = h('button.btn.sm', {});
    ejemplo.textContent = '👀 Ver un ejemplo';
    ejemplo.onclick = busy(ejemplo, () => verEjemplo(props).catch(e => toast(e.message, true)));
    view.replaceChildren(
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '16px' } },
            h('h1', {}, 'Propiedades'),
            h('small.dim', {}, `${props.length} en el sistema`),
            h('span', { style: { marginLeft: 'auto' } }, ejemplo)),
        props.length ? h('div.grid.props', {}, props.map(card)) :
            h('div.card', { style: { textAlign: 'center', padding: '44px 24px' } },
                h('div', { style: { fontSize: '2.6rem', lineHeight: 1 } }, '🏡'),
                h('h2', { style: { marginTop: '14px' } }, 'Tu primera propiedad'),
                h('p.dim', { style: { maxWidth: '46ch', margin: '0 auto 18px' } },
                    'El camino es: cargás la ficha, sacás entre 80 y 200 fotos de la casa, ' +
                    'la IA te dice si alcanzan, y sale el tour 3D para compartir por link.'),
                h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' } },
                    h('button.btn.primary', { onclick: () => newProperty().catch(e => toast(e.message, true)) },
                        'Crear la primera'),
                    h('button.btn', { onclick: () => verEjemplo([]).catch(e => toast(e.message, true)) },
                        '👀 Ver un ejemplo terminado')))
    );
}

function card(p) {
    const cover = p.cover;
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
    if (!CFG.auth?.authenticated) return toast('Iniciá sesión para crear una propiedad.', true);
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
            prop.scene.splatUrl && h('a.btn.primary', { href: `/tour.html?id=${id}`, target: '_blank' }, '▶ Abrir tour 3D'),
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
        h('h2', {}, '📋 Ficha'),
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
        h('img', { src: p.url, loading: 'lazy' }),
        h('button', {
            title: 'Quitar',
            onclick: async (e) => {
                e.target.closest('figure').remove();
                await api(`/properties/${prop.id}/photos/${p.file}`, { method: 'DELETE' });
            }
        }, '✕'))));

    const count = h('small.dim', {}, `${prop.photos.length} fotos`);
    // Dos entradas distintas a propósito: el carrete es el camino real para 80-200
    // fotos (se sacan con la app de cámara, que tiene bloqueo de foco y exposición),
    // y la cámara directa sirve para sumar la toma que faltaba sin salir de acá.
    const fromCamera = h('input', {
        type: 'file',
        accept: 'image/*',
        capture: 'environment',
        style: { display: 'none' },
        onchange: e => upload([...e.target.files])
    });
    const fromGallery = h('input', {
        type: 'file',
        multiple: true,
        accept: 'image/*',
        style: { display: 'none' },
        onchange: e => upload([...e.target.files])
    });

    // El video es el camino cómodo: se graba caminando y el worker saca de ahí los
    // cuadros nítidos. Las fotos dan mejor resultado, pero cuestan más de sacar.
    const estadoVideo = h('div', { style: { fontSize: '.82rem', marginTop: '8px' } },
        prop.video ? h('span.chip.ok', {}, `🎬 video cargado (${(prop.video.bytes / 1e6).toFixed(0)} MB)`) : '');
    // Cuánto video aguanta este deploy. Con subida directa al Blob, 1 GB; si no, el
    // archivo pasa por la función y ahí manda el límite de Vercel.
    const topeMB = CFG.clientUpload ? 1000 : (CFG.vercel ? 4 : 60);

    const fromVideo = h('input', {
        type: 'file',
        accept: 'video/*',
        style: { display: 'none' },
        onchange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const mb = file.size / 1e6;
            if (mb > topeMB) {
                estadoVideo.replaceChildren(h('span.chip.warn', {},
                    `El video pesa ${mb.toFixed(0)} MB y el tope acá es ${topeMB} MB. ${
                        CFG.clientUpload ? 'Grabá menos tiempo o en 1080p.' :
                            'Falta BLOB_READ_WRITE_TOKEN para subir archivos grandes.'}`));
                return;
            }
            estadoVideo.replaceChildren(h('span.chip.warn', {}, `subiendo ${mb.toFixed(0)} MB…`));
            try {
                const up = await putFile(prop.id, 'video', file);
                prop.video = up;
                estadoVideo.replaceChildren(h('span.chip.ok', {}, `🎬 video cargado (${(up.bytes / 1e6).toFixed(0)} MB)`));
                // Subir el recorrido y pedir el 3D son el mismo gesto: nadie sube un video de
                // una casa para no reconstruirla. Se encola solo y la página vuelve mostrando
                // el avance, así el botón queda sólo para reintentar o para el camino de fotos.
                try {
                    await api(`/properties/${prop.id}/reconstruct`, { method: 'POST', body: {} });
                    toast('Video cargado. Ya estoy armando el 3D.');
                } catch (e) {
                    toast(e.message);
                }
                setTimeout(() => location.reload(), 1200);
            } catch (err) {
                estadoVideo.replaceChildren(h('span.chip.warn', {}, err.message));
            }
        }
    });

    const drop = h('div.drop', {},
        h('div', { style: { fontSize: '1.6rem' } }, '🎬'),
        h('div.drag-hint', {}, h('b', {}, 'Arrastrá las fotos acá')),
        h('div', {
            style: { display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap', margin: '10px 0' }
        },
        h('button.btn.sm.primary', { onclick: () => fromVideo.click() }, '🎬 Subir un video'),
        h('button.btn.sm', { onclick: () => fromGallery.click() }, '🖼 Elegir del carrete'),
        h('button.btn.sm', { onclick: () => fromCamera.click() }, '📷 Sacar una foto')),
        fromCamera, fromGallery, fromVideo,
        estadoVideo,
        h('details', { style: { marginTop: '10px', textAlign: 'left' } },
            h('summary', { style: { cursor: 'pointer', fontSize: '.84rem', fontWeight: '650' } },
                'Cómo grabar (leelo una vez)'),
            h('ul', { style: { fontSize: '.82rem', paddingLeft: '18px', margin: '8px 0 0', lineHeight: '1.7' } },
                h('li', {}, h('b', {}, '1080p, 30 fps.'), ' Grabar en 4K no mejora nada: los cuadros se ' +
                    'reducen a 1800 px igual, y el archivo pesa cuatro veces más. En iPhone: ' +
                    'Ajustes → Cámara → Grabar video → 1080p HD/30 fps.'),
                h('li', {}, h('b', {}, '1 a 2 minutos por ambiente.'), ' De ahí para arriba suma poco, y ' +
                    'tarda bastante más en subir y en procesarse.'),
                h('li', {}, h('b', {}, 'Caminá despacio'), ', sin giros bruscos, y no saques de cuadro de ' +
                    'golpe lo que venías mostrando: cada momento tiene que compartir buena parte con el ' +
                    'anterior. Así es como se enganchan entre sí para armar el 3D.'),
                h('li', {}, h('b', {}, 'Prendé todas las luces.'), ' Las paredes lisas y los rincones oscuros ' +
                    'no dan puntos de referencia, y son las partes que se quedan afuera del modelo.'),
                h('li', {}, h('b', {}, 'Bloqueá foco y exposición'), ' antes de empezar: mantené el dedo ' +
                    'sobre una pared hasta que diga AE/AF LOCK.'),
                h('li', {}, 'Recorré bordeando el ambiente apuntando al centro, y después desde el centro ' +
                    'hacia afuera.'),
                h('li', {}, h('b', {}, 'Pesa'), ` unos 60-90 MB por minuto en 1080p. Tope acá: ${topeMB} MB.`)),
            h('p.dim', { style: { fontSize: '.8rem', margin: '10px 0 0' } },
                'Con fotos el resultado es mejor —cada una es nítida a propósito y a plena resolución— ' +
                'pero son 80-200 tomas. El video es el camino cómodo.')));

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
        drop.style.opacity = 0.6;
        const failed = [];
        const subidas = [];
        const queue = [...files];

        // De a tres en paralelo: subir 150 fotos de a una desde el celular es eterno.
        // Si una falla se reintenta una vez y, si igual falla, seguimos con el resto:
        // en una red móvil no puede caerse toda la carga por una sola foto.
        const worker = async () => {
            while (queue.length) {
                const file = queue.shift();
                count.textContent = `subiendo ${++done}/${files.length}…`;
                try {
                    // Achicamos antes de subir: mejor para el modelo de visión y para el límite de request.
                    const small = await downscale(file);
                    let up;
                    try {
                        up = await putFile(prop.id, 'photo', small, file.name, false);
                    } catch {
                        up = await putFile(prop.id, 'photo', small, file.name, false);
                    }
                    subidas.push(up);
                    grid.append(h('figure', {}, h('img', { src: up.url, loading: 'lazy' })));
                } catch (e) {
                    failed.push(`${file.name}: ${e.message}`);
                }
            }
        };
        await Promise.all([worker(), worker(), worker()]);

        // Los bytes viajaron en paralelo; el registro va en una sola escritura al final.
        if (subidas.length) {
            await api(`/properties/${prop.id}/attach`, { method: 'POST', body: { photos: subidas } });
            prop.photos.push(...subidas);
        }

        drop.style.opacity = 1;
        count.textContent = `${prop.photos.length} fotos`;
        if (failed.length) {
            toast(`${files.length - failed.length} subidas, ${failed.length} fallaron. ${failed[0]}`, true, 10000);
        } else {
            toast(`Listo: ${prop.photos.length} fotos en total.`);
        }
    }

    return h('div.card', {},
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('h2', { style: { margin: 0, flex: 1 } }, '📷 Fotos'), count),
        h('div', { style: { height: '10px' } }), drop, grid);
}

// ---- escena 3D

function sectionScene(prop) {
    const bar = h('i', { style: { width: `${prop.job?.progress || 0}%` } });
    // La barra se arma acá y no en el árbol de abajo: el primer pintado ocurre antes
    // de montarla, y pedirle el padre a un nodo suelto rompía todo el detalle.
    const barBox = h('div.bar', {}, bar);
    const status = h('div.dim', { style: { fontSize: '.82rem', margin: '8px 0' } });
    const log = h('pre.log.hide');

    const ESTADOS = {
        pendiente: 'En la cola. Lo toma el worker apenas esté libre.',
        corriendo: job => `Reconstruyendo — ${job.step}`,
        listo: 'Listo: el tour 3D está disponible.',
        error: job => `Falló: ${job.error}`,
        cancelado: 'Cancelado.'
    };

    const paint = (job, worker) => {
        bar.style.width = `${job?.progress || 0}%`;
        const activo = job?.status === 'pendiente' || job?.status === 'corriendo';
        barBox.classList.toggle('run', activo);
        const texto = ESTADOS[job?.status];
        status.textContent = !job ? 'Todavía no se reconstruyó.' :
            (typeof texto === 'function' ? texto(job) : texto ?? '');
        if (worker) {
            estadoWorker.textContent = worker.conectado ? '● worker conectado' : '○ ningún worker conectado';
            estadoWorker.className = worker.conectado ? 'chip ok' : 'chip warn';
        }
        if (job?.log) {
            log.textContent = job.log;
            log.classList.remove('hide');
            log.scrollTop = log.scrollHeight;
        }
    };

    const estadoWorker = h('span.chip', {}, '…');
    paint(prop.job, CFG.worker);

    let timer;
    async function poll() {
        const { job, worker } = await api(`/properties/${prop.id}/job`);
        paint(job, worker);
        if (job?.status === 'pendiente' || job?.status === 'corriendo') {
            timer = setTimeout(poll, 4000);
        } else {
            clearTimeout(timer);
            if (job?.status === 'listo') {
                toast('¡Reconstrucción lista! Abrí el tour.');
                setTimeout(() => location.reload(), 900);
            }
        }
    }
    if (prop.job?.status === 'pendiente' || prop.job?.status === 'corriendo') poll();

    const run = h('button.btn.primary', {});
    run.textContent = '🧱 Reconstruir en 3D';
    run.onclick = busy(run, async () => {
        await api(`/properties/${prop.id}/reconstruct`, { method: 'POST', body: {} });
        toast(CFG.worker?.conectado ?
            'En la cola. El worker la toma enseguida; podés cerrar esto.' :
            'En la cola. Va a arrancar cuando prendas el worker.');
        poll();
    });

    const up = h('input', {
        type: 'file',
        accept: '.sog,.ply,.spz',
        style: { display: 'none' },
        onchange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            toast(`Subiendo ${file.name} (${(file.size / 1e6).toFixed(0)} MB)…`, false, 60000);
            try {
                await putFile(prop.id, 'splat', file);
                toast('Splat cargado.');
                location.reload();
            } catch (err) {
                toast(err.message, true, 9000);
            }
        }
    });

    // Salida de emergencia: si el splat ya está publicado en otro lado, alcanza con su URL.
    const urlInput = h('input', { placeholder: 'https://…/model.sog', style: { flex: '1' } });
    const attach = h('button.btn.sm', {});
    attach.textContent = 'Usar URL';
    attach.onclick = busy(attach, async () => {
        await api(`/properties/${prop.id}/attach`, {
            method: 'POST', body: { kind: 'splat', url: urlInput.value.trim() }
        });
        toast('Splat enlazado.');
        location.reload();
    });

    return h('div', { class: `card ${prop.scene.splatUrl ? 'ok' : ''}` },
        h('h2', {}, prop.scene.splatUrl ? '✅ Escena 3D' : '🧊 Escena 3D'),
        h('p.dim', { style: { marginTop: 0, fontSize: '.85rem' } },
            'Las fotos se convierten en la nube de puntos que recorrés en el tour.'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0 10px' } },
            estadoWorker,
            !CFG.worker?.conectado && h('small.dim', {},
                'Corré `npm run worker` en la máquina con GPU para que tome los trabajos.')),
        h('div', { style: { display: 'flex', gap: '8px', margin: '14px 0 10px', flexWrap: 'wrap' } },
            run,
            h('button.btn', { onclick: () => up.click() }, '⬆ Subir splat ya entrenado'), up,
            prop.scene.splatUrl && h('a.btn.ghost', { href: prop.scene.splatUrl, download: true, target: '_blank' },
                `Descargar ${prop.scene.splatUrl.slice(prop.scene.splatUrl.lastIndexOf('.')).split('?')[0]}`)),
        CFG.storage === 'blob' && !CFG.clientUpload && h('p.chip.warn', {},
            'Sin BLOB_READ_WRITE_TOKEN el archivo pasa por la función: hasta 4,5 MB. ' +
            'Para un splat más grande, enlazalo por URL o agregá el token al store.'),
        h('label', {}, 'o enlazar un splat que ya esté publicado en otra URL'),
        h('div', { style: { display: 'flex', gap: '6px' } }, urlInput, attach),
        h('div', { style: { height: '12px' } }),
        barBox, status, log);
}

// ---- IA

function sectionAI(prop, save) {
    const out = h('div');
    // replaceChildren no descarta lo falso como hace h(): un null llega al DOM convertido en
    // el texto "null". Con las tres secciones vacías se leía "nullnullnull" abajo del título.
    const paint = () => out.replaceChildren(...[
        prop.ai.audit && block('Auditoría de captura', auditView(prop.ai.audit)),
        prop.ai.rooms && block('Ambientes y guion', roomsView(prop, save)),
        prop.ai.listing && block('Aviso', listingView(prop.ai.listing))
    ].filter(Boolean));

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
    return h('div.card.ai', {},
        h('h2', {}, '🤖 IA generativa'),
        !CFG.ai.text && h('p.chip.warn', {}, 'Falta ANTHROPIC_API_KEY: cargala en inmo3d/.env'),
        h('p.dim', { style: { marginTop: '4px', fontSize: '.85rem' } },
            'Mira las fotos y devuelve trabajo terminado.'),
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
        h('h2', {}, '🔗 Compartir'),
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

function setupCard() {
    return h('div.card', { style: { maxWidth: '640px', margin: '40px auto' } },
        h('h2', {}, '📦 Falta el almacenamiento'),
        h('p', {}, 'El deploy está andando y la IA quedó configurada, pero Vercel no tiene dónde ' +
            'guardar las propiedades: su filesystem es de sólo lectura. Se arregla en dos minutos:'),
        h('ol', { style: { lineHeight: '1.9', paddingLeft: '20px' } },
            h('li', {}, 'En el proyecto de Vercel: ', h('b', {}, 'Storage → Create Database → Blob'), '.'),
            h('li', {}, 'Access: ', h('b', {}, 'Public'), '. El visor pide el splat y las fotos por URL ' +
                'desde el navegador; un store privado pediría token para cada archivo.'),
            h('li', {}, 'Tildá ', h('b', {}, 'Add a read-write token env var'),
                ': ese checkbox es el que crea ', h('code.mono', {}, 'BLOB_READ_WRITE_TOKEN'),
                ' (sin él sólo se crean el store id y la public key).'),
            h('li', {}, h('b', {}, 'Connect Project'), ' apuntando a este proyecto.'),
            h('li', {}, 'Volvé a ', h('b', {}, 'Deployments → … → Redeploy'),
                ' para que el deploy tome la variable.')),
        h('label', {}, 'Variables del Blob que ve este deploy'),
        h('div.chips', {}, CFG.blobVars?.length ?
            CFG.blobVars.map(v => h('span.chip.ok', {}, v)) :
            h('span.chip.warn', {}, 'ninguna')),
        h('p.dim', { style: { fontSize: '.86rem' } },
            'Corriendo en tu máquina esto no hace falta: los archivos van a inmo3d/data/.'));
}

async function route() {
    view.replaceChildren(h('div.card', {}, h('span.spin'), ' cargando…'));
    if (!CFG.writable) return view.replaceChildren(setupCard());

    const m0 = location.hash.match(/^#\/p\/(.+)$/);
    if (CFG.auth?.required && !CFG.auth.authenticated && !m0) {
        // La cartera completa es privada. Cada tour sigue siendo público por su link.
        return view.replaceChildren(accessCard(),
            h('div.card', { style: { marginTop: '16px' } },
                h('h2', {}, '🔒 Cartera privada'),
                h('p.dim', {}, 'El listado de propiedades sólo se ve con sesión iniciada. ' +
                    'Los tours que compartas siguen abriéndose con su link, sin clave.')));
    }

    try {
        const m = location.hash.match(/^#\/p\/(.+)$/);
        await (m ? renderDetail(m[1]) : renderList());
        if (!CFG.auth?.authenticated) {
            for (const control of view.querySelectorAll('input, select, textarea, button')) {
                if (control.textContent !== '← Propiedades' && control.textContent !== 'Copiar') control.disabled = true;
            }
            view.querySelectorAll('.drop').forEach(el => (el.style.pointerEvents = 'none'));
        }
        if (CFG.auth?.required && !CFG.auth.authenticated) view.prepend(accessCard());
    } catch (e) {
        if (e.status === 401) {
            toast('Tu sesión venció. Ingresá de nuevo.', true);
            return boot();
        }
        // Si el problema es el almacenamiento, mostramos los pasos además del error.
        if (/blob/i.test(e.message)) {
            view.replaceChildren(h('div.card.warn-top', { style: { maxWidth: '640px', margin: '40px auto 0' } },
                h('h2', {}, 'No pude leer las propiedades'), h('p', {}, e.message)), setupCard());
            return;
        }
        view.replaceChildren(h('div.card', {}, h('h2', {}, 'Ups'), h('p', {}, e.message),
            h('button.btn', { onclick: () => go('#/') }, 'Volver')));
    }
}

function accessCard() {
    const card = h('div.card', { style: { marginBottom: '16px' } }, h('h2', {}, 'Acceso de administración'));
    if (!CFG.auth.configured) {
        card.append(h('p', {}, 'Modo de consulta. Para editar, configurá INMO3D_ADMIN_TOKEN ' +
            'en Vercel y volvé a desplegar.'));
        return card;
    }
    const password = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Clave de administración', 'aria-label': 'Clave de administración' });
    const submit = h('button.btn.primary', { type: 'submit' }, 'Ingresar');
    const form = h('form', {}, password, submit);
    form.onsubmit = busy(submit, async (event) => {
        event.preventDefault();
        await api('/auth/login', { method: 'POST', body: { token: password.value } });
        password.value = '';
        await boot();
    });
    card.append(form);
    return card;
}

async function boot() {
    try {
        CFG = await config(true);
        $('#ai-state').textContent = CFG.ai.text ?
            `IA: ${CFG.ai.textModel}${CFG.ai.image ? ` + ${CFG.ai.imageProvider}` : ''}` : 'IA sin configurar';
        $('#ai-state').className = CFG.ai.text ? 'chip ok' : 'chip warn';
        $('#new-prop').disabled = !CFG.auth?.authenticated;
        $('#logout')?.remove();
        if (CFG.auth?.required && CFG.auth.authenticated) {
            const logout = h('button.btn.ghost.sm', { id: 'logout' }, 'Cerrar sesión');
            logout.onclick = busy(logout, async () => {
                await api('/auth/logout', { method: 'POST' });
                await boot();
            });
            document.querySelector('header').append(logout);
        }
        await route();
    } catch (e) {
        view.replaceChildren(h('div.card', {}, h('h2', {}, 'No se pudo cargar el panel'), h('p', {}, e.message)));
    }
}

window.addEventListener('hashchange', route);
$('#new-prop').onclick = () => newProperty().catch(e => toast(e.message, true));
boot();
