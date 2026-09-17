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

/**
 * Un COLMAP de mentira que imita al de Homebrew en lo que importa: está compilado sin CUDA
 * (ni conoce las opciones de GPU), deja el modelo suelto en sparse/ y no en sparse/0, y puede
 * terminar bien habiendo ubicado una fracción de las fotos. Cuántas ubica cada intento se fija
 * desde afuera con INMO3D_TEST_REG1/2/3, y el número viaja con el modelo: así el que se elige
 * al final es el que se informa, y el test puede notar si se agarró el intento equivocado.
 */
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
# El de verdad aborta si le mandan la misma opción dos veces, sin mirar una sola foto. Por
# ahí se coló un bug que dejó los reintentos sin efecto, así que el de mentira hace lo mismo.
vistas=""
for a in "$@"; do
  case "$a" in --*)
    case " $vistas " in *" $a "*)
      echo "Failed to parse options - option '$a' cannot be specified more than once." >&2
      exit 1 ;;
    esac
    vistas="$vistas $a" ;;
  esac
done
# El menú de cada subcomando, sin las de GPU: es lo que el pipeline consulta antes de usarlas.
if [[ " $* " == *" --help "* ]]; then
  echo "Options:"
  case "$sub" in
    feature_extractor) echo "  --SiftExtraction.estimate_affine_shape
  --SiftExtraction.domain_size_pooling
  --SiftExtraction.peak_threshold" ;;
    *_matcher) echo "  --SiftMatching.guided_matching
  --SiftMatching.min_num_inliers
  --SequentialMatching.overlap
  --SequentialMatching.quadratic_overlap" ;;
    mapper) echo "  --Mapper.init_min_num_inliers
  --Mapper.abs_pose_min_num_inliers
  --Mapper.min_num_matches
  --Mapper.filter_max_reproj_error
  --Mapper.min_model_size" ;;
  esac
  exit 0
fi

# El valor que sigue a una opción, o vacío.
arg() { local q="$1" c=""; shift; for a in "$@"; do
  [[ -n "$c" ]] && { echo "$a"; return; }; [[ "$a" == "$q" ]] && c=1; done; }

case "$sub" in
  feature_extractor) echo "extractor opciones: $*" ;;&
  mapper)
    out="$(arg --output_path "$@")"
    echo "mapper opciones: $*"
    case "$out" in
      *intento-1) n="\${INMO3D_TEST_REG1:-25}" ;;
      *intento-2) n="\${INMO3D_TEST_REG2:-\${INMO3D_TEST_REG1:-25}}" ;;
      *)          n="\${INMO3D_TEST_REG3:-\${INMO3D_TEST_REG2:-\${INMO3D_TEST_REG1:-25}}}" ;;
    esac
    mkdir -p "$out/0"; : > "$out/0/cameras.bin"
    if [[ -n "\${INMO3D_TEST_PARTIDO:-}" ]]; then
      # El recorrido se le cortó: arma varios pedazos y los numera por orden, no por tamaño.
      echo 3 > "$out/0/cuantas.txt"
      mkdir -p "$out/1"; : > "$out/1/cameras.bin"; echo "$n" > "$out/1/cuantas.txt"
    else
      echo "$n" > "$out/0/cuantas.txt"
    fi ;;
  image_undistorter)
    inp="$(arg --input_path "$@")"; out="$(arg --output_path "$@")"
    mkdir -p "$out/sparse"; : > "$out/sparse/cameras.bin"; : > "$out/sparse/images.bin"
    [[ -f "$inp/cuantas.txt" ]] && cp "$inp/cuantas.txt" "$out/sparse/cuantas.txt" ;;
  model_analyzer)
    ruta="$(arg --path "$@")"
    [[ -d "$ruta" ]] || { echo "ERROR: modelo inexistente" >&2; exit 1; }
    if [[ -f "$ruta/cuantas.txt" ]]; then echo "Images: $(cat "$ruta/cuantas.txt")"
    else echo "Images: \${INMO3D_TEST_REG1:-25}"; fi ;;
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
    // Si el modelo no quedó en sparse/0, model_analyzer falla y acá aparecería un "?".
    assert.match(stdout, /Fotos ubicadas en el modelo: 25 de 25/, 'y dejar el modelo donde se lo busca');
    assert.doesNotMatch(stdout, /Intento 2/, 'si el primer intento ubicó todo, no insiste al pedo');
    assert.ok(base);
});

test('con medio modelo afuera insiste, y termina el .sog igual', async () => {
    // COLMAP puede terminar con código 0 habiendo ubicado cuatro tomas de veinticinco: arma lo
    // que puede y descarta el resto sin quejarse. Frenar ahí sería devolverle el problema a
    // quien filmó, que no va a volver a filmar. Se afloja y se reintenta; si aun así entra poco,
    // se entrena con eso: media casa en 3D vale más que un cartel de error.
    const { bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'
    ], { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INMO3D_TEST_REG1: '4' } });

    await access(path.join(salida, 'model.sog'));
    assert.match(stdout, /Intento 3/, 'tendría que agotar los reintentos antes de conformarse');
    assert.match(stdout, /mapper opciones:.*--Mapper\.abs_pose_min_num_inliers 10/,
        'y aflojarle de verdad al mapper, no sólo reintentar lo mismo');
    assert.match(stdout, /Fotos ubicadas en el modelo: 4 de 25/, 'y decir con cuánto se quedó');
    assert.match(stdout, /Parte del recorrido no se pudo enganchar/, 'avisando de la cobertura');
    assert.match(stdout, /::step:listo/, 'pero llegando hasta el final');
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

test('si aflojando entran más tomas, se queda con ese intento y para ahí', async () => {
    // El primer intento ubica 4 de 25 y el segundo 20: la escalada tiene que llegar al segundo
    // y frenar ahí, sin gastar el tercero de gusto.
    const { bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'
    ], { cwd: RAIZ,
        env: { ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            INMO3D_TEST_REG1: '4',
            INMO3D_TEST_REG2: '20' } });

    assert.match(stdout, /Intento 1: 4 de 25/, 'el primero se queda corto');
    assert.match(stdout, /Intento 2: 20 de 25/, 'el segundo rescata el resto');
    assert.doesNotMatch(stdout, /Intento 3/, 'y con eso alcanza: no sigue insistiendo');
    await access(path.join(salida, 'model.sog'));
});

test('se queda con el mejor intento, aunque el último salga peor', async () => {
    // Aflojar no siempre mejora: el tercer intento puede ubicar menos que el segundo. Lo que
    // se entrena tiene que ser el mejor modelo que se consiguió, no el último que se probó.
    const { bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'
    ], { cwd: RAIZ,
        env: { ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            INMO3D_TEST_REG1: '4',
            INMO3D_TEST_REG2: '12',
            INMO3D_TEST_REG3: '2' } });

    assert.match(stdout, /Intento 3: 2 de 25/, 'prueba los tres porque ninguno alcanza la meta');
    assert.match(stdout, /Fotos ubicadas en el modelo: 12 de 25/, 'pero entrena con el mejor');
    await access(path.join(salida, 'model.sog'));
});

test('cuando el recorrido se parte en pedazos, agarra el más grande', async () => {
    // COLMAP numera los pedazos por orden de armado: el 0 es el primero que consiguió cerrar,
    // que bien puede ser el más chico. Quedarse con ese es tirar la mayor parte de la casa.
    const { bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'
    ], {
        cwd: RAIZ,
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            INMO3D_TEST_PARTIDO: '1',
            INMO3D_TEST_REG1: '18'
        }
    });

    assert.match(stdout, /Fotos ubicadas en el modelo: 18 de 25/, 'el pedazo grande, no el primero');
    await access(path.join(salida, 'model.sog'));
});

test('con --solo-sfm calcula las cámaras, informa y para antes de entrenar', async () => {
    // Medir cuánta casa entra cuesta minutos; entrenar cuesta horas. El worker mide primero,
    // y si entró poco vuelve a sacar cuadros del video antes de gastar esas horas.
    const { bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap', '--solo-sfm'
    ], { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

    assert.match(stdout, /Fotos ubicadas en el modelo: 25 de 25/, 'informa la cobertura');
    assert.match(stdout, /::step:sfm-listo/, 'y avisa que terminó esa parte');
    assert.doesNotMatch(stdout, /::step:entrenando/, 'pero no arranca a entrenar');
    await assert.rejects(access(path.join(salida, 'model.sog')), 'ni deja un resultado final');
});

test('si el .sog ya está hecho, no vuelve a entrenar', async () => {
    // Un apagón justo cuando subía el archivo terminado no puede costar otra noche entera: el
    // resultado está ahí, en el disco. Hay que reconocerlo y seguir, no rehacerlo por prolijidad.
    const { bin, fotos, salida } = await preparar();
    const entorno = { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
    const args = [path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'];
    await correr('bash', args, entorno);
    await access(path.join(salida, 'model.sog'));

    const { stdout } = await correr('bash', args, entorno);
    assert.match(stdout, /Ya estaba hecho/, 'tendría que reconocer el trabajo terminado');
    assert.match(stdout, /::step:listo/, 'y darlo por listo');
    assert.doesNotMatch(stdout, /::step:entrenando/, 'sin volver a entrenar horas al pedo');
});

test('medir la cobertura nunca se saltea, aunque haya un .sog viejo', async () => {
    // El atajo de arriba vale sólo para la corrida completa. --solo-sfm existe justamente para
    // volver a medir cuánta casa entra: si se salteara por un .sog de antes, dejaría de medir
    // en el único momento en que se lo llama, y el worker elegiría a ciegas con qué entrenar.
    const { bin, fotos, salida } = await preparar();
    const entorno = { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
    const base = [path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'];
    await correr('bash', base, entorno);

    const { stdout } = await correr('bash', [...base, '--solo-sfm'], entorno);
    assert.match(stdout, /::step:sfm-listo/, 'tiene que medir igual');
    assert.match(stdout, /Fotos ubicadas en el modelo: 25 de 25/, 'e informar la cobertura');
    assert.doesNotMatch(stdout, /Ya estaba hecho/, 'el atajo no es para medir');
});

test('le pide a cada cuadro más puntos reconocibles de los que pide de fábrica', async () => {
    // Un cuadro de video es más blando que una foto sacada a propósito. Con el umbral de fábrica
    // cada cuadro entregaba entre 600 y 1300 puntos cuando tendría que entregar miles, y con
    // pocos puntos no hay enganche posible entre dos tomas: la casa se reconstruye en pedazos.
    const { bin, fotos, salida } = await preparar();
    const { stdout } = await correr('bash', [
        path.join(RAIZ, 'pipeline', 'reconstruct.sh'),
        '--photos', fotos, '--out', salida, '--sfm', 'colmap'
    ], { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.match(stdout, /extractor opciones:.*--SiftExtraction\.peak_threshold 0\.004/);
});

test('con muchos cuadros sigue comparando todos contra todos', async () => {
    // Acá se partía el recorrido sin decir una palabra. En una casa se sale de un ambiente y se
    // vuelve más tarde; comparando sólo con las tomas vecinas, nada reconoce que es el mismo
    // lugar. Con 275 cuadros el tope viejo de 200 mandaba justo a ese camino.
    const { bin, base, salida } = await preparar();
    const muchas = path.join(base, 'muchas');
    await mkdir(muchas, { recursive: true });
    await Promise.all(Array.from({ length: 275 }, (_, i) => writeFile(path.join(muchas, `c${i}.jpg`), '')));
    const entorno = { cwd: RAIZ, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
    const args = ['--photos', muchas, '--out', salida, '--sfm', 'colmap', '--solo-sfm'];

    const { stdout } = await correr('bash', [path.join(RAIZ, 'pipeline', 'reconstruct.sh'), ...args], entorno);
    assert.match(stdout, /Comparación entre tomas: exhaustive \(275 cuadros/);

    // Y por arriba del tope sigue habiendo un límite: comparar todas contra todas crece al
    // cuadrado, y con miles de cuadros no termina nunca.
    const bajo = { ...entorno, env: { ...entorno.env, INMO3D_EXHAUSTIVO: '100' } };
    const otro = await correr('bash',
        [path.join(RAIZ, 'pipeline', 'reconstruct.sh'), ...args, '--out', path.join(base, 'o2')], bajo);
    assert.match(otro.stdout, /Comparación entre tomas: sequential/);
});
