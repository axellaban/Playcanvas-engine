// El tour propiamente dicho: navegación, paradas, medición con calibración métrica,
// hotspots, home staging con IA y un asistente que le contesta al interesado.
import { Color } from 'playcanvas';
import { createViewer, arr, v3 } from './viewer.mjs';
import { h, $, api, toast, busy, money, config } from './ui.mjs';

const qs = new URLSearchParams(location.search);
const id = qs.get('id');
const overlay = $('#overlay');
const canvas = $('#canvas');
const loader = $('#loader');

const die = (msg) => {
    $('#loader-text').textContent = msg;
    $('#loader .spin')?.remove();
    throw new Error(msg);
};

if (!id) die('Falta el identificador de la propiedad (?id=).');
const prop = await api(`/properties/${encodeURIComponent(id)}`);
if (!prop.scene.splatUrl) {
    die('Esta propiedad todavía no tiene escena 3D. Subí un splat desde el panel.');
}
const CFG = await config();
const minimal = qs.get('ui') === 'min' || !CFG.auth?.authenticated;

$('#loader-text').textContent = 'cargando la casa… (la primera vez tarda un poco)';
const viewer = await createViewer({
    canvas,
    splatUrl: prop.scene.splatUrl,
    scene: prop.scene,
    gpu: qs.get('gpu') || 'webgl2'
}).catch(e => die(e.message));
loader.remove();

// Las mediciones de un visitante viven sólo en su navegador.
const save = patch => (minimal ? Promise.resolve() : api(`/properties/${id}`, { method: 'PATCH', body: patch }));
const st = { tool: null, pending: [], stop: -1, markers: [], dismissedSheet: false };

const COLORS = { measure: new Color(1, 0.48, 0.27), pending: new Color(1, 0.9, 0.3) };

// ---------------------------------------------------------------- herramientas por click

let down = null;
canvas.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', async (e) => {
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 99;
    down = null;
    if (moved > 6) return;                       // fue un arrastre de cámara, no un click
    if (st.dismissedSheet) {
        st.dismissedSheet = false;
        return;
    }

    const tool = st.tool;
    if (!tool && viewer.state.mode !== 'caminar') return;

    const p = await viewer.pickWorld(e.clientX, e.clientY);
    if (!p) {
        if (tool) toast('Ahí no hay superficie. Probá sobre una pared o el piso.', true);
        return;
    }

    switch (tool) {
        case 'medir':
        case 'calibrar': {
            st.pending.push(arr(p));
            if (st.pending.length === 2) {
                const [a, b] = st.pending;
                st.pending = [];
                if (tool === 'calibrar') {
                    const real = Number(prompt('¿Cuánto mide en metros lo que acabás de marcar?\n' +
                        '(una puerta estándar mide 2.05 m de alto)', '2.05'));
                    if (real > 0) {
                        const raw = v3(a).distance(v3(b));
                        const mpu = real / raw;
                        viewer.setMeters(mpu);
                        await save({ scene: { metersPerUnit: mpu } });
                        toast(`Escala calibrada: 1 unidad = ${mpu.toFixed(3)} m. Ahora las medidas son reales.`);
                    }
                    setTool(null);
                } else {
                    const meters = viewer.distance(a, b);
                    const label = prompt('¿Qué estás midiendo?', 'Medida') || 'Medida';
                    prop.measures.push({ id: `m${Date.now()}`, label, a, b, meters });
                    await save({ measures: prop.measures });
                    renderMeasures();
                    toast(`${label}: ${meters.toFixed(2)} m`);
                }
            }
            break;
        }
        case 'hotspot': {
            const title = prompt('Título del hotspot', 'Detalle');
            if (title) {
                prop.hotspots.push({ id: `hs${Date.now()}`, title, body: prompt('Texto (opcional)', '') || '', pos: arr(p) });
                await save({ hotspots: prop.hotspots });
                renderMarkers();
            }
            setTool(null);
            break;
        }
        case 'ubicar': {
            const i = prop.tour.findIndex(w => !w.pos);
            if (i < 0) {
                toast('Todas las paradas ya están ubicadas.');
                setTool(null);
                break;
            }
            // La parada guarda desde dónde se mira y hacia dónde: así se reproduce igual siempre.
            const eye = viewer.camera.getPosition();
            prop.tour[i].pos = arr(eye);
            prop.tour[i].look = arr(p);
            await save({ tour: prop.tour });
            renderStops();
            renderMarkers();
            const left = prop.tour.filter(w => !w.pos).length;
            toast(left ? `"${prop.tour[i].name}" ubicada. Faltan ${left}.` : 'Todas las paradas ubicadas.');
            if (!left) setTool(null);
            break;
        }
        case 'piso': {
            viewer.setFloor(p.y);
            await save({ scene: { floorY: p.y } });
            toast('Piso fijado: ahora la caminata va a la altura correcta.');
            setTool(null);
            break;
        }
        default:
            if (viewer.state.mode === 'caminar') viewer.teleport(p);
    }
});

// ---------------------------------------------------------------- marcadores sobre el 3D

function renderMarkers() {
    st.markers.forEach(m => m.el.remove());
    st.markers = [];

    prop.tour.forEach((wp, i) => {
        if (!wp.pos) return;
        const el = h('button.hotspot.wp', { title: wp.name, onclick: () => goStop(i) }, String(i + 1));
        overlay.append(el);
        st.markers.push({ el, pos: v3(wp.look ?? wp.pos) });
    });

    prop.hotspots.forEach((hs) => {
        const el = h('button.hotspot', { title: hs.title, onclick: () => showCard(hs) }, 'i');
        overlay.append(el);
        st.markers.push({ el, pos: v3(hs.pos) });
    });

    prop.measures.forEach((m) => {
        const el = h('div.label', {}, `${m.label}: ${m.meters.toFixed(2)} m`);
        overlay.append(el);
        st.markers.push({ el, pos: v3(m.a).add(v3(m.b)).mulScalar(0.5) });
    });
}

function showCard(hs) {
    $('#card')?.remove();
    const card = h('div.panel-r', {
        id: 'card',
        style: { top: 'auto', bottom: '80px', right: '14px', width: '280px', padding: '14px' }
    },
    h('div', { style: { display: 'flex', gap: '8px' } },
        h('h3', { style: { flex: 1, margin: 0 } }, hs.title),
        h('button.btn.sm.ghost', { onclick: () => card.remove() }, '✕')),
    hs.body && h('p', { style: { fontSize: '.86rem', margin: '8px 0 0' } }, hs.body),
    !minimal && h('button.btn.sm', {
        style: { marginTop: '8px' },
        onclick: async () => {
            prop.hotspots = prop.hotspots.filter(x => x.id !== hs.id);
            await save({ hotspots: prop.hotspots });
            renderMarkers();
            card.remove();
        }
    }, 'Borrar hotspot'));
    overlay.append(card);
}

// Cada frame: proyectamos los puntos 3D a la pantalla y movemos los marcadores DOM.
viewer.app.on('update', () => {
    for (const m of st.markers) {
        const s = viewer.worldToScreen(m.pos);
        m.el.style.display = s.visible ? '' : 'none';
        if (s.visible) m.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    }
    for (const m of prop.measures) viewer.drawSegment(m.a, m.b, COLORS.measure);
    if (st.pending.length === 1 && viewer.state.mode) {
        const a = st.pending[0];
        viewer.drawSegment(a, [a[0], a[1] + 0.02, a[2]], COLORS.pending);
    }
});

// ---------------------------------------------------------------- panel izquierdo

const stopsEl = h('ul.stops');
const mini = h('canvas', { id: 'minimap', width: 240, height: 240 });

function renderStops() {
    stopsEl.replaceChildren(...prop.tour.map((wp, i) => h('li', {
        class: i === st.stop ? 'active' : '',
        onclick: () => goStop(i)
    }, h('b', {}, String(i + 1)), h('span', { style: { flex: 1 } }, wp.name),
    !wp.pos && h('span.chip.warn', {}, 'sin ubicar'))));
}

function goStop(i) {
    const wp = prop.tour[i];
    if (!wp?.pos) return toast('Esta parada todavía no está ubicada en la escena.', true);
    st.stop = i;
    viewer.goTo(wp);
    renderStops();
    if (wp.desc) {
        $('#stop-desc').textContent = wp.desc;
        $('#stop-desc').classList.remove('hide');
    }
}

let playing = null;
function playTour() {
    if (playing) {
        clearInterval(playing);
        playing = null;
        return toast('Recorrido pausado.');
    }
    const placed = prop.tour.filter(w => w.pos);
    if (!placed.length) return toast('No hay paradas ubicadas todavía.', true);
    let i = 0;
    goStop(prop.tour.indexOf(placed[0]));
    playing = setInterval(() => {
        i = (i + 1) % placed.length;
        goStop(prop.tour.indexOf(placed[i]));
    }, 6000);
    toast('Recorrido automático: una parada cada 6 segundos.');
}

function drawMinimap() {
    const ctx = mini.getContext('2d');
    const S = mini.width;
    ctx.clearRect(0, 0, S, S);
    const min = viewer.aabb?.getMin(), max = viewer.aabb?.getMax();
    if (!min) return;
    const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
    const span = Math.max(max.x - min.x, max.z - min.z, 1) * 1.1;
    const map = (x, z) => [((x - cx) / span + 0.5) * S, ((z - cz) / span + 0.5) * S];

    // El plano se lee sobre fondo claro u oscuro, así que los colores salen del tema.
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--line').trim() || '#2a3342';
    const dim = css.getPropertyValue('--dim').trim() || '#8e9bb0';
    const accent = css.getPropertyValue('--accent').trim() || '#ff6b35';
    const ok = css.getPropertyValue('--ok').trim() || '#21c99a';
    const card = css.getPropertyValue('--card').trim() || '#161b26';

    const w = (max.x - min.x) / span * S, hgt = (max.z - min.z) / span * S;
    const [ox, oy] = map(min.x, min.z);
    ctx.fillStyle = color(line, 0.25);
    ctx.fillRect(ox, oy, w, hgt);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, w, hgt);

    // Hilo del recorrido: de un vistazo se ve por dónde va el tour.
    const placed = prop.tour.filter(wp => wp.pos);
    if (placed.length > 1) {
        ctx.strokeStyle = color(dim, 0.5);
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        placed.forEach((wp, i) => ctx[i ? 'lineTo' : 'moveTo'](...map(wp.pos[0], wp.pos[2])));
        ctx.stroke();
        ctx.setLineDash([]);
    }

    prop.tour.forEach((wp, i) => {
        if (!wp.pos) return;
        const [x, y] = map(wp.pos[0], wp.pos[2]);
        const active = i === st.stop;
        ctx.fillStyle = active ? accent : card;
        ctx.strokeStyle = active ? accent : dim;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, active ? 8 : 6.5, 0, 7);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = active ? '#16100b' : dim;
        ctx.font = `bold ${active ? 10 : 9}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), x, y + 0.5);
    });

    const p = viewer.camera.getPosition();
    const f = viewer.camera.forward;
    const [x, y] = map(p.x, p.z);
    const a = Math.atan2(f.z, f.x);
    // Cono de visión: hacia dónde mira la cámara, no sólo dónde está.
    ctx.fillStyle = color(ok, 0.22);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, 26, a - 0.5, a + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ok;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, 7);
    ctx.fill();
}

/** Un color del tema con opacidad, sirva como hex o como rgb(). */
function color(value, alpha) {
    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${alpha})`;
    }
    return value.replace(/^rgb\(/, 'rgba(').replace(/\)$/, `, ${alpha})`);
}
setInterval(drawMinimap, 80);

const left = h('div.panel-l', {},
    h('section', {},
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
            h('h2', { style: { flex: 1, margin: 0, fontSize: '1rem' } }, prop.meta.title),
            !minimal && h('a.btn.sm.ghost', { href: `/#/p/${id}` }, 'panel')),
        h('small.dim', {}, [prop.meta.address, prop.meta.city].filter(Boolean).join(', ')),
        h('div', { style: { fontWeight: 700, marginTop: '6px' } }, money(prop.meta.price, prop.meta.currency)),
        h('div.chips', { style: { marginTop: '8px' } },
            prop.meta.bedrooms && h('span.chip', {}, `${prop.meta.bedrooms} dorm`),
            prop.meta.bathrooms && h('span.chip', {}, `${prop.meta.bathrooms} baños`),
            prop.meta.areaCovered && h('span.chip', {}, `${prop.meta.areaCovered} m²`))),
    h('section', {},
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('h3', { style: { flex: 1, margin: 0 } }, 'Recorrido'),
            h('button.btn.sm.ghost', { onclick: playTour }, '▶ auto')),
        stopsEl,
        h('p.dim.hide', { id: 'stop-desc', style: { fontSize: '.82rem', marginBottom: 0 } })),
    h('section', {}, h('h3', {}, 'Plano'), mini,
        h('small.dim', {}, 'Verde: dónde estás mirando.')));
overlay.append(left);
renderStops();
renderMarkers();

// ---------------------------------------------------------------- panel derecho (IA)

function renderMeasures() {
    $('#measures').replaceChildren(...prop.measures.map(m => h('div', {
        style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '.82rem' }
    },
    h('span', { style: { flex: 1 } }, m.label), h('b', {}, `${m.meters.toFixed(2)} m`),
    !minimal && h('button.btn.sm.ghost', {
        onclick: async () => {
            prop.measures = prop.measures.filter(x => x.id !== m.id);
            await save({ measures: prop.measures });
            renderMeasures();
            renderMarkers();
        }
    }, '✕'))));
}

const chatLog = h('div.chat');
const chatInput = h('input', { placeholder: '¿Cuánto mide el living?' });
const chatSend = h('button.btn.sm.primary', {});
chatSend.textContent = 'Preguntar';
chatSend.onclick = busy(chatSend, async () => {
    const q = chatInput.value.trim();
    if (!q) return;
    chatInput.value = '';
    chatLog.append(h('div.msg.me', {}, q));
    chatLog.scrollTop = 1e6;
    const { answer } = await api(`/properties/${id}/ai/ask`, { method: 'POST', body: { question: q } });
    chatLog.append(h('div.msg.ia', {}, answer));
    chatLog.scrollTop = 1e6;
});
chatInput.addEventListener('keydown', e => e.key === 'Enter' && chatSend.click());

const stageStyle = h('select', {}, ['moderno', 'escandinavo', 'minimalista', 'industrial', 'clasico', 'vacio']
.map(s => h('option', {}, s)));
const stageOut = h('div');
const stageBtn = h('button.btn.primary.sm', { disabled: !CFG.ai.image });
stageBtn.textContent = '✨ Amueblar esta vista';
stageBtn.onclick = busy(stageBtn, async () => {
    const image = await viewer.screenshot();
    const room = prop.tour[st.stop]?.name || '';
    const res = await api(`/properties/${id}/ai/stage`, {
        method: 'POST', body: { image, style: stageStyle.value, room }
    });
    stageOut.replaceChildren(beforeAfter(image, res.url));
    toast('Staging listo. Movés el slider para comparar.');
});

function beforeAfter(before, after) {
    const box = h('div.ab', {},
        h('img', { src: before }),
        h('div.after', {}, h('img', { src: after })));
    const range = h('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: 50,
        oninput: e => (box.querySelector('.after').style.clipPath = `inset(0 0 0 ${e.target.value}%)`)
    });
    box.append(range);
    return h('div', {}, box,
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
            h('a.btn.sm', { href: after, download: true, target: '_blank' }, 'Descargar'),
            h('small.dim', { style: { alignSelf: 'center' } }, 'render real ← → propuesta IA')));
}

function sectionEscena() {
    const S = prop.scene;
    const slider = (key, label, min, max, step) => {
        const val = h('small.dim', {}, String(S[key] ?? (key === 'scale' ? 1 : 0)));
        const input = h('input', {
            type: 'range',
            min,
            max,
            step,
            value: S[key] ?? (key === 'scale' ? 1 : 0),
            oninput: (e) => {
                S[key] = Number(e.target.value);
                val.textContent = e.target.value;
                viewer.applyTransform(S);
            },
            onchange: () => save({ scene: { [key]: S[key] } })
        });
        return h('div', {}, h('label', {}, `${label} `, val), input);
    };
    return h('section', {},
        h('h3', {}, '🧭 Enderezar escena'),
        h('p.dim', { style: { fontSize: '.8rem', margin: '0 0 6px' } },
            'Los escaneos salen con la orientación de la cámara, no de la casa. Girá hasta que el piso quede horizontal.'),
        slider('pitch', 'Inclinación', -180, 180, 1),
        slider('yaw', 'Giro', -180, 180, 1),
        slider('roll', 'Alabeo', -180, 180, 1),
        slider('scale', 'Escala', 0.1, 5, 0.01),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
            h('button.btn.sm', {
                onclick: () => {
                    const e = { pitch: 0, yaw: 0, roll: 0, scale: 1 };
                    Object.assign(S, e);
                    viewer.applyTransform(S);
                    save({ scene: e });
                    right.replaceChild(sectionEscena(), right.firstChild);
                }
            }, 'Resetear'),
            h('button.btn.sm', {
                onclick: () => {
                    const v = Number(prompt('Altura de los ojos al caminar, en metros', String(viewer.state.eyeHeight)));
                    if (v > 0) {
                        viewer.setEyeHeight(v);
                        save({ scene: { eyeHeight: v } });
                    }
                }
            }, 'Altura de ojos')));
}

const right = h('div.panel-r', {},
    !minimal && sectionEscena(),
    !minimal && h('section', {},
        h('h3', {}, '✨ Home staging virtual'),
        h('p.dim', { style: { fontSize: '.8rem', margin: '0 0 8px' } },
            'Encuadrá un ambiente y la IA lo amuebla respetando la arquitectura real.'),
        !CFG.ai.image ? h('span.chip.warn', {}, 'configurá INMO3D_IMAGE_PROVIDER') :
            h('div', { style: { display: 'flex', gap: '6px' } }, stageStyle, stageBtn),
        stageOut),
    h('section', {},
        h('h3', {}, 'Medidas'),
        h('div', { id: 'measures' }),
        h('small.dim', {}, viewer.state.metersPerUnit === 1 ?
            'Sin calibrar: las distancias son relativas. Usá 📐 Calibrar una vez.' :
            `Escala: 1 unidad = ${viewer.state.metersPerUnit.toFixed(3)} m`)),
    !minimal && h('section', {},
        h('h3', {}, '💬 Consultas'),
        chatLog,
        h('div', { style: { display: 'flex', gap: '6px' } }, chatInput, chatSend)));
overlay.append(right);
renderMeasures();
renderMarkers();

// ---------------------------------------------------------------- barra de herramientas

const toolBtns = {};
function setTool(t) {
    st.tool = st.tool === t ? null : t;
    st.pending = [];
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === st.tool);
    canvas.style.cursor = st.tool ? 'crosshair' : '';
    const hints = {
        medir: 'Click en dos puntos para medir.',
        calibrar: 'Marcá dos puntos de algo que sepas cuánto mide (una puerta, por ejemplo).',
        hotspot: 'Click donde querés dejar la nota.',
        ubicar: 'Ubicate con la cámara y hacé click en lo que tiene que mirar la parada.',
        piso: 'Click en el piso para fijar la altura de caminata.'
    };
    if (st.tool) toast(hints[st.tool]);
}

const tool = (key, label, title) => {
    const b = h('button.btn.sm', { title, onclick: () => setTool(key) }, label);
    toolBtns[key] = b;
    return b;
};

const modeBtn = h('button.btn.sm.primary', {
    onclick: () => {
        const mode = viewer.state.mode === 'orbita' ? 'caminar' : 'orbita';
        viewer.setMode(mode);
        modeBtn.textContent = mode === 'caminar' ? '🚶 Caminando' : '🛰 Órbita';
        toast(mode === 'caminar' ?
            'Caminata: arrastrá para mirar, WASD para moverte, click en el piso para teletransportarte.' :
            'Órbita: arrastrá para girar, rueda para acercar.');
    }
}, '🛰 Órbita');

/**
 * En el celular los paneles son hojas que se abren desde la barra: si estuvieran
 * fijos a los costados, como en escritorio, taparían la casa entera.
 */
const sheetButtons = [];

function sheet(panel, label, title) {
    const btn = h('button.btn.sm.sheet-toggle', { title }, label);
    btn.onclick = () => {
        const opening = !panel.classList.contains('open');
        closeSheets();
        panel.classList.toggle('open', opening);
        btn.classList.toggle('on', opening);
    };
    sheetButtons.push([panel, btn]);
    return btn;
}

/** Cierra las hojas abiertas y avisa si había alguna. */
function closeSheets() {
    let had = false;
    for (const [panel, btn] of sheetButtons) {
        had ||= panel.classList.contains('open');
        panel.classList.remove('open');
        btn.classList.remove('on');
    }
    return had;
}

// Tocar la casa cierra la hoja abierta; ese toque cierra y nada más, para no
// teletransportarte sin querer al ir a cerrar el panel.
canvas.addEventListener('pointerdown', () => {
    st.dismissedSheet = closeSheets();
});

const toolbar = h('div.toolbar', {},
    sheet(left, '🏠', 'Ficha y recorrido'),
    modeBtn,
    tool('medir', '📏 Medir', 'Medir una distancia'),
    !minimal && tool('calibrar', '📐 Calibrar', 'Fijar la escala real de la escena'),
    !minimal && tool('hotspot', '📍 Hotspot', 'Dejar una nota anclada en el 3D'),
    !minimal && prop.tour.some(w => !w.pos) && tool('ubicar', '🎯 Ubicar paradas', 'Ubicar las paradas del recorrido'),
    !minimal && tool('piso', '⬇ Piso', 'Fijar la altura del piso'),
    h('button.btn.sm', {
        onclick: async () => {
            const a = document.createElement('a');
            a.href = await viewer.screenshot();
            a.download = `${prop.id}.jpg`;
            a.click();
        }
    }, '📸'),
    viewer.vrAvailable() && h('button.btn.sm', {
        onclick: () => viewer.startVR().catch(e => toast(e.message, true))
    }, '🥽 VR'),
    h('button.btn.sm', {
        onclick: (e) => {
            const on = !viewer.state.autoRotate;
            viewer.setAutoRotate(on);
            e.target.classList.toggle('on', on);
        }
    }, '🔄'),
    sheet(right, '📐', 'Medidas y herramientas'),
    !minimal && h('button.btn.sm.ghost', {
        onclick: () => {
            left.classList.toggle('hide');
            right.classList.toggle('hide');
        }
    }, '👁'));
overlay.append(toolbar);

// Atajos de teclado: los que espera cualquiera que use un visor 3D.
window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'm') setTool('medir');
    if (e.key === 'Escape') setTool(null);
    if (e.key === ' ') {
        e.preventDefault();
        modeBtn.click();
    }
    if (e.key >= '1' && e.key <= '9') goStop(Number(e.key) - 1);
});

if (prop.tour.some(w => w.pos)) goStop(prop.tour.findIndex(w => w.pos));
