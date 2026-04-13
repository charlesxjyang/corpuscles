FROM python:3.11-slim

# System deps for cvxopt, numpy, scipy
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libopenblas-dev liblapack-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY python/echem_parse /app/echem_parse
COPY api/main.py /app/main.py

# Patch pyDRTtools to skip GUI imports
RUN python -c "
import site, os
pkg = os.path.join(site.getsitepackages()[0], 'pyDRTtools', '__init__.py')
with open(pkg) as f: content = f.read()
content = content.replace('from . import cli', 'try:\\n    from . import cli\\nexcept ImportError:\\n    pass')
content = content.replace('from . import GUI', 'try:\\n    from . import GUI\\nexcept ImportError:\\n    pass')
content = content.replace('from . import layout', 'try:\\n    from . import layout\\nexcept ImportError:\\n    pass')
with open(pkg, 'w') as f: f.write(content)
print('Patched pyDRTtools __init__.py')
"

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
