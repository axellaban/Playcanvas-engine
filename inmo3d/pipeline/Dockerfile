# Imagen con todo lo necesario para reconstruir: COLMAP + GLOMAP + OpenSplat + splat-transform.
# Construirla tarda un rato largo (compila COLMAP y OpenSplat desde fuente), pero se hace una sola vez.
#
#   docker build -t inmo3d-pipeline -f pipeline/Dockerfile pipeline
#   docker run --gpus all -v "$PWD/data:/data" inmo3d-pipeline \
#     --photos /data/mi-casa/photos --out /data/mi-casa/splat --trainer opensplat
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive TORCH_CUDA_ARCH_LIST="7.0;7.5;8.0;8.6;8.9;9.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake ninja-build build-essential curl ca-certificates unzip \
      libboost-program-options-dev libboost-graph-dev libboost-system-dev \
      libeigen3-dev libfreeimage-dev libmetis-dev libgoogle-glog-dev libgflags-dev \
      libsqlite3-dev libglew-dev qtbase5-dev libqt5opengl5-dev libcgal-dev \
      libceres-dev libflann-dev liblz4-dev \
    && rm -rf /var/lib/apt/lists/*

# Node, para @playcanvas/splat-transform (la compresión oficial a .sog).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && npm install -g @playcanvas/splat-transform && \
    rm -rf /var/lib/apt/lists/*

# COLMAP: Structure-from-Motion, calcula las poses de cámara de cada foto.
RUN git clone --depth 1 https://github.com/colmap/colmap.git /src/colmap && \
    cmake -S /src/colmap -B /src/colmap/build -GNinja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CUDA_ARCHITECTURES=native && \
    ninja -C /src/colmap/build install && rm -rf /src/colmap

# GLOMAP: mapper global, mismo resultado que COLMAP pero órdenes de magnitud más rápido.
RUN git clone --depth 1 https://github.com/colmap/glomap.git /src/glomap && \
    cmake -S /src/glomap -B /src/glomap/build -GNinja -DCMAKE_BUILD_TYPE=Release && \
    ninja -C /src/glomap/build install && rm -rf /src/glomap

# OpenSplat: entrenador de 3D Gaussian Splatting con licencia permisiva (AGPL-free).
RUN curl -fsSL https://download.pytorch.org/libtorch/cu124/libtorch-cxx11-abi-shared-with-deps-2.4.0%2Bcu124.zip \
      -o /tmp/libtorch.zip && unzip -q /tmp/libtorch.zip -d /opt && rm /tmp/libtorch.zip && \
    git clone --depth 1 https://github.com/pierotofy/OpenSplat /src/opensplat && \
    cmake -S /src/opensplat -B /src/opensplat/build -GNinja -DCMAKE_PREFIX_PATH=/opt/libtorch \
      -DCMAKE_BUILD_TYPE=Release && \
    ninja -C /src/opensplat/build && \
    install /src/opensplat/build/opensplat /usr/local/bin/ && \
    cp /src/opensplat/build/*.so* /usr/local/lib/ 2>/dev/null || true
ENV LD_LIBRARY_PATH=/opt/libtorch/lib:/usr/local/lib:$LD_LIBRARY_PATH

COPY reconstruct.sh /opt/inmo3d/reconstruct.sh
ENV INMO3D_TRAINER=opensplat INMO3D_SFM=glomap
ENTRYPOINT ["bash", "/opt/inmo3d/reconstruct.sh"]
