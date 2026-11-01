# syntax=docker/dockerfile:1
# Market Research batch runner. Stateless: every run reads and writes R2 only.
# Base image pinned by digest; Dependabot/Renovate keeps it current.
FROM python:3.15-slim@sha256:94d3426f1def7db4a106a232ac121bfd975393e5dfd40a619b955fae45fe7913 AS build

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.lock /tmp/requirements.lock
# Optional: behind a TLS-intercepting proxy, pass its CA with
#   docker build --secret id=pip_ca,src=/path/to/ca.pem ...
# The secret is only mounted for this step and never stored in the image.
RUN --mount=type=secret,id=pip_ca \
    if [ -s /run/secrets/pip_ca ]; then export PIP_CERT=/run/secrets/pip_ca; fi; \
    pip install --require-hashes --no-deps -r /tmp/requirements.lock
COPY pyproject.toml README.md /src/
COPY pipeline /src/pipeline
# The package adds no dependencies of its own: everything above came from the hash-pinned lock.
RUN pip install --no-deps --no-build-isolation /src

FROM python:3.15-slim@sha256:94d3426f1def7db4a106a232ac121bfd975393e5dfd40a619b955fae45fe7913

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    TMPDIR=/tmp
COPY --from=build /opt/venv /opt/venv
RUN groupadd --system --gid 10001 mr && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin mr
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["market-research"]
CMD ["--help"]
