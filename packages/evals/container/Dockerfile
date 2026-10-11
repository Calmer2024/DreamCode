ARG NODE_BASE=node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG PYTHON_BASE=python@sha256:a02e9c5406c416c504d6c9a1a306ff4080c3173f1008d192f953bd20382a2d5c
FROM ${NODE_BASE} AS node
FROM ${PYTHON_BASE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends bash git ripgrep rustc default-jdk-headless chromium ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python -m pip install --no-cache-dir urllib3==1.25.11 idna==2.10 chardet==3.0.4 certifi==2020.12.5 \
 && mkdir -p /workspace /home/agent /opt/eval \
 && chown -R 10001:10001 /workspace /home/agent
COPY playwright/ /opt/eval/
ENV HOME=/home/agent PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
WORKDIR /workspace
