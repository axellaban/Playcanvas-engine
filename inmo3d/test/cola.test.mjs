import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// El camino completo de la funcionalidad central: encolar desde la web, que el
// worker lo tome, entrene y suba el resultado, y que la propiedad quede recorrible.
// El entrenamiento real necesita GPU, así que acá el pipeline es de mentira: lo que
// se prueba es el circuito, que es lo que puede romperse sin que nadie se entere.
test('cola de reconstrucción: de la web al worker y de vuelta', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-cola-'));
    // El servidor real, no sólo la función: el worker se baja las fotos por /media.
    const puerto = 3200 + Math.floor(Math.random() * 500);
    const base = `http://127.0.0.1:${puerto}`;
    const server = spawn('node', [path.join(ROOT, 'server', 'index.mjs')], {
        env: { ...process.env, PORT: String(puerto), INMO3D_DATA: dataDir, VERCEL: '', INMO3D_ADMIN_TOKEN: '' },
        stdio: 'ignore'
    });
    t.after(async () => {
        server.kill();
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    for (let i = 0; i < 40; i++) {
        const vivo = await fetch(`${base}/api/config`).then(() => true, () => false);
        if (vivo) break;
        await new Promise((r) => {
            setTimeout(r, 250);
        });
    }

    const api = async (ruta, body) => {
        const res = await fetch(`${base}/api${ruta}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, data: await res.json() };
    };

    const { data: prop } = await api('/properties', { meta: { title: 'Casa en cola' } });
    const id = prop.id;

    await t.test('no encola sin material suficiente', async () => {
        const r = await api(`/properties/${id}/reconstruct`, {});
        assert.equal(r.status, 400);
        // Sin fotos ni video no hay con qué reconstruir, y el aviso tiene que nombrar
        // los dos caminos disponibles.
        assert.match(r.data.error, /foto/i);
        assert.match(r.data.error, /video/i);
    });

    // 20 fotos mínimas para que el pedido sea válido.
    const subidas = [];
    for (let i = 0; i < 20; i++) {
        const res = await fetch(`${base}/api/properties/${id}/photos?name=f${i}.jpg&register=0`, {
            method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: Buffer.from(`foto-${i}`)
        });
        subidas.push(await res.json());
    }
    await api(`/properties/${id}/attach`, { photos: subidas });

    await t.test('encola y queda pendiente', async () => {
        const r = await api(`/properties/${id}/reconstruct`, {});
        assert.equal(r.status, 202);
        assert.equal(r.data.status, 'pendiente');
        const repetido = await api(`/properties/${id}/reconstruct`, {});
        assert.equal(repetido.status, 400, 'no se encola dos veces');
    });

    await t.test('el worker lo toma, entrena y sube el resultado', async () => {
        // Pipeline de mentira: escribe un model.sog como lo haría el de verdad.
        const stub = path.join(dataDir, 'pipeline-falso.sh');
        await fs.writeFile(stub, [
            '#!/usr/bin/env bash',
            'set -e',
            'while [[ $# -gt 0 ]]; do case "$1" in --out) OUT="$2"; shift 2;; *) shift;; esac; done',
            'echo "::step:sfm"', 'echo "::step:entrenando"', 'echo "::step:comprimiendo"',
            'mkdir -p "$OUT"', 'printf "sog-de-prueba" > "$OUT/model.sog"', 'echo "::step:listo"'
        ].join('\n'));
        await fs.chmod(stub, 0o755);

        // El material de trabajo va a una carpeta nuestra y no a la de verdad del usuario.
        const trabajos = path.join(dataDir, 'trabajos');
        const worker = spawn('node', [path.join(ROOT, 'tools', 'worker.mjs')], {
            env: {
                ...process.env,
                INMO3D_URL: base,
                INMO3D_PIPELINE: stub,
                INMO3D_WORKER_POLL: '1',
                INMO3D_DATA: dataDir,
                INMO3D_TRABAJOS: trabajos
            },
            stdio: 'ignore'
        });
        t.after(() => worker.kill());

        const limite = Date.now() + 30000;
        let final;
        while (Date.now() < limite) {
            const { data } = await api(`/properties/${id}/job`);
            if (data.job?.status === 'listo' || data.job?.status === 'error') {
                final = data;
                break;
            }
            await new Promise((r) => {
                setTimeout(r, 400);
            });
        }
        assert.ok(final, 'el worker tiene que terminar el trabajo');
        assert.equal(final.job.status, 'listo', final.job?.error ?? '');
        assert.equal(final.job.progress, 100);
        assert.equal(final.worker.conectado, true, 'el worker se anuncia como vivo');

        const { data: lista } = await api(`/properties/${id}`);
        assert.ok(lista.scene.splatUrl, 'la propiedad queda con su escena');
        const sog = await fetch(lista.scene.splatUrl.startsWith('http') ?
            lista.scene.splatUrl : `${base}${lista.scene.splatUrl}`);
        assert.equal(await sog.text(), 'sog-de-prueba', 'el .sog subido es el que generó el pipeline');

        // Mientras dura, el trabajo deja cuadros, base de datos y modelos: cientos de megas por
        // propiedad. Se guardan a propósito para poder retomar si se corta, pero una vez que el
        // 3D está arriba no sirven más, y si no se limpian llenan el disco de la máquina.
        assert.deepEqual(await fs.readdir(trabajos).catch(() => []), [],
            'el material de trabajo se limpia cuando el 3D ya quedó subido');
    });
});

// Con un video no hacen falta las 20 fotos: los cuadros salen de ahí.
test('un video alcanza para encolar', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-video-'));
    const puerto = 3700 + Math.floor(Math.random() * 200);
    const base = `http://127.0.0.1:${puerto}`;
    const server = spawn('node', [path.join(ROOT, 'server', 'index.mjs')], {
        env: { ...process.env, PORT: String(puerto), INMO3D_DATA: dataDir, VERCEL: '', INMO3D_ADMIN_TOKEN: '' },
        stdio: 'ignore'
    });
    t.after(async () => {
        server.kill();
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    for (let i = 0; i < 40; i++) {
        if (await fetch(`${base}/api/config`).then(() => true, () => false)) break;
        await new Promise((r) => {
            setTimeout(r, 250);
        });
    }

    const creada = await fetch(`${base}/api/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { title: 'Casa filmada' } })
    });
    const { id } = await creada.json();

    const subido = await fetch(`${base}/api/properties/${id}/video?name=recorrido.mp4`, {
        method: 'POST', headers: { 'content-type': 'video/mp4' }, body: Buffer.from('no-es-un-video-real')
    });
    assert.equal(subido.status, 201);

    const encolado = await fetch(`${base}/api/properties/${id}/reconstruct`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(encolado.status, 202, 'con video no se piden 20 fotos');

    const tomado = await fetch(`${base}/api/jobs/next`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker: 'test' })
    });
    const trabajo = await tomado.json();
    assert.ok(trabajo.video, 'el trabajo le pasa el video al worker');

    const encolarDeNuevo = () => fetch(`${base}/api/properties/${id}/reconstruct`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });

    // Con el worker trabajándola de verdad, pedirla otra vez sería largar dos corridas.
    assert.equal((await encolarDeNuevo()).status, 400, 'mientras se reconstruye no se encola de nuevo');

    // Se corta el worker a la mitad y vuelve a arrancar. El trabajo quedó marcado como en
    // curso pero no lo está corriendo nadie: apagar y prender tiene que alcanzar para que lo
    // retome. Antes quedaba trabado media hora y el botón sólo decía "ya está en la cola".
    const retomado = await fetch(`${base}/api/jobs/next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worker: 'test', reiniciado: true })
    });
    assert.equal((await retomado.json())?.id, id, 'un worker que reinicia retoma lo que quedó colgado');

    // Y si la Mac no vuelve a prenderse, el botón tampoco puede quedar trabado para siempre.
    const archivo = path.join(dataDir, id, 'property.json');
    const guardada = JSON.parse(await fs.readFile(archivo, 'utf8'));
    const haceRato = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    guardada.job = { ...guardada.job, status: 'corriendo', tomadoEn: haceRato, visto: haceRato };
    await fs.writeFile(archivo, JSON.stringify(guardada));
    assert.equal((await encolarDeNuevo()).status, 202, 'un trabajo sin señales se puede volver a pedir');
});
