# Echo in a container: backend + UI, llama.cpp (CUDA), the Python services, and the toolchain Strata compiles with.
# Models and data stay on the host (bind mounts in docker-compose.yml); nothing big is baked into the image.
# Needs an NVIDIA driver with CUDA 13 support (580 or newer) on the host.
FROM nvidia/cuda:13.4.2-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tzdata \
      python3 python3-venv python3-pip \
      build-essential cmake ninja-build \
      bubblewrap \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-por poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# llama.cpp, prebuilt for CUDA 13 (the CUDA runtime comes from the base image)
ARG LLAMA_BUILD=b11381
RUN mkdir -p vendor/llama.cpp /tmp/llama \
    && curl -fsSL "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/llama-${LLAMA_BUILD}-bin-ubuntu-cuda-13.4-x64.tar.gz" | tar -xz -C /tmp/llama \
    && mv "$(dirname "$(find /tmp/llama -name llama-server -type f | head -1)")" vendor/llama.cpp/llama-${LLAMA_BUILD} \
    && ln -s llama-${LLAMA_BUILD} vendor/llama.cpp/bin \
    && rm -rf /tmp/llama \
    && vendor/llama.cpp/bin/llama-server --version 2>&1 | tail -1 || true

# Strata at the release Echo's Flash-Next download is pinned to (downloads.ts FLASH_REV). Its engine is compiled on
# first use (Models tab → Build), because the build targets the GPU it finds. The folder is a named volume, so the
# build survives image updates.
ARG STRATA_VERSION=v0.1.38
RUN git clone -q --depth 1 --branch ${STRATA_VERSION} https://github.com/Niko1221/Strata vendor/Strata \
    && chmod -R a+rwX vendor/Strata

# Python services, each in its own venv (same layout as a native install)
COPY services/decision/requirements.txt services/decision/
COPY services/pyworkspace/requirements.txt services/pyworkspace/
COPY services/tts/requirements.txt services/tts/
RUN for s in decision pyworkspace tts; do \
      python3 -m venv services/$s/.venv && services/$s/.venv/bin/pip install -q --no-cache-dir -r services/$s/requirements.txt || exit 1; \
    done

# Node dependencies, then the app itself, then the UI build
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The container runs as the host user (docker-compose.yml), so files it writes in ~/Projects and data/ stay yours.
# That user needs a writable home for git, pip and npm caches.
RUN mkdir -m 0777 /home/echo && git config --system safe.directory '*'
ENV HOME=/home/echo

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -sf http://127.0.0.1:7777/api/models >/dev/null || exit 1
CMD ["node", "apps/server/src/main.ts"]
