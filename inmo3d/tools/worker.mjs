#!/usr/bin/env node
// El worker: corre en la máquina que tiene GPU y hace el trabajo que la web no puede.
// Pregunta si hay algo para reconstruir, se baja las fotos, corre el pipeline, va
// contando cómo va, y sube el .sog terminado. Después vuelve a preguntar.
//
//   INMO3D_URL=https://tu-app.vercel.app INMO3D_ADMIN_TOKEN=tuclave npm run worker
//
// Sin variables, apunta al servidor local (http://localhost:3113).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desdeVideo } from './fotogramas.mjs';
import { dormir, porfiar } from './reintentar.mjs';
import { comoVa, leerAvance } from './avance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const line of (await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const BASE = (process.env.INMO3D_URL || `http://localhost:${process.env.PORT || 3113}`).replace(/\/$/, '');
const TOKEN = process.env.INMO3D_ADMIN_TOKEN || '';
const NOMBRE = process.env.INMO3D_WORKER_NAME || os.hostname();
const ESPERA = Number(process.env.INMO3D_WORKER_POLL || 15) * 1000;
const REINTENTOS = 2;
// Un fallo temprano —ffmpeg, una opción que COLMAP no conoce, el video que no bajó— se
// reintenta solo. Uno que aparece después de horas de entrenamiento no: repetirlo son otras
// tantas horas para llegar al mismo lado, y eso hay que mirarlo, no insistirlo.
const RAPIDO = 15 * 60_000;
// Entre un intento y el otro se espera. Antes se reintentaba en el acto, y los tres intentos
// se consumían en segundos: contra un corte de internet los tres fallaban por lo mismo.
const ESPERA_REINTENTO = [30_000, 120_000];
// El material de trabajo no va más a una carpeta al azar que se pierde al reiniciar. Va a una
// carpeta fija por pedido, para que un corte de luz no obligue a rehacer las horas de cálculo
// de cámaras que ya estaban hechas. Se puede mudar con INMO3D_TRABAJOS (lo usan los tests).
const TRABAJOS = process.env.INMO3D_TRABAJOS || path.join(os.homedir(), '.inmo3d', 'trabajos');

let cookie = '';

const log = (...a) => console.log(new Date().toLocaleTimeString('es-AR'), ...a);

async function api(ruta, body) {
    const res = await fetch(`${BASE}/api${ruta}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const texto = await res.text();
    let datos;
    try {
        datos = texto ? JSON.parse(texto) : {};
    } catch {
        throw new Error(`${ruta}: respuesta no-JSON (HTTP ${res.status}). ¿La URL es la correcta?`);
    }
    if (res.status === 401 && TOKEN) {
        await entrar();
        return api(ruta, body);
    }
    if (!res.ok) throw Object.assign(new Error(datos.error || `HTTP ${res.status}`), { status: res.status });
    return datos;
}

async function entrar() {
    if (!TOKEN) return;
    const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN })
    });
    if (!res.ok) throw new Error('No pude iniciar sesión: revisá INMO3D_ADMIN_TOKEN.');
    cookie = (res.headers.getSetCookie?.()[0] || '').split(';')[0];
    log('sesión iniciada en', BASE);
}

/**
 * Mientras dura un trabajo la Mac no se duerme. Antes había que acordarse de escribir
 * `caffeinate` a mano; ahora se pide solo y se suelta al terminar, así la máquina vuelve a
 * dormirse normal en vez de quedarse despierta para siempre.
 */
function noDormir() {
    if (process.platform !== 'darwin') return () => {};
    const hijo = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
    hijo.on('error', () => {});
    return () => hijo.kill();
}

/** Cómo se cuenta un reintento en el registro, para que se entienda que no es un error. */
const avisarReintento = que => (e, espera) => {
    log(`  ${que}: ${e.message} — reintento en ${Math.round(espera / 1000)}s`);
};

/** Baja un archivo con paciencia: bajar de nuevo cuesta segundos, así que se porfía. */
async function bajar(url, destino, que) {
    await porfiar(async () => {
        const res = await fetch(url.startsWith('http') ? url : `${BASE}${url}`);
        if (!res.ok) {
            throw Object.assign(new Error(`No pude bajar ${que} (HTTP ${res.status})`), { status: res.status });
        }
        await fs.writeFile(destino, Buffer.from(await res.arrayBuffer()));
    }, { avisar: avisarReintento(`bajar ${que}`) });
}

/** Se baja las fotos de la propiedad a una carpeta de trabajo. */
async function bajarFotos(trabajo, dir) {
    await fs.mkdir(dir, { recursive: true });
    let n = 0;
    for (const foto of trabajo.fotos) {
        await bajar(foto.url, path.join(dir, foto.file), foto.file);
        // Contar el avance es cortesía, no parte del trabajo: si la app no contesta, se sigue.
        if (++n % 20 === 0) {
            await api(`/jobs/${trabajo.id}`, {
                step: 'bajando fotos', progress: Math.round(n / trabajo.fotos.length * 10)
            }).catch(() => {});
        }
    }
    return n;
}

/** Corre reconstruct.sh y traduce sus etapas en avance para el panel. */
function reconstruir(trabajo, fotos, salida, extra = []) {
    const PASOS = { preparando: 15, sfm: 30, entrenando: 60, comprimiendo: 90, listo: 100 };
    // Hasta dónde llega la barra cuando la etapa termina. El entrenamiento se lleva de 60 a 90,
    // que es el tramo largo y el único donde vale la pena contar de a poquito.
    const HASTA = { preparando: 30, sfm: 60, entrenando: 90, comprimiendo: 100 };
    // Cada cuánto contar cómo va, aunque el entrenador no diga una palabra. Sin esto, con un
    // entrenador callado la pantalla se queda quieta horas y parece colgado.
    const LATIDO = 30_000;
    const pasosPedidos = Number(trabajo.opciones.steps) || 15000;
    // Se puede apuntar a otro script (o a uno de prueba) sin tocar el worker.
    const script = process.env.INMO3D_PIPELINE || path.join(ROOT, 'pipeline', 'reconstruct.sh');
    const args = [script, '--photos', fotos, '--out', salida, ...extra];
    for (const [flag, valor] of [['--sfm', trabajo.opciones.sfm], ['--trainer', trabajo.opciones.trainer],
        ['--steps', trabajo.opciones.steps]]) {
        if (valor) args.push(flag, String(valor));
    }

    return new Promise((resolve, reject) => {
        const hijo = spawn('bash', args, { cwd: ROOT });
        let pendiente = '';
        let todo = '';
        let etapa = null;
        let etapaDesde = Date.now();
        let leido = null;

        /** Cómo va ahora mismo: la etapa, el porcentaje y cuánto falta. */
        const estado = () => (etapa && HASTA[etapa] ? comoVa({
            etapa,
            transcurrido: Date.now() - etapaDesde,
            leido,
            desde: PASOS[etapa],
            hasta: HASTA[etapa]
        }) : { step: etapa, progress: PASOS[etapa] });

        const contar = (log = '') => api(`/jobs/${trabajo.id}`, { ...estado(), log }).catch(() => {});

        const salir = async (texto) => {
            process.stdout.write(texto);
            todo += texto;
            pendiente += texto;
            const nueva = [...texto.matchAll(/::step:(\w+)/g)].pop()?.[1];
            if (nueva) {
                etapa = nueva;
                etapaDesde = Date.now();
                leido = null;
            }
            // El entrenador va contando sus pasos: de ahí sale el porcentaje de verdad.
            leido = leerAvance(texto, pasosPedidos) ?? leido;
            if (nueva || pendiente.length > 500) {
                const log = pendiente;
                pendiente = '';
                await contar(log);
            }
        };
        // Aunque el entrenador no escriba nada, cada tanto se avisa que sigue vivo y cuánto
        // lleva. Es la diferencia entre "faltan tres horas" y "esto se colgó y nadie avisó".
        const latido = setInterval(() => contar(), LATIDO);

        hijo.stdout.on('data', b => salir(b.toString()));
        hijo.stderr.on('data', b => salir(b.toString()));
        hijo.on('error', (e) => {
            clearInterval(latido);
            reject(e);
        });
        hijo.on('close', (code) => {
            clearInterval(latido);
            return code === 0 ? resolve(todo) :
                reject(new Error(`El pipeline terminó con código ${code}.`));
        });
    });
}

/** Sube el .sog por el mismo camino que usa el navegador. */
async function subir(trabajo, archivo) {
    const datos = await fs.readFile(archivo);
    const nombre = 'model.sog';
    const cfg = await api('/config');

    if (cfg.storage === 'blob') {
        const { upload } = await import('@vercel/blob/client');
        const blob = await upload(`${trabajo.id}/splat/${nombre}`, datos, {
            access: 'public',
            handleUploadUrl: `${BASE}/api/blob/upload`,
            contentType: 'application/octet-stream',
            headers: cookie ? { cookie } : {}
        });
        return blob.url;
    }

    const res = await fetch(`${BASE}/api/properties/${trabajo.id}/splat?name=${nombre}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...(cookie ? { cookie } : {}) },
        body: datos
    });
    if (!res.ok) throw new Error(`No pude subir el splat: HTTP ${res.status}`);
    return (await res.json()).url;
}

/** Baja el video y saca de ahí los cuadros nítidos, que hacen de fotos. */
async function desdeElVideo(trabajo, dir, opciones = {}) {
    await fs.mkdir(dir, { recursive: true });
    const destino = path.join(dir, '..', 'recorrido.mp4');
    // Si ya está bajado no se vuelve a bajar: la segunda pasada saca otros cuadros del mismo,
    // y una corrida que retoma después de un corte se lo encuentra hecho.
    if (!await fs.stat(destino).then(f => f.size > 0, () => false)) {
        await bajar(trabajo.video, destino, 'el video');
    }

    const avisar = async (texto) => {
        log(`  ${texto}`);
        await api(`/jobs/${trabajo.id}`, { step: 'eligiendo cuadros', progress: 12, log: `${texto}\n` }).catch(() => {});
    };
    const { total, elegidos } = await desdeVideo(destino, dir, { ...opciones, alAvanzar: avisar });
    log(`  ${elegidos} cuadros útiles de ${total}`);
    return elegidos;
}

/** Cuántas tomas entraron en el modelo, leído de lo que informó el pipeline. */
const cobertura = (texto) => {
    const m = [...texto.matchAll(/Fotos ubicadas en el modelo: (\d+) de (\d+)/g)].pop();
    return m ? { ubicadas: Number(m[1]), total: Number(m[2]) } : { ubicadas: 0, total: 0 };
};

/**
 * Calcula las cámaras y mira cuánta casa entró, antes de entrenar. Si entró poco vuelve a
 * sacar cuadros del video —todos, no uno de cada dos— y lo calcula de nuevo: más cuadros es
 * menos distancia entre uno y el siguiente, y esa distancia es justo lo que decide si dos
 * tomas se encadenan o el recorrido se parte en pedazos sueltos.
 *
 * Se entrena sobre el mejor de los dos. Medir cuesta minutos y entrenar cuesta horas, así que
 * entrenar sobre un modelo partido es tirar esas horas sabiendo que se van a tirar.
 */
async function mejorArranque(trabajo, base) {
    const probar = async (nombre, opciones) => {
        const fotos = path.join(base, `fotos-${nombre}`);
        const salida = path.join(base, `salida-${nombre}`);
        if (trabajo.video) await desdeElVideo(trabajo, fotos, opciones);
        else await bajarFotos(trabajo, fotos);
        const texto = await reconstruir(trabajo, fotos, salida, ['--solo-sfm']);
        const c = cobertura(texto);
        log(`  ${nombre}: ${c.ubicadas} de ${c.total} tomas ubicadas`);
        return { fotos, salida, ...c };
    };

    const normal = await probar('normal', {});
    // Con fotos sueltas no hay más cuadros que sacar, y con buena cobertura no hace falta.
    if (!trabajo.video || !normal.total || normal.ubicadas / normal.total >= 0.6) return normal;

    log('  entró menos de la mitad: pruebo con todos los cuadros del video');
    await api(`/jobs/${trabajo.id}`, {
        step: 'probando con más cuadros',
        progress: 35,
        log: '\nEntró poca casa en el modelo. Saco todos los cuadros del video y lo calculo de nuevo.\n'
    }).catch(() => {});
    const denso = await probar('denso', { objetivo: Infinity });
    return denso.ubicadas > normal.ubicadas ? denso : normal;
}

/**
 * La carpeta donde vive el material de este pedido. El nombre sale del pedido y no del azar,
 * para que una corrida que se cortó a la mitad —un apagón, un reinicio, el worker que se
 * cayó— se encuentre hecho lo que ya estaba hecho y no repita las horas de cálculo de
 * cámaras. Cuando se vuelve a pedir la reconstrucción desde el panel el pedido es otro, el
 * nombre cambia y ahí sí se arranca limpio: si no, un reintento a mano reusaría para siempre
 * el mismo modelo fallado, que es justo lo contrario de lo que se le pidió.
 */
async function carpetaDeTrabajo(trabajo) {
    const sello = String(trabajo.pedidoEn ?? '').replace(/\D/g, '') || 'suelto';
    const base = path.join(TRABAJOS, `${trabajo.id}-${sello}`);
    // Lo que quedó de pedidos viejos de esta misma propiedad ya no sirve y son cientos de
    // megas. Se compara el nombre entero y no por prefijo: "casa" no tiene que llevarse
    // puesta la carpeta de "casa-2".
    for (const nombre of await fs.readdir(TRABAJOS).catch(() => [])) {
        const m = /^(.*)-(?:\d+|suelto)$/.exec(nombre);
        if (m && m[1] === trabajo.id && nombre !== path.basename(base)) {
            await fs.rm(path.join(TRABAJOS, nombre), { recursive: true, force: true }).catch(() => {});
        }
    }
    await fs.mkdir(base, { recursive: true });
    return base;
}

async function procesar(trabajo) {
    const base = await carpetaDeTrabajo(trabajo);
    const dejarDormir = noDormir();
    let terminado = false;
    log(`▶ ${trabajo.titulo} (${trabajo.video ? 'video' : `${trabajo.fotos.length} fotos`})`);
    try {
        // Se reusa la misma carpeta entre intentos a propósito: el pipeline reconoce el
        // cálculo de cámaras que ya hizo y no lo repite, así un reintento cuesta minutos
        // y no vuelve a empezar de cero.
        for (let intento = 0; ; intento++) {
            const desde = Date.now();
            try {
                // El cálculo de cámaras del mejor intento ya quedó hecho acá adentro, así
                // que esta corrida lo reusa y va derecho a entrenar.
                const { fotos, salida } = await mejorArranque(trabajo, base);
                await reconstruir(trabajo, fotos, salida);
                const archivo = path.join(salida, 'model.sog');
                // El 3D ya está hecho y guardado en el disco: volver a subirlo cuesta segundos.
                // Rendirse acá por un corte de internet era tirar las horas que ya estaban hechas.
                const url = await porfiar(() => subir(trabajo, archivo),
                    { avisar: avisarReintento('subir el 3D') }).catch((e) => {
                    throw new Error(`${e.message}. El 3D terminado NO se perdió: quedó en ${archivo}`);
                });
                await porfiar(() => api(`/jobs/${trabajo.id}`,
                    { splatUrl: url, file: `${trabajo.id}/splat/model.sog` }),
                { avisar: avisarReintento('avisarle a la app que está listo') });
                terminado = true;
                log(`✔ ${trabajo.titulo} listo`);
                return;
            } catch (e) {
                if (intento >= REINTENTOS || Date.now() - desde >= RAPIDO) {
                    log(`✖ ${trabajo.titulo}: ${e.message}`);
                    await api(`/jobs/${trabajo.id}`, { error: e.message }).catch(() => {});
                    return;
                }
                const van = `${intento + 1} de ${REINTENTOS}`;
                // Se espera antes de volver a probar. Si lo que falló fue la conexión, repetir
                // en el mismo segundo falla por lo mismo: los tres intentos se consumían en un
                // suspiro sin darle tiempo a la red a volver.
                const espera = ESPERA_REINTENTO[Math.min(intento, ESPERA_REINTENTO.length - 1)];
                const seg = Math.round(espera / 1000);
                log(`⟳ ${trabajo.titulo}: ${e.message} — reintento ${van} en ${seg}s`);
                await api(`/jobs/${trabajo.id}`, {
                    step: `reintentando (${van})`,
                    log: `\n⟳ falló y lo reintento solo (${van}), en ${seg}s: ${e.message}\n`
                }).catch(() => {});
                await dormir(espera);
            }
        }
    } finally {
        dejarDormir();
        if (terminado) {
            // Con el 3D ya subido esto no sirve más, y son cientos de megas por propiedad.
            await fs.rm(base, { recursive: true, force: true }).catch(() => {});
        } else {
            // Queda para mirar qué pasó, y para que la corrida que retome no empiece de cero.
            log(`  material en ${base} — si el worker se corta, retoma desde ahí`);
        }
    }
}

log(`worker "${NOMBRE}" → ${BASE}`);
await entrar().catch((e) => {
    console.error(e.message);
    process.exit(1);
});

let anuncioDeCalma = true;
// En el primer pedido avisamos que esta sesión arranca de cero: lo que haya quedado marcado
// como en curso es de una corrida anterior que se cortó, y el servidor lo devuelve a la cola.
let reiniciado = true;
for (;;) {
    try {
        const trabajo = await api('/jobs/next', { worker: NOMBRE, reiniciado });
        reiniciado = false;
        if (trabajo) {
            anuncioDeCalma = true;
            await procesar(trabajo);
            continue;
        }
        if (anuncioDeCalma) {
            log('sin trabajos pendientes; esperando…');
            anuncioDeCalma = false;
        }
    } catch (e) {
        log(`problema hablando con la app: ${e.message}`);
    }
    await new Promise((resolve) => {
        setTimeout(resolve, ESPERA);
    });
}
