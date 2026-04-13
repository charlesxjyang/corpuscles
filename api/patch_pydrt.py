"""Patch pyDRTtools __init__.py to skip GUI imports (PyQt5 not available in Docker)."""
import site
import os

pkg = os.path.join(site.getsitepackages()[0], "pyDRTtools", "__init__.py")
with open(pkg) as f:
    content = f.read()

for mod in ["cli", "GUI", "layout"]:
    old = f"from . import {mod}"
    new = f"try:\n    from . import {mod}\nexcept ImportError:\n    pass"
    content = content.replace(old, new)

with open(pkg, "w") as f:
    f.write(content)

print("Patched pyDRTtools __init__.py to skip GUI imports")
