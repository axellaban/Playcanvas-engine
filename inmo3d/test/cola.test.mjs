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

    await t.test('no encola sin fotos suficientes', async () => {
        const r = await api(`/properties/${id}/reconstruct`, {});
        assert.equal(r.status, 400);
        assert.match(r.data.error, /al menos 20/);
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

        const worker = spawn('node', [path.join(ROOT, 'tools', 'worker.mjs')], {
            env: { ...process.env, INMO3D_URL: base, INMO3D_PIPELINE: stub, INMO3D_WORKER_POLL: '1', INMO3D_DATA: dataDir },
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
    });
});
