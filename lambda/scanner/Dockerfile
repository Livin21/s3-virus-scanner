FROM public.ecr.aws/lambda/nodejs:20

# Install ClamAV 1.4 (newer version compatible with current definitions)
RUN dnf update -y && \
    dnf -y install clamav1.4 clamd1.4 tar gzip ca-certificates && \
    dnf clean all && rm -rf /var/cache/dnf && \
    ln -s /etc/freshclam.conf /tmp/freshclam.conf

WORKDIR /var/task

# Copy app files
COPY package*.json ./
RUN npm ci --omit=dev
COPY clamd.conf /etc/clamd.conf
COPY . .

CMD ["index.handler"]
