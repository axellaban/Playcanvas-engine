#!/usr/bin/env bash
# Fotos -> nube de Gaussians -> .sog listo para PlayCanvas.
#
# Nos paramos sobre hombros de gigantes: COLMAP/GLOMAP resuelven las poses de cámara,
# un entrenador de 3D Gaussian Splatting (brush / OpenSplat / Nerfstudio) genera la nube,
# y @playcanvas/splat-transform la comprime al formato .sog que este motor carga nativo.
#
#   bash pipeline/reconstruct.sh --photos DIR --out DIR [--sfm glomap|colmap]
#        [--trainer brush|opensplat|nerfstudio] [--steps N] [--work DIR]
#
# Las etapas se anuncian con "::step:<nombre>" para que el servidor muestre el progreso.
set -euo pipefail

PHOTOS=""; OUT=""; WORK=""; SOLO_SFM=""
SFM="${INMO3D_SFM:-glomap}"
TRAINER="${INMO3D_TRAINER:-brush}"
STEPS="${INMO3D_STEPS:-15000}"
MATCHER="${INMO3D_MATCHER:-}"             # vacío: lo decide la cantidad de fotos

while [[ $# -gt 0 ]]; do
  case "$1" in
    --photos) PHOTOS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --sfm) SFM="$2"; shift 2 ;;
    --trainer) TRAINER="$2"; shift 2 ;;
    --steps) STEPS="$2"; shift 2 ;;
    --matcher) MATCHER="$2"; shift 2 ;;
    --solo-sfm) SOLO_SFM=1; shift ;;   # calcula las cámaras, informa cobertura y para
    *) echo "Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$PHOTOS" && -n "$OUT" ]] || { echo "Faltan --photos y --out" >&2; exit 2; }
WORK="${WORK:-$OUT/work}"
mkdir -p "$OUT" "$WORK"

have() { command -v "$1" >/dev/null 2>&1; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# Si una corrida anterior ya dejó el .sog terminado —se cortó la luz justo cuando lo subía, se
# reinició la máquina— no hay absolutamente nada que rehacer: son horas de entrenamiento que ya
# están pagadas y el archivo está ahí. Volver a entrenar sería tirarlas por una formalidad.
if [[ -z "$SOLO_SFM" && -s "$OUT/model.sog" ]]; then
  echo "Ya estaba hecho: reuso el model.sog que dejó la corrida anterior."
  echo "::step:listo"
  exit 0
fi

# Cuántas fotos ubicó un modelo; cero si esa carpeta no es un modelo.
cuantas() {
  local n
  n=$(colmap model_analyzer --path "$1" 2>&1 |
      sed -n 's/.*[Ii]mages: *\([0-9][0-9]*\).*/\1/p' | head -1 || true)
  echo "${n:-0}"
}

# Cuando el recorrido se le corta, COLMAP deja varios modelos sueltos (0, 1, 2…) en vez de
# uno. Agarrar el 0 sin mirar es quedarse con el primero que armó, que no es el más grande.
mejor_modelo() {
  local dir mejor="" n=0 c
  for dir in "$1"/*/; do
    [[ -f "${dir}cameras.bin" || -f "${dir}cameras.txt" ]] || continue
    c=$(cuantas "${dir%/}")
    if [[ "$c" -gt "$n" ]]; then n=$c; mejor="${dir%/}"; fi
  done
  echo "$mejor"
}

echo "::step:preparando"
N=$(find "$PHOTOS" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d '[:space:]')
echo "Fotos encontradas: $N"
[[ "$N" -ge 20 ]] || die "Hacen falta al menos 20 fotos (tenés $N)."
# Comparar todas las tomas contra todas es lo que más engancha, pero crece al cuadrado y con
# muchas fotos se vuelve eterno. Ahí el orden del video es información gratis: se comparan las
# vecinas más saltos cada vez más largos, que es lo que reencuentra un ambiente ya visitado.
if [[ -z "$MATCHER" ]]; then
  if [[ "$N" -le 200 ]]; then MATCHER=exhaustive; else MATCHER=sequential; fi
fi

have colmap || die "Falta COLMAP. Instalalo (brew install colmap / apt install colmap) o usá pipeline/Dockerfile."

# La compresión final usa splat-transform. Si no está instalado como programa, `npx` lo baja de
# internet — y eso pasa recién al final, después de las horas de entrenamiento. Un corte de
# conexión justo ahí tiraba la noche entera. Lo traemos ahora: si falta internet conviene
# enterarse en el minuto uno y no en la hora ocho. No corta la corrida, porque la conexión bien
# puede volver para cuando haga falta de verdad; sólo deja el aviso escrito.
if ! have splat-transform; then
  echo "Dejo lista la herramienta de compresión…"
  npx -y @playcanvas/splat-transform --version </dev/null >/dev/null 2>&1 ||
    echo "AVISO: no pude preparar splat-transform. Si al final tampoco hay internet, la compresión falla."
fi

# Qué sabe hacer este COLMAP: se lo preguntamos al binario en vez de suponerlo. El de
# Homebrew viene compilado sin CUDA, y no es que no pueda usar la GPU — ni siquiera
# conoce las opciones que la controlan, así que pasarle "--SiftExtraction.use_gpu 0" lo
# hace abortar antes de mirar una sola foto. Le preguntamos el menú a cada subcomando una
# vez y después armamos los argumentos con lo que figure ahí.
AYUDA_EXTRAER="$(colmap feature_extractor --help 2>&1 || true)"
AYUDA_EMPAREJAR="$(colmap "${MATCHER}_matcher" --help 2>&1 || true)"
AYUDA_MAPPER="$(colmap mapper --help 2>&1 || true)"

# "opción valor" si ese menú la tiene; nada si no. El `if` sin `else` devuelve éxito
# igual, que es lo que hace falta: bajo `set -e` un `&&` que falla cortaría el script.
si_acepta() { if grep -q -- "$2" <<<"$1"; then echo "$2 $3"; fi; }

if [[ -z "${INMO3D_GPU:-}" ]]; then
  if grep -qi "without GPU" <<<"$(colmap --help 2>&1 || true)"; then
    INMO3D_GPU=0
    echo "COLMAP sin soporte de GPU: uso CPU (más lento, mismo resultado)."
  else
    INMO3D_GPU=1
  fi
fi

# Sin comillas al usarlas más abajo: son valores fijos sin espacios, y cuando están
# vacías no tienen que ocupar un argumento.
OPC_EXTRAER="$(si_acepta "$AYUDA_EXTRAER" --SiftExtraction.use_gpu "$INMO3D_GPU")"
OPC_EMPAREJAR="$(si_acepta "$AYUDA_EMPAREJAR" --SiftMatching.use_gpu "$INMO3D_GPU")"
OPC_EMPAREJAR="$OPC_EMPAREJAR $(si_acepta "$AYUDA_EMPAREJAR" --SiftMatching.guided_matching 1)"
OPC_EMPAREJAR="$OPC_EMPAREJAR $(si_acepta "$AYUDA_EMPAREJAR" --SiftMatching.min_num_inliers 10)"
if [[ "$MATCHER" == sequential ]]; then
  OPC_EMPAREJAR="$OPC_EMPAREJAR $(si_acepta "$AYUDA_EMPAREJAR" --SequentialMatching.overlap 20)"
  OPC_EMPAREJAR="$OPC_EMPAREJAR $(si_acepta "$AYUDA_EMPAREJAR" --SequentialMatching.quadratic_overlap 1)"
fi

# Cuadros sacados de un video son material difícil: mucho menos detalle que una foto sacada
# a propósito, y la cámara se mueve entre uno y otro. Estas dos opciones hacen que la huella
# de cada punto aguante ese cambio de ángulo, que es justo lo que decide si dos tomas se
# enganchan. Sólo existen en el camino por CPU, y ahí cuestan segundos: al lado de las horas
# que dura el entrenamiento, es gratis.
if [[ "$INMO3D_GPU" == 0 ]]; then
  OPC_EXTRAER="$OPC_EXTRAER $(si_acepta "$AYUDA_EXTRAER" --SiftExtraction.estimate_affine_shape 1)"
  OPC_EXTRAER="$OPC_EXTRAER $(si_acepta "$AYUDA_EXTRAER" --SiftExtraction.domain_size_pooling 1)"
fi

DB="$WORK/database.db"
SPARSE="$WORK/sparse"
PROJECT="$WORK/project"     # layout estándar: project/images + project/sparse/0

# ------------------------------------------------------------------ 1. poses de cámara
echo "::step:sfm"
if [[ ! -d "$PROJECT/sparse/0" ]]; then
  rm -f "$DB"; mkdir -p "$SPARSE"

  colmap feature_extractor \
    --database_path "$DB" --image_path "$PHOTOS" \
    --ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_RADIAL \
    $OPC_EXTRAER

  colmap "${MATCHER}_matcher" --database_path "$DB" $OPC_EMPAREJAR

  MODELO=""; UBICADAS=0
  if [[ "$SFM" == "glomap" ]] && have glomap; then
    # GLOMAP resuelve la estructura global: mismo resultado que COLMAP pero mucho más rápido.
    glomap mapper --database_path "$DB" --image_path "$PHOTOS" --output_path "$SPARSE"
    MODELO="$(mejor_modelo "$SPARSE")"; UBICADAS=$(cuantas "$MODELO")
  else
    [[ "$SFM" == "glomap" ]] && echo "GLOMAP no está instalado: sigo con el mapper de COLMAP."
    # Armar el modelo es la parte barata —segundos, contra las horas del entrenamiento— y es
    # la que decide cuánta casa entra: casi todo depende de cuánta evidencia se le exige a una
    # toma para darla por buena. Si con lo normal queda medio recorrido afuera, se prueba otra
    # vez aflojando, y nos quedamos con el mejor intento. Quien filmó no vuelve a filmar: el
    # video es el que es y hay que sacarle lo que tenga, aunque salga apenas menos preciso.
    META=$(( N * 7 / 10 ))
    for NIVEL in 1 2 3; do
      # Cada nivel lleva el juego completo, nunca un agregado al anterior: COLMAP aborta si
      # recibe la misma opción dos veces, y así no hay forma de que se repita ninguna.
      case "$NIVEL" in
        1) AFLOJE="$(si_acepta "$AYUDA_MAPPER" --Mapper.init_min_num_inliers 50)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.abs_pose_min_num_inliers 15)" ;;
        2) AFLOJE="$(si_acepta "$AYUDA_MAPPER" --Mapper.init_min_num_inliers 30)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.abs_pose_min_num_inliers 10)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.min_num_matches 8)" ;;
        3) AFLOJE="$(si_acepta "$AYUDA_MAPPER" --Mapper.init_min_num_inliers 15)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.abs_pose_min_num_inliers 8)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.min_num_matches 5)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.filter_max_reproj_error 8)"
           AFLOJE="$AFLOJE $(si_acepta "$AYUDA_MAPPER" --Mapper.min_model_size 5)" ;;
      esac
      TANDA="$SPARSE/intento-$NIVEL"; mkdir -p "$TANDA"
      # Que un intento falle no es el final: queda el anterior, y todavía hay otro por probar.
      colmap mapper --database_path "$DB" --image_path "$PHOTOS" \
        --output_path "$TANDA" $AFLOJE || true
      CANDIDATO="$(mejor_modelo "$TANDA")"; CUANTAS=$(cuantas "$CANDIDATO")
      echo "Intento $NIVEL: $CUANTAS de $N tomas ubicadas."
      if [[ "$CUANTAS" -gt "$UBICADAS" ]]; then UBICADAS=$CUANTAS; MODELO="$CANDIDATO"; fi
      if [[ "$UBICADAS" -ge "$META" ]]; then break; fi
    done
  fi
  [[ -n "$MODELO" ]] || die "COLMAP no pudo ubicar ni una sola toma. Pasa cuando el video quedó \
entero movido, a oscuras, o es de algo sin relieve como una pared lisa."

  # Enderezamos la distorsión del lente: los entrenadores esperan cámaras PINHOLE.
  mkdir -p "$PROJECT"
  colmap image_undistorter --image_path "$PHOTOS" --input_path "$MODELO" \
    --output_path "$PROJECT" --output_type COLMAP

  # image_undistorter deja el modelo suelto en project/sparse, pero todo lo que viene
  # después lo busca en project/sparse/0, que es donde lo dejan mapper y glomap. Sin esto
  # el entrenador no encuentra las cámaras y el `if` de arriba nunca da por hecho el SfM,
  # así que cada reintento rehace la hora de cálculo que ya estaba hecha.
  if [[ ! -d "$PROJECT/sparse/0" ]]; then
    mkdir -p "$PROJECT/sparse/0"
    find "$PROJECT/sparse" -maxdepth 1 -type f \( -name '*.bin' -o -name '*.txt' \) \
      -exec mv {} "$PROJECT/sparse/0/" \;
  fi
else
  echo "Reutilizo el SfM ya calculado en $PROJECT"
fi

# Cuántas entraron de verdad. Que COLMAP termine bien no quiere decir que haya reconstruido la
# casa entera: con lo que no pudo enganchar arma lo que puede y sigue. Se informa para que se
# vea en el panel qué cobertura tiene el recorrido, pero no se frena por eso — el que filmó ya
# no está, y media casa en 3D es infinitamente mejor que un cartel de error.
REGISTRADAS=$(cuantas "$PROJECT/sparse/0")
echo "Fotos ubicadas en el modelo: $REGISTRADAS de $N"
if [[ "$REGISTRADAS" -lt $(( N / 2 )) ]]; then
  echo "Parte del recorrido no se pudo enganchar: el 3D va a cubrir sólo eso. Sigo igual."
fi

# Con --solo-sfm paramos acá. Sirve para probar una extracción de cuadros y ver cuánta casa
# entra antes de gastar horas entrenando: lo caro es el entrenamiento, no esto.
if [[ -n "$SOLO_SFM" ]]; then
  echo "::step:sfm-listo"
  exit 0
fi

# ------------------------------------------------------------------ 2. entrenamiento 3DGS
echo "::step:entrenando"
PLY="$OUT/model.ply"

if [[ -n "${INMO3D_TRAIN_CMD:-}" ]]; then
  # Escotilla de escape: comando propio con {project} {out} {steps}.
  CMD="${INMO3D_TRAIN_CMD//\{project\}/$PROJECT}"; CMD="${CMD//\{out\}/$PLY}"; CMD="${CMD//\{steps\}/$STEPS}"
  echo "+ $CMD"; eval "$CMD"
else
  case "$TRAINER" in
    brush)
      # https://github.com/ArthurBrussee/brush - Rust + wgpu: anda en NVIDIA, AMD, Apple y hasta en el navegador.
      have brush || die "Falta 'brush'. Bajalo de https://github.com/ArthurBrussee/brush/releases o usá --trainer opensplat."
      # --export-every igual a --total-steps: una sola exportación, la final. Por defecto
      # brush exporta cada 5000 pasos, y en una máquina modesta eso es tiempo regalado.
      echo "+ brush --total-steps $STEPS --export-path $OUT $PROJECT"
      brush --total-steps "$STEPS" --export-every "$STEPS" \
        --export-path "$OUT" --export-name "model.ply" "$PROJECT"
      ;;
    opensplat)
      # https://github.com/pierotofy/OpenSplat - C++, corre con CUDA, ROCm, Metal o CPU.
      have opensplat || die "Falta 'opensplat'. Compilalo o usá pipeline/Dockerfile."
      echo "+ opensplat $PROJECT -n $STEPS -o $PLY"
      opensplat "$PROJECT" -n "$STEPS" -o "$PLY"
      ;;
    nerfstudio)
      have ns-train || die "Falta Nerfstudio (pip install nerfstudio)."
      ns-train splatfacto --data "$PROJECT" --output-dir "$WORK/ns" \
        --max-num-iterations "$STEPS" --viewer.quit-on-train-completion True
      CFG=$(find "$WORK/ns" -name config.yml | sort | tail -1)
      [[ -n "$CFG" ]] || die "Nerfstudio no dejó config.yml."
      ns-export gaussian-splat --load-config "$CFG" --output-dir "$OUT"
      find "$OUT" -name 'splat.ply' -exec mv {} "$PLY" \;
      ;;
    *) die "Entrenador desconocido: $TRAINER" ;;
  esac
fi

# Cada entrenador nombra su salida a su manera (brush usa export_{iter}.ply si no se le
# fija el nombre). Si no está el que esperamos, tomamos el .ply más nuevo que haya dejado.
if [[ ! -f "$PLY" ]]; then
  ULTIMO=$(ls -t "$OUT"/*.ply 2>/dev/null | head -1)
  [[ -n "$ULTIMO" ]] && { echo "Uso el .ply que dejó el entrenador: $(basename "$ULTIMO")"; mv "$ULTIMO" "$PLY"; }
fi

[[ -f "$PLY" ]] || die "El entrenamiento no dejó ningún .ply en $OUT."
echo "PLY generado: $(du -h "$PLY" | cut -f1)"

# ------------------------------------------------------------------ 3. compresión a .sog
echo "::step:comprimiendo"
# splat-transform es la herramienta oficial de PlayCanvas (la misma que usa SuperSplat).
# .sog pesa ~10-20x menos que el .ply y este motor lo carga con streaming y LOD.
if have splat-transform; then
  splat-transform "$PLY" "$OUT/model.sog"
else
  npx -y @playcanvas/splat-transform "$PLY" "$OUT/model.sog"
fi

[[ -f "$OUT/model.sog" ]] || die "No se generó model.sog."
echo "SOG generado: $(du -h "$OUT/model.sog" | cut -f1)"
echo "::step:listo"
