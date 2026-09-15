# Pipeline de reconstrucción

Convierte una carpeta de fotos en `model.sog`, el formato comprimido de Gaussian Splatting
que el motor de este repo carga de forma nativa (con streaming y LOD).

```
fotos/*.jpg
   │
   ├─ COLMAP  feature_extractor → matcher            (qué punto de una foto es cuál en las otras)
   ├─ GLOMAP  mapper                                  (posición y orientación de cada cámara)
   ├─ COLMAP  image_undistorter                       (saca la distorsión del lente)
   ├─ brush / OpenSplat / Nerfstudio                  (entrena la nube de gaussians → model.ply)
   └─ @playcanvas/splat-transform                     (comprime → model.sog, 10-20x más liviano)
```

## Correrlo

```bash
bash pipeline/reconstruct.sh --photos data/mi-casa/photos --out data/mi-casa/splat
```

O desde el panel web (botón **Reconstruir en 3D**), que es lo mismo pero con barra de progreso.

## Opciones

| Flag | Valores | Para qué |
|---|---|---|
| `--sfm` | `glomap` (default), `colmap` | GLOMAP es mucho más rápido en sets grandes |
| `--trainer` | `brush` (default), `opensplat`, `nerfstudio` | quién entrena la nube |
| `--steps` | `15000` | más pasos = más nitidez y más tiempo |
| `--matcher` | `exhaustive` (default), `sequential` | usá `sequential` si las fotos salen de un video |

Variables útiles: `INMO3D_GPU=0` fuerza CPU en COLMAP, e `INMO3D_TRAIN_CMD` reemplaza por completo
el comando de entrenamiento (placeholders `{project}`, `{out}`, `{steps}`) si preferís otro entrenador.

## Sin GPU

Entrenar un splat sin GPU es inviable en la práctica. Dos caminos:

1. **Entrenar afuera y subir el resultado.** Cualquier `.ply`, `.compressed.ply`, `.spz` o `.sog`
   sirve: en el panel, botón **Subir splat**. Sirven los exports de
   [SuperSplat](https://superspl.at), Polycam, Luma, Scaniverse, Postshot o Nerfstudio.
2. **Alquilar una GPU por hora** y correr `pipeline/Dockerfile` ahí.

## Entrenadores

- [brush](https://github.com/ArthurBrussee/brush) — Rust + wgpu, anda en NVIDIA, AMD y Apple Silicon.
- [OpenSplat](https://github.com/pierotofy/OpenSplat) — C++/libtorch, CUDA, ROCm, Metal o CPU.
- [Nerfstudio `splatfacto`](https://docs.nerf.studio) — el más configurable.

Los flags de CLI cambian entre versiones; si uno no coincide, usá `INMO3D_TRAIN_CMD`.
