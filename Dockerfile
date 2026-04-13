FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libopenblas-dev liblapack-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/patch_pydrt.py /tmp/patch_pydrt.py
RUN python /tmp/patch_pydrt.py && rm /tmp/patch_pydrt.py

COPY python/echem_parse /app/echem_parse
COPY api/main.py /app/main.py

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
