# Commonsense Survey Explorer ("report") — tiny standalone Python service.
#
# IMPORTANT: build this image with the **repository root** as the build context
# so it can access the visualize app, the statement-generation aggregation it
# depends on for the Design Point Coverage page, and the raw data tables:
#
#   docker build -f .scripts/visualize/Dockerfile -t commonsense-report .
#
# The data CSVs under .scripts/visualize/data/ must already be generated
# (run `python update-data.py` first) — they are copied into the image.

FROM --platform=linux/amd64 python:3.12-slim

WORKDIR /app

# System deps kept minimal; pandas/numpy/scipy ship manylinux wheels so no
# compiler toolchain is required. PyYAML is needed only to read
# statement-generation/prompt.yml's feature definitions.
RUN pip install --no-cache-dir \
      "pandas==2.3.3" \
      "numpy==2.3.5" \
      "scipy==1.16.3" \
      "PyYAML==6.0.2"

# App code + generated data (paths are relative to the repo-root build context)
COPY .scripts/visualize/server.py .scripts/visualize/utils.py .scripts/visualize/statement_coverage.py .scripts/visualize/statement_audit.py ./
COPY .scripts/visualize/index.html ./index.html
COPY .scripts/visualize/static ./static
COPY .scripts/visualize/data ./data

# statement-generation aggregation deps for the Design Point Coverage page:
# only the lightweight module and generated data statement_coverage.py reads —
# not generate.py/judge.py or their LLM-pipeline dependencies (openai,
# requests, etc.), which this read-only aggregation never imports.
COPY .scripts/statement-generation/gap_analysis.py .scripts/statement-generation/prompt.yml ./statement-generation/
COPY .scripts/statement-generation/data ./statement-generation/data
# Published-statement snapshot and its judge results for the audit page
# (statement_audit.py reads STATEMENT_GEN_DIR/existing/published).
COPY .scripts/statement-generation/existing ./statement-generation/existing

# Vendor the raw tables gap_analysis.py reads directly, next to the app (flat,
# not nested) so the container has no dependency on the repo's ../../ layout
# at runtime; REPO_ROOT/STATEMENT_GEN_DIR below point the app at them.
COPY statements/statements_1.csv ./statements/statements_1.csv
COPY statementproperties/statementproperties_1.csv ./statementproperties/statementproperties_1.csv
ENV STATEMENTS_PATH=/app/statements/statements_1.csv
ENV DATA_DIR=/app/data
ENV REPO_ROOT=/app
ENV STATEMENT_GEN_DIR=/app/statement-generation

EXPOSE 8080

CMD ["python", "server.py", "8080"]
