# Commonsense Survey Explorer ("report") — tiny standalone Python service.
#
# IMPORTANT: build this image with the **repository root** as the build context
# so it can access both the visualize app and statements/statements_1.csv:
#
#   docker build -f .scripts/visualize/Dockerfile -t commonsense-report .
#
# The data CSVs under .scripts/visualize/data/ must already be generated
# (run `python update-data.py` first) — they are copied into the image.

FROM --platform=linux/amd64 python:3.12-slim

WORKDIR /app

# System deps kept minimal; pandas/numpy/scipy ship manylinux wheels so no
# compiler toolchain is required.
RUN pip install --no-cache-dir \
      "pandas==2.3.3" \
      "numpy==2.3.5" \
      "scipy==1.16.3"

# App code + generated data (paths are relative to the repo-root build context)
COPY .scripts/visualize/server.py .scripts/visualize/utils.py ./
COPY .scripts/visualize/index.html ./index.html
COPY .scripts/visualize/static ./static
COPY .scripts/visualize/data ./data

# Vendor the statements file next to the app and point the server at it, so the
# container has no dependency on the repo's ../../ layout at runtime.
COPY statements/statements_1.csv ./statements_1.csv
ENV STATEMENTS_PATH=/app/statements_1.csv
ENV DATA_DIR=/app/data

EXPOSE 8080

CMD ["python", "server.py", "8080"]
