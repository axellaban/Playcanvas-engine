// Cola de reconstrucción. La web nunca entrena: encola, y un worker con GPU toma
// el trabajo, reporta avance y sube el resultado. Un solo camino, corra donde corra
// la app — en Vercel o en tu máquina.
import * as store from './store.mjs';
import * as storage from './storage.mjs';

const ESTADO = '_estado/worker.json';
const VIVO = 90_000;          // sin señales por más de esto, damos el worker por caído
const TRABAJANDO = 5 * 60_000;    // sin noticias de un trabajo por más de esto, no lo damos por vivo
const ABANDONADO = 30 * 60_000;   // un trabajo tomado y sin avanzar vuelve a la cola

/** Última vez que este trabajo dio señales de estar vivo. */
const ultimaSenal = job => Date.parse(job.visto || job.tomadoEn || job.pedidoEn);

const ahora = () => new Date().toISOString();

/** Marca que el worker sigue ahí. Lo llama el propio worker al pedir trabajo. */
export async function latido(nombre = 'worker') {
    await storage.writeJson(ESTADO, { nombre, visto: ahora() }).catch(() => {});
}

export async function worker() {
    const estado = await storage.readJson(ESTADO);
    if (!estado?.visto) return { conectado: false, visto: null };
    return { conectado: Date.now() - Date.parse(estado.visto) < VIVO, visto: estado.visto, nombre: estado.nombre };
}

/** Pone la propiedad en la cola. No entrena nada: sólo deja el pedido anotado. */
export async function encolar(id, opciones = {}) {
    const prop = await store.getProperty(id);
    if (!prop) throw Object.assign(new Error('Propiedad inexistente.'), { status: 404 });
    if (!prop.video && prop.photos.length < 20) {
        throw new Error(prop.photos.length ?
            `Con ${prop.photos.length} fotos no alcanza. Subí al menos 20 (lo ideal: 80-200), o grabá un video del recorrido.` :
            'Subí fotos (80-200) o grabá un video recorriendo el ambiente.');
    }
    // Se rechaza mientras el pedido siga en pie: esperando que el worker lo tome, o con el
    // worker trabajándolo ahora mismo. Lo que ya no traba el botón es un trabajo que quedó
    // marcado como en curso porque el worker se cortó a la mitad —Ctrl+C, la tapa de la
    // notebook, un corte de luz—. Antes eso dejaba la propiedad inservible media hora, hasta
    // que venciera el plazo de abandono, sin más explicación que "ya está en la cola".
    if (prop.job?.status === 'pendiente') {
        throw new Error('Esta propiedad ya está en la cola.');
    }
    if (prop.job?.status === 'corriendo' && Date.now() - ultimaSenal(prop.job) < TRABAJANDO) {
        throw new Error('Ya se está reconstruyendo. Mirá cómo va acá abajo.');
    }
    prop.job = {
        status: 'pendiente',
        step: 'en cola',
        progress: 0,
        log: '',
        pedidoEn: ahora(),
        tomadoEn: null,
        terminadoEn: null,
        error: null,
        opciones: { trainer: opciones.trainer, sfm: opciones.sfm, steps: opciones.steps }
    };
    await store.saveProperty(prop);
    return prop.job;
}

export async function cancelar(id) {
    const prop = await store.getProperty(id);
    if (!prop?.job || prop.job.status === 'listo') return false;
    prop.job = { ...prop.job, status: 'cancelado', terminadoEn: ahora() };
    await store.saveProperty(prop);
    return true;
}

/**
 * Entrega el trabajo más viejo que esté esperando. Si un trabajo quedó "corriendo"
 * mucho tiempo sin dar señales (se cortó la luz, se cerró la notebook), vuelve a la cola.
 */
export async function tomar(nombreWorker, reiniciado = false) {
    await latido(nombreWorker);
    const lista = await store.listProperties();

    // Un worker que recién arranca no está corriendo nada. Si algo quedó marcado como en
    // curso es de una sesión anterior que se cortó, así que vuelve a la cola y esta sesión
    // lo retoma sola: apagar y prender el worker alcanza para destrabar, sin tocar nada más.
    if (reiniciado) {
        for (const item of lista.filter(p => p.job?.status === 'corriendo')) {
            const prop = await store.getProperty(item.id);
            if (prop?.job?.status !== 'corriendo') continue;
            prop.job = {
                ...prop.job,
                status: 'pendiente',
                step: 'en cola',
                progress: 0,
                log: '',
                error: null,
                tomadoEn: null,
                visto: null
            };
            await store.saveProperty(prop);
        }
    }
    const candidatas = lista
    .filter(p => p.job?.status === 'pendiente' || p.job?.status === 'corriendo')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));

    for (const item of candidatas) {
        const prop = await store.getProperty(item.id);
        if (!prop?.job) continue;
        const vencido = prop.job.status === 'corriendo' &&
            Date.now() - ultimaSenal(prop.job) > ABANDONADO;
        if (prop.job.status !== 'pendiente' && !vencido) continue;

        prop.job = { ...prop.job, status: 'corriendo', step: 'preparando', tomadoEn: ahora(), error: null };
        await store.saveProperty(prop);
        return {
            id: prop.id,
            titulo: prop.meta.title,
            opciones: prop.job.opciones ?? {},
            fotos: prop.photos.map(f => ({ file: f.file, url: f.url })),
            video: prop.video?.url ?? null
        };
    }
    return null;
}

/** El worker informa cómo va. También sirve de latido mientras entrena. */
export async function avance(id, { step, progress, log }) {
    const prop = await store.getProperty(id);
    if (!prop?.job) throw Object.assign(new Error('Ese trabajo no existe.'), { status: 404 });
    await latido(prop.job.worker);
    prop.job = {
        ...prop.job,
        status: 'corriendo',
        visto: ahora(),
        step: step ?? prop.job.step,
        progress: progress ?? prop.job.progress,
        // Guardamos sólo la cola del log: alcanza para ver qué pasó y no infla el JSON.
        log: log ? `${prop.job.log}${log}`.slice(-8000) : prop.job.log
    };
    await store.saveProperty(prop);
    return prop.job;
}

/** Cierra el trabajo. Con `splatUrl`, la propiedad queda lista para recorrer. */
export async function terminar(id, { splatUrl, file, error }) {
    const prop = await store.getProperty(id);
    if (!prop?.job) throw Object.assign(new Error('Ese trabajo no existe.'), { status: 404 });
    if (error) {
        prop.job = { ...prop.job, status: 'error', error: String(error).slice(0, 2000), terminadoEn: ahora() };
    } else {
        if (!/^https?:\/\/|^\/media\//.test(splatUrl || '')) throw new Error('Falta la URL del splat.');
        prop.scene.splat = file || splatUrl;
        prop.scene.splatUrl = splatUrl;
        prop.job = { ...prop.job, status: 'listo', step: 'listo', progress: 100, terminadoEn: ahora() };
    }
    await store.saveProperty(prop);
    return prop.job;
}
