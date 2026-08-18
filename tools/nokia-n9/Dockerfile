ARG POCKETJS_NOKIA_N9_BASE_IMAGE=debian:bullseye-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6
FROM ${POCKETJS_NOKIA_N9_BASE_IMAGE}

ARG POCKETJS_DEBIAN_SNAPSHOT
ARG POCKETJS_DEBIAN_SECURITY_SNAPSHOT
ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/apt/sources.list.d/* \
    && { \
        echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${POCKETJS_DEBIAN_SNAPSHOT}/ bullseye main"; \
        echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${POCKETJS_DEBIAN_SECURITY_SNAPSHOT}/ bullseye-security main"; \
    } > /etc/apt/sources.list \
    && dpkg --add-architecture i386 \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        binutils \
        ca-certificates \
        clang \
        file \
        g++ \
        gcc \
        jq \
        libc6:i386 \
        libfontconfig1 \
        libfreetype6 \
        libglib2.0-0 \
        libice6 \
        libdigest-sha-perl \
        libfile-copy-recursive-perl \
        libtext-template-perl \
        libtimedate-perl \
        libxml-simple-perl \
        libsm6 \
        libstdc++6:i386 \
        libx11-6 \
        libxext6 \
        libxrender1 \
        make \
        openssh-client \
        p7zip-full \
        patch \
        perl \
        unzip \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

ARG POCKETJS_NOKIA_N9_IMPLEMENTATION_SHA256
ARG POCKETJS_NOKIA_N9_TOOLCHAIN_VERSION
ENV POCKETJS_NOKIA_N9_IMAGE_IMPLEMENTATION_SHA256="${POCKETJS_NOKIA_N9_IMPLEMENTATION_SHA256}"

LABEL org.pocketjs.nokia-n9.toolchain="${POCKETJS_NOKIA_N9_TOOLCHAIN_VERSION}" \
      org.pocketjs.nokia-n9.implementation="${POCKETJS_NOKIA_N9_IMPLEMENTATION_SHA256}"

COPY tools/cli/nokia-n9-toolchain.json /opt/pocketjs/nokia-n9-toolchain.json
COPY tools/nokia-n9/container /opt/pocketjs/container
RUN chmod 0755 \
        /opt/pocketjs/container/pocketjs-nokia-n9-setup \
        /opt/pocketjs/container/pocketjs-nokia-n9-doctor \
        /opt/pocketjs/container/pocketjs-nokia-n9-build-probe \
        /opt/pocketjs/container/pocketjs-nokia-n9-build-app \
    && ln -s /opt/pocketjs/container/pocketjs-nokia-n9-setup /usr/local/bin/ \
    && ln -s /opt/pocketjs/container/pocketjs-nokia-n9-doctor /usr/local/bin/ \
    && ln -s /opt/pocketjs/container/pocketjs-nokia-n9-build-probe /usr/local/bin/ \
    && ln -s /opt/pocketjs/container/pocketjs-nokia-n9-build-app /usr/local/bin/

WORKDIR /work
