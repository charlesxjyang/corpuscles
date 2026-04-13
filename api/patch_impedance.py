"""Patch impedance.py validation.py to include numpy in eval namespace."""
import site
import os

pkg_dir = site.getsitepackages()[0]
val_path = os.path.join(pkg_dir, "impedance", "validation.py")

with open(val_path) as f:
    content = f.read()

# The eval call needs numpy in its namespace
old = "return eval(circuit_string, circuit_elements)"
new = """import numpy as np
    ce = dict(circuit_elements)
    ce['np'] = np
    return eval(circuit_string, ce)"""

if old in content:
    content = content.replace(old, new)
    with open(val_path, "w") as f:
        f.write(content)
    print("Patched impedance validation.py to include numpy in eval namespace")
else:
    print("impedance validation.py already patched or has different code")
