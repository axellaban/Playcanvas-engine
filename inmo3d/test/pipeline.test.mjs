// El pipeline es un script de shell que orquesta binarios ajenos, y ahí el riesgo no es
// la lógica: es que una versión distinta de COLMAP, ffmpeg o el entrenador cambie o saque
// una opción. Eso no se ve leyendo el código y se paga caro (una hora de espera para que
// falle en el primer paso). Así que lo corremos entero contra binarios de mentira que se
// comportan como los peores casos reales.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const correr = promisify(execFile);
const RAIZ = path.resolve(import.meta.dirname, '..');

/** Un COLMAP compilado sin CUDA: no conoce las opciones de GPU y aborta si se las pasan. */
const COLMAP_SIN_GPU = `#!/usr/bin/env bash
sub="\${1:-}"; shift || true
if [[ "$sub" == "--help" || -z "$sub" ]]; then
  echo "COLMAP 3.11.1 (with CUDA without GPU support)"; exit 0
fi
for a in "$@"; do
  case "$a" in
    --SiftExtraction.use_gpu|--SiftMatching.use_gpu)
      echo "Failed to parse options - unrecognised option '$a'." >&2; exit 1 ;;
  esac
done
[[ " $* " == *" --help "* ]] && { echo "Options:"; exit 0; }
case "$sub" in
  mapper) for a in "$@"; do [[ -n "\${cap:-}" ]] && mkdir -p "$a/0" && unset cap; [[ "$a" == "--output_path" ]] && cap=1; done ;;
  image_undistorter) for a in "$@"; do [[ -n "\${cap:-}" ]] && mkdir -p "$a/sparse/0" && unset cap; [[ "$a" == "--output_path" ]] && cap=1; done ;;
  model_analyzer) echo "Images: 25" ;;
esac
exit 0
`;

const BRUSH = `#!/usr/bin/env bash
out=""; name=""
while [[ $# -gt 0 ]]; do case "$1" in
  --export-path) out="$2"; shift 2 ;; --export-name) name="$2"; shift 2 ;; *) shift ;;
esac; done
printf 'ply' > "$out/$name"
`;

const TRANSFORM = `#!/usr/bin/env bash
printf 'sog' > "$2"
`;

async function preparar() {
    const base = await mkdtemp(path.join(tmpdir(), 'inmo3d-pipe-'));
    const bin = path.join(base, 'bin');
    const fotos = path.join(base, 'fotos');
    await mkdir(bin, { recursive: true });
    await mkdir(fotos, { recursive: true });
    for (const [nombre, cuerpo] of [['colmap', COLMAP_SIN_GPU], ['brush', BRUSH], ['splat-transform', TRANSFORM]]) {
        const f = path.join(bin, nombre);
        await writeFile(f, cuerpo);
        await chmod(f, 0o755);
    }
    // El pipeline exige 20 fotos como mínimo antes de arrancar.
    for (let i = 0; i < 25; i++) await writeFile(path.join(fotos, `cuadro-${i}.jpg`), '');
    return { base, bin, fotos, salida: path.join(base, 'out') };
}

test('el pipeline llega al .sog con un COLMAP sin soporte de GPU', async () => {
    const { base, bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'
    ], { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

    await access(path.join(salida, 'model.sog'));
    assert.match(stdout, /::step:listo/, 'tendría que anunciar todas las etapas hasta el final');
    assert.match(stdout, /sin soporte de GPU/, 'y avisar que cae a CPU');
    assert.ok(base);
});

test('sin fotos suficientes falla temprano y lo dice', async () => {
    const { bin, base, salida } = await preparar();
    const vacio = path.join(base, 'pocas');
    await mkdir(vacio, { recursive: true });
    await assert.rejects(
        correr('bash', [path.join(RAIZ, 'pipeline', 'reconstruct.sh'), '--photos', vacio, '--out', salida],
            { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }),
        e => /al menos 20 fotos/.test(e.stderr));
});
