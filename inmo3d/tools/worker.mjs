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

/** Se baja las fotos de la propiedad a una carpeta temporal. */
async function bajarFotos(trabajo, dir) {
    await fs.mkdir(dir, { recursive: true });
    let n = 0;
    for (const foto of trabajo.fotos) {
        const url = foto.url.startsWith('http') ? foto.url : `${BASE}${foto.url}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`No pude bajar ${foto.file} (HTTP ${res.status})`);
        await fs.writeFile(path.join(dir, foto.file), Buffer.from(await res.arrayBuffer()));
        if (++n % 20 === 0) await api(`/jobs/${trabajo.id}`, { step: 'bajando fotos', progress: Math.round(n / trabajo.fotos.length * 10) });
    }
    return n;
}

/** Corre reconstruct.sh y traduce sus etapas en avance para el panel. */
function reconstruir(trabajo, fotos, salida) {
    const PASOS = { preparando: 15, sfm: 30, entrenando: 60, comprimiendo: 90, listo: 100 };
    // Se puede apuntar a otro script (o a uno de prueba) sin tocar el worker.
    const script = process.env.INMO3D_PIPELINE || path.join(ROOT, 'pipeline', 'reconstruct.sh');
    const args = [script, '--photos', fotos, '--out', salida];
    for (const [flag, valor] of [['--sfm', trabajo.opciones.sfm], ['--trainer', trabajo.opciones.trainer],
        ['--steps', trabajo.opciones.steps]]) {
        if (valor) args.push(flag, String(valor));
    }

    return new Promise((resolve, reject) => {
        const hijo = spawn('bash', args, { cwd: ROOT });
        let pendiente = '';
        const salir = async (texto) => {
            process.stdout.write(texto);
            pendiente += texto;
            const etapa = [...texto.matchAll(/::step:(\w+)/g)].pop()?.[1];
            if (etapa || pendiente.length > 500) {
                const log = pendiente;
                pendiente = '';
                await api(`/jobs/${trabajo.id}`, { step: etapa, progress: PASOS[etapa], log }).catch(() => {});
            }
        };
        hijo.stdout.on('data', b => salir(b.toString()));
        hijo.stderr.on('data', b => salir(b.toString()));
        hijo.on('error', reject);
        hijo.on('close', code => (code === 0 ? resolve() : reject(new Error(`El pipeline terminó con código ${code}.`))));
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
async function desdeElVideo(trabajo, dir) {
    await fs.mkdir(dir, { recursive: true });
    const destino = path.join(dir, '..', 'recorrido.mp4');
    const res = await fetch(trabajo.video.startsWith('http') ? trabajo.video : `${BASE}${trabajo.video}`);
    if (!res.ok) throw new Error(`No pude bajar el video (HTTP ${res.status})`);
    await fs.writeFile(destino, Buffer.from(await res.arrayBuffer()));

    const avisar = async (texto) => {
        log(`  ${texto}`);
        await api(`/jobs/${trabajo.id}`, { step: 'eligiendo cuadros', progress: 12, log: `${texto}\n` }).catch(() => {});
    };
    const { total, elegidos } = await desdeVideo(destino, dir, { alAvanzar: avisar });
    log(`  ${elegidos} cuadros útiles de ${total}`);
    return elegidos;
}

async function procesar(trabajo) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), `inmo3d-${trabajo.id}-`));
    const fotos = path.join(base, 'fotos');
    const salida = path.join(base, 'salida');
    const dejarDormir = noDormir();
    log(`▶ ${trabajo.titulo} (${trabajo.video ? 'video' : `${trabajo.fotos.length} fotos`})`);
    try {
        // Se reusa la misma carpeta entre intentos a propósito: el pipeline reconoce el
        // cálculo de cámaras que ya hizo y no lo repite, así un reintento cuesta minutos
        // y no vuelve a empezar de cero.
        for (let intento = 0; ; intento++) {
            const desde = Date.now();
            try {
                if (trabajo.video) await desdeElVideo(trabajo, fotos);
                else await bajarFotos(trabajo, fotos);
                await reconstruir(trabajo, fotos, salida);
                const url = await subir(trabajo, path.join(salida, 'model.sog'));
                await api(`/jobs/${trabajo.id}`, { splatUrl: url, file: `${trabajo.id}/splat/model.sog` });
                log(`✔ ${trabajo.titulo} listo`);
                return;
            } catch (e) {
                if (intento >= REINTENTOS || Date.now() - desde >= RAPIDO) {
                    log(`✖ ${trabajo.titulo}: ${e.message}`);
                    await api(`/jobs/${trabajo.id}`, { error: e.message }).catch(() => {});
                    return;
                }
                const van = `${intento + 1} de ${REINTENTOS}`;
                log(`⟳ ${trabajo.titulo}: ${e.message} — reintento ${van}`);
                await api(`/jobs/${trabajo.id}`, {
                    step: `reintentando (${van})`,
                    log: `\n⟳ falló y lo reintento solo (${van}): ${e.message}\n`
                }).catch(() => {});
            }
        }
    } finally {
        dejarDormir();
        // El material queda por si hay que mirar qué pasó; se limpia solo al reiniciar la máquina.
        log(`  material en ${base}`);
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
