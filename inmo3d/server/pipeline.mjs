// Orquesta la reconstrucción: fotos -> SfM -> entrenamiento 3DGS -> .sog comprimido.
// El trabajo pesado lo hace pipeline/reconstruct.sh (COLMAP/GLOMAP + un entrenador
// de Gaussian Splatting + @playcanvas/splat-transform). Acá sólo lo lanzamos,
// seguimos su progreso y dejamos el resultado anotado en la propiedad.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, propDir, getProperty, saveProperty } from './store.mjs';

const running = new Map();   // id de propiedad -> proceso

const STEPS = ['preparando', 'sfm', 'entrenando', 'comprimiendo', 'listo'];

export function isRunning(id) {
    return running.has(id);
}

export async function start(id, opts = {}) {
    if (running.has(id)) throw new Error('Ya hay una reconstrucción en curso para esta propiedad.');
    const prop = await getProperty(id);
    if (!prop) throw new Error('Propiedad inexistente.');
    if (prop.photos.length < 20) {
        throw new Error(`Con ${prop.photos.length} fotos no alcanza. Subí al menos 20 (lo ideal: 80-200).`);
    }

    const dir = propDir(id);
    const logPath = path.join(dir, 'pipeline.log');
    await fs.writeFile(logPath, '');

    prop.job = {
        id: randomUUID(),
        status: 'running',
        step: 'preparando',
        progress: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        options: { sfm: opts.sfm, trainer: opts.trainer, steps: opts.steps }
    };
    await saveProperty(prop);

    const args = [
        path.join(ROOT, 'pipeline', 'reconstruct.sh'),
        '--photos', path.join(dir, 'photos'),
        '--out', path.join(dir, 'splat')
    ];
    if (opts.sfm) args.push('--sfm', String(opts.sfm));
    if (opts.trainer) args.push('--trainer', String(opts.trainer));
    if (opts.steps) args.push('--steps', String(opts.steps));

    const child = spawn('bash', args, { cwd: ROOT, env: { ...process.env } });
    running.set(id, child);

    const log = await fs.open(logPath, 'a');
    const onData = async (buf) => {
        const text = buf.toString();
        await log.write(text);
        // El script marca sus etapas con líneas "::step:<nombre>".
        for (const m of text.matchAll(/::step:(\w+)/g)) {
            const p = await getProperty(id);
            if (!p?.job) continue;
            p.job.step = m[1];
            p.job.progress = Math.round((STEPS.indexOf(m[1]) / (STEPS.length - 1)) * 100) || p.job.progress;
            await saveProperty(p);
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('close', async (code) => {
        running.delete(id);
        await log.close();
        const p = await getProperty(id);
        if (!p) return;
        const sog = path.join(dir, 'splat', 'model.sog');
        const ok = code === 0 && await fs.access(sog).then(() => true, () => false);
        p.job = {
            ...p.job,
            status: ok ? 'done' : 'error',
            step: ok ? 'listo' : p.job?.step ?? 'error',
            progress: ok ? 100 : p.job?.progress ?? 0,
            finishedAt: new Date().toISOString(),
            error: ok ? null : `El pipeline terminó con código ${code}. Mirá pipeline.log para el detalle.`
        };
        if (ok) p.scene.splat = 'splat/model.sog';
        await saveProperty(p);
    });

    return prop.job;
}

export function stop(id) {
    const child = running.get(id);
    if (!child) return false;
    child.kill('SIGTERM');
    return true;
}

export async function tail(id, bytes = 8000) {
    const file = path.join(propDir(id), 'pipeline.log');
    const buf = await fs.readFile(file).catch(() => Buffer.alloc(0));
    return buf.subarray(Math.max(0, buf.length - bytes)).toString();
}
