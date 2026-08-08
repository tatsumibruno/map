# Base image for running agentctl as a coordinator or an agent worker.
#
# It deliberately contains no AI-provider credentials. Authenticate inside the
# container's tmux session yourself, exactly as you would on the host.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agentctl

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY dist ./dist
COPY README.md LICENSE ./

RUN ln -s /opt/agentctl/dist/bin/agentctl.js /usr/local/bin/agentctl \
  && chmod +x /opt/agentctl/dist/bin/agentctl.js

# The shared project state directory is mounted here.
WORKDIR /work
ENV AGENTCTL_HOME=/work/.agentctl-home

ENTRYPOINT ["agentctl"]
CMD ["doctor"]
