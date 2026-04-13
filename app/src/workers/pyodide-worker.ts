/// <reference lib="webworker" />

import type { WorkerCommand, WorkerResponse } from '../types';
// @ts-expect-error - pyodide types don't fully match
import { loadPyodide as loadPyodideModule } from 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.mjs';

declare const self: DedicatedWorkerGlobalScope;

let pyodide: any = null;

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

const ECHEM_PARSE_SOURCE = `
import json
import sys
import io
import numpy as np
import pandas as pd
from pathlib import Path

# Column mapping from Biologic native names to common schema
_BIOLOGIC_COL_MAP = {
    "time/s": "time_s", "Ewe/V": "voltage_v", "<Ewe>/V": "voltage_v",
    "I/mA": "current_ma", "<I>/mA": "current_ma",
    "Q charge/discharge/mA.h": "capacity_mah", "half cycle": "half_cycle",
    "cycle number": "cycle_number", "freq/Hz": "frequency_hz",
    "Re(Z)/Ohm": "z_real_ohm", "-Im(Z)/Ohm": "z_imag_neg_ohm",
    "|Z|/Ohm": "z_mag_ohm", "Phase(Z)/deg": "z_phase_deg",
    "control/V/mA": "control_v_ma", "dq/mA.h": "dq_mah",
    "(Q-Qo)/mA.h": "capacity_offset_mah", "P/W": "power_w",
    "Ns": "sequence_number", "I Range": "current_range", "flags": "flags",
    "control/V": "control_v", "dQ/C": "dq_c", "(Q-Qo)/C": "capacity_offset_c",
    "|Energy|/W.h": "energy_wh", "Cs/\\u00b5F": "cs_uf", "Cp/\\u00b5F": "cp_uf",
}

_MACCOR_COL_MAP = {
    "Cyc#": "cycle_number", "Step": "step", "TestTime(s)": "time_s",
    "Capacity(Ah)": "capacity_ah", "Current(A)": "current_a",
    "Voltage(V)": "voltage_v", "Temp 1": "temperature_c",
}

_ARBIN_COL_MAP = {
    "Test Time (s)": "time_s", "Cycle Index": "cycle_number",
    "Current (A)": "current_a", "Voltage (V)": "voltage_v",
    "Charge Capacity (Ah)": "charge_capacity_ah",
    "Discharge Capacity (Ah)": "discharge_capacity_ah",
    "Aux_Temperature_1 (C)": "temperature_c",
}

_NEWARE_COL_MAP = {
    "Voltage": "voltage_v", "Current": "current_a", "Time": "time_s",
    "Cycle": "cycle_number", "Capacity": "capacity_ah",
    "half cycle": "half_cycle", "full cycle": "full_cycle",
}


def detect_file_type(filename, content_bytes):
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ("mpr", "mpt"):
        # Check magic bytes: ASCII exports start with "EC-Lab" even if saved as .mpr
        try:
            header = content_bytes[:32].decode("latin-1", errors="replace")
        except:
            header = ""
        if header.startswith("EC-Lab") or header.startswith("BT-Lab"):
            return "biologic_mpt"
        if ext == "mpt":
            return "biologic_mpt"
        return "biologic_mpr"
    if ext == "nda": return "neware_nda"
    if ext == "ndax": return "neware_ndax"
    if ext == "dta": return "gamry_dta"
    if ext in ("txt", "csv", "tsv"):
        try:
            text = content_bytes[:2048].decode("utf-8-sig", errors="replace")
        except:
            text = content_bytes[:2048].decode("latin-1", errors="replace")
        if "Today" in text.split("\\n")[0] and "Date" in text.split("\\n")[0]:
            return "maccor_txt"
        first_line = text.split("\\n")[0]
        if "Cycle Index" in first_line and "Voltage" in first_line:
            return "arbin_csv"
        fl = first_line.lower()
        if any(k in fl for k in ["freq", "z_real", "z'", "zreal"]):
            return "eis_csv"
        lines = text.strip().split("\\n")
        if len(lines) >= 3:
            try:
                vals = [float(x) for x in lines[0].split(",")]
                if len(vals) == 3 and vals[0] > 0:
                    return "eis_csv"
            except:
                pass
        return "generic_csv"
    return "generic_csv"


def detect_experiment_type(cols):
    s = set(cols)
    if {"frequency_hz", "z_real_ohm", "z_imag_ohm"}.issubset(s):
        return "eis"
    if "cycle_number" in s and "capacity_ah" in s:
        return "cycling"
    if "voltage_v" in s and "current_a" in s:
        return "cv"
    if "voltage_v" in s:
        return "ocv"
    return "unknown"


def parse_biologic_mpr(filepath):
    from galvani import BioLogic
    mpr = BioLogic.MPRfile(filepath)
    data = mpr.data
    df = pd.DataFrame({name: data[name] for name in data.dtype.names})
    df = _normalize_biologic_columns(df)
    meta = {}
    if hasattr(mpr, "timestamp"):
        meta["timestamp"] = str(mpr.timestamp)
    return df, meta


def parse_biologic_mpt(filepath):
    # EC-Lab ASCII export: header lines starting with metadata, then tab-separated data
    meta = {}
    with open(filepath, "r", encoding="latin-1") as f:
        lines = f.readlines()
    # Find "Nb header lines" to know where data starts
    n_header = 0
    for line in lines[:5]:
        if "Nb header lines" in line:
            parts = line.split(":")
            if len(parts) >= 2:
                n_header = int(parts[-1].strip())
            break
    if n_header == 0:
        # Fallback: find first line that looks like column headers (tab-separated)
        for i, line in enumerate(lines):
            if "\\t" in line and not line.startswith("EC-Lab") and not line.startswith("BT-Lab"):
                n_header = i
                break
    # Extract metadata from header
    for line in lines[:n_header]:
        if ":" in line and not line.startswith("EC-Lab") and not line.startswith("BT-Lab"):
            parts = line.split(":", 1)
            key = parts[0].strip()
            val = parts[1].strip() if len(parts) > 1 else ""
            if key and val and key != "Nb header lines":
                meta[key] = val
    # Parse data: header line is at n_header-1, data starts at n_header
    if n_header > 0 and n_header <= len(lines):
        header_line = lines[n_header - 1].strip()
        columns = [c.strip() for c in header_line.split("\\t")]
        data_lines = []
        for line in lines[n_header:]:
            parts = line.strip().split("\\t")
            if len(parts) == len(columns):
                try:
                    row = [float(p) for p in parts]
                    data_lines.append(row)
                except ValueError:
                    continue
        if data_lines:
            df = pd.DataFrame(data_lines, columns=columns)
        else:
            df = pd.DataFrame()
    else:
        # Try pandas fallback
        df = pd.read_csv(filepath, sep="\\t", encoding="latin-1", skiprows=n_header if n_header > 0 else 0)
    df = _normalize_biologic_columns(df)
    return df, meta


def _normalize_biologic_columns(df):
    rename = {k: v for k, v in _BIOLOGIC_COL_MAP.items() if k in df.columns}
    df = df.rename(columns=rename)
    if "current_ma" in df.columns:
        df["current_a"] = df["current_ma"] / 1000.0
    if "capacity_mah" in df.columns:
        df["capacity_ah"] = df["capacity_mah"] / 1000.0
    if "z_imag_neg_ohm" in df.columns:
        df["z_imag_ohm"] = -df["z_imag_neg_ohm"]
    if "cycle_number" not in df.columns and "half_cycle" in df.columns:
        df["cycle_number"] = (df["half_cycle"] + 1) // 2
    return df


def parse_neware(filepath):
    try:
        import navani.echem as ec
        df = ec.echem_file_loader(filepath)
        rename = {k: v for k, v in _NEWARE_COL_MAP.items() if k in df.columns}
        df = df.rename(columns=rename)
        return df, {}
    except ImportError:
        raise ImportError("Neware .nda/.ndax parsing requires the navani package which is not available in the browser. Please export your data as CSV from the Neware software and upload the CSV instead.")


def parse_gamry_dta(filepath):
    meta = {}
    with open(filepath, "r", encoding="latin-1") as f:
        lines = f.readlines()
    # Extract metadata from header
    for line in lines[:50]:
        parts = line.strip().split("\\t")
        if len(parts) >= 3:
            key = parts[0].strip()
            if key == "TITLE": meta["title"] = parts[2]
            elif key == "DATE": meta["date"] = parts[2]
            elif key == "TIME": meta["time"] = parts[2]
            elif key == "PSTAT": meta["instrument"] = parts[2]
    # Find ZCURVE data section
    zcurve_start = None
    for i, line in enumerate(lines):
        if line.strip().startswith("ZCURVE"):
            zcurve_start = i
            break
    if zcurve_start is None:
        raise ValueError("No ZCURVE section found in Gamry .DTA file")
    # Column header is 1 line after ZCURVE, units 2 lines after, data starts 3 lines after
    col_line = lines[zcurve_start + 1].strip().split("\\t")
    col_names = [c.strip() for c in col_line]
    # Read data rows until we hit a non-data line
    data_rows = []
    for line in lines[zcurve_start + 3:]:
        parts = line.strip().split("\\t")
        if len(parts) < 4:
            break
        try:
            row = [float(p) for p in parts[:len(col_names)]]
            data_rows.append(row)
        except ValueError:
            break
    if not data_rows:
        raise ValueError("No data found in ZCURVE section")
    raw = np.array(data_rows)
    # Map columns by name
    col_idx = {name: i for i, name in enumerate(col_names)}
    freq = raw[:, col_idx.get("Freq", 2)]
    zreal = raw[:, col_idx.get("Zreal", 3)]
    zimag = raw[:, col_idx.get("Zimag", 4)]
    df = pd.DataFrame({
        "frequency_hz": freq, "z_real_ohm": zreal, "z_imag_ohm": zimag,
        "z_mag_ohm": np.sqrt(zreal**2 + zimag**2),
        "z_phase_deg": np.degrees(np.arctan2(zimag, zreal)),
    })
    return df, meta


def parse_maccor(filepath):
    meta = {}
    with open(filepath, "r") as f:
        l1 = f.readline().strip()
        l2 = f.readline().strip()
    if "Today" in l1:
        parts = l1.split("\\t")
        if len(parts) >= 2: meta["export_date"] = parts[1]
    if "Date" in l2:
        parts = l2.split("\\t")
        if len(parts) >= 2: meta["test_date"] = parts[1]
    df = pd.read_csv(filepath, sep="\\t", skiprows=2)
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
    rename = {k: v for k, v in _MACCOR_COL_MAP.items() if k in df.columns}
    df = df.rename(columns=rename)
    return df, meta


def parse_arbin(filepath):
    df = pd.read_csv(filepath)
    rename = {k: v for k, v in _ARBIN_COL_MAP.items() if k in df.columns}
    df = df.rename(columns=rename)
    if "charge_capacity_ah" in df.columns and "discharge_capacity_ah" in df.columns:
        df["capacity_ah"] = df["charge_capacity_ah"] + df["discharge_capacity_ah"]
    return df, {}


def parse_eis_csv(filepath):
    # Try headerless 3-column CSV first (freq, Z_real, Z_imag)
    try:
        raw = np.loadtxt(filepath, delimiter=",")
        if raw.ndim == 2 and raw.shape[1] >= 3:
            df = pd.DataFrame({
                "frequency_hz": raw[:, 0], "z_real_ohm": raw[:, 1], "z_imag_ohm": raw[:, 2],
                "z_mag_ohm": np.sqrt(raw[:, 1]**2 + raw[:, 2]**2),
                "z_phase_deg": np.degrees(np.arctan2(raw[:, 2], raw[:, 1])),
            })
            return df, {}
    except Exception:
        pass
    # Fall back to pandas with header detection
    df = pd.read_csv(filepath)
    patterns = {
        "frequency_hz": ["freq", "f_hz"], "z_real_ohm": ["z_real", "zreal", "z'", "re"],
        "z_imag_ohm": ["z_imag", "zimag", "z''", "im"],
    }
    rename = {}
    for target, pats in patterns.items():
        for col in df.columns:
            if any(p in col.lower() for p in pats) and target not in rename.values():
                rename[col] = target
                break
    df = df.rename(columns=rename)
    if "z_real_ohm" in df.columns and "z_imag_ohm" in df.columns:
        df["z_mag_ohm"] = np.sqrt(df["z_real_ohm"]**2 + df["z_imag_ohm"]**2)
        df["z_phase_deg"] = np.degrees(np.arctan2(df["z_imag_ohm"], df["z_real_ohm"]))
    return df, {}


def parse_generic_csv(filepath):
    for sep in [",", "\\t", ";"]:
        try:
            df = pd.read_csv(filepath, sep=sep, nrows=5)
            if len(df.columns) > 1:
                df = pd.read_csv(filepath, sep=sep)
                break
        except:
            continue
    else:
        df = pd.read_csv(filepath)
    patterns = {
        "time_s": ["time", "elapsed"], "voltage_v": ["voltage", "potential", "ewe"],
        "current_a": ["current"], "capacity_ah": ["capacity", "cap"],
        "cycle_number": ["cycle", "cyc"], "frequency_hz": ["freq"],
        "z_real_ohm": ["z_real", "zreal", "z_re"], "z_imag_ohm": ["z_imag", "zimag"],
    }
    rename = {}
    for target, pats in patterns.items():
        for col in df.columns:
            cl = col.lower().strip()
            if any(p in cl for p in pats) and target not in rename.values():
                rename[col] = target
                break
    df = df.rename(columns=rename)
    return df, {}


PARSERS = {
    "biologic_mpr": parse_biologic_mpr,
    "biologic_mpt": parse_biologic_mpt,
    "neware_nda": parse_neware,
    "neware_ndax": parse_neware,
    "gamry_dta": parse_gamry_dta,
    "maccor_txt": parse_maccor,
    "arbin_csv": parse_arbin,
    "eis_csv": parse_eis_csv,
    "generic_csv": parse_generic_csv,
}


def parse_file(filepath, filename, content_bytes):
    ftype = detect_file_type(filename, content_bytes)
    parser = PARSERS.get(ftype, parse_generic_csv)
    df, meta = parser(filepath)
    exp_type = detect_experiment_type(df.columns.tolist())
    # Convert to JSON-serializable dict
    cols = df.columns.tolist()
    data_dict = {}
    for col in cols:
        vals = df[col].values
        if np.issubdtype(vals.dtype, np.floating):
            data_dict[col] = [float(v) if np.isfinite(v) else None for v in vals]
        elif np.issubdtype(vals.dtype, np.integer):
            data_dict[col] = [int(v) for v in vals]
        else:
            data_dict[col] = [str(v) for v in vals]
    return json.dumps({
        "columns": cols,
        "data": data_dict,
        "fileType": ftype,
        "experimentType": exp_type,
        "metadata": {str(k): str(v) for k, v in meta.items()},
        "rowCount": len(df),
    })


def run_analysis(command, params_json):
    params = json.loads(params_json)
    if command == "dqdv":
        from scipy.signal import savgol_filter
        v = np.array(params["voltage"])
        q = np.array(params["capacity"])
        window = params.get("smoothing_window", 51)
        if window % 2 == 0: window += 1
        window = min(window, len(v) - 1)
        if window < 5: window = 5
        q_smooth = savgol_filter(q, window, 3)
        dv = np.diff(v)
        dq = np.diff(q_smooth)
        mask = np.abs(dv) > 1e-10
        v_mid = (v[:-1] + v[1:]) / 2.0
        dqdv_vals = np.where(mask, dq / dv, 0.0)
        return json.dumps({
            "type": "dqdv",
            "data": {"voltage": v_mid[mask].tolist(), "dqdv": dqdv_vals[mask].tolist()}
        })
    elif command == "eis_fit":
        from scipy.optimize import least_squares
        freq = np.array(params["frequency"])
        zr = np.array(params["z_real"])
        zi = np.array(params["z_imag"])
        Z_data = zr + 1j * zi
        # Randles circuit: Z = R0 + 1/(1/R1 + j*w*C1) + Aw/sqrt(w)*(1-j)
        def randles(p, omega):
            R0, R1, C1, Aw = p
            Z_rc = R1 / (1 + 1j * omega * R1 * C1)
            Z_w = Aw / np.sqrt(omega) * (1 - 1j)
            return R0 + Z_rc + Z_w
        def residuals(p):
            omega = 2 * np.pi * freq
            Z_model = randles(p, omega)
            diff = Z_model - Z_data
            return np.concatenate([diff.real, diff.imag])
        R0_guess = np.min(zr)
        R1_guess = np.max(zr) - np.min(zr)
        guess = [max(R0_guess, 1e-10), max(R1_guess, 1e-10), 1e-6, max(R1_guess, 1e-10)]
        result_fit = least_squares(residuals, guess, bounds=(0, np.inf), method='trf')
        p_fit = result_fit.x
        omega = 2 * np.pi * freq
        Z_fit = randles(p_fit, omega)
        residual = float(np.sqrt(np.mean(np.abs(Z_data - Z_fit)**2)) / np.mean(np.abs(Z_data)))
        return json.dumps({
            "type": "eis_fit",
            "data": {
                "param_names": ["R0", "R1", "C1", "Aw"],
                "param_units": ["Ohm", "Ohm", "F", "Ohm/s^0.5"],
                "param_values": p_fit.tolist(),
                "z_fit_real": Z_fit.real.tolist(), "z_fit_imag": Z_fit.imag.tolist(),
                "residual_rmse": residual,
            }
        })
    elif command == "capacity_per_cycle":
        data = params["data"]
        df = pd.DataFrame(data)
        result = []
        if "charge_capacity_ah" in df.columns and "discharge_capacity_ah" in df.columns:
            for cyc, grp in df.groupby("cycle_number"):
                cc = grp["charge_capacity_ah"].max()
                dc = grp["discharge_capacity_ah"].max()
                ce = dc / cc if cc > 0 else None
                result.append({"cycle": int(cyc), "charge_cap_ah": float(cc),
                               "discharge_cap_ah": float(dc), "coulombic_efficiency": ce})
        elif "current_a" in df.columns and "capacity_ah" in df.columns:
            for cyc, grp in df.groupby("cycle_number"):
                if cyc == 0: continue
                charge = grp[grp["current_a"] > 0]
                discharge = grp[grp["current_a"] < 0]
                cc = abs(float(charge["capacity_ah"].max())) if len(charge) > 0 else 0
                dc = abs(float(discharge["capacity_ah"].max())) if len(discharge) > 0 else 0
                ce = dc / cc if cc > 0 else None
                result.append({"cycle": int(cyc), "charge_cap_ah": cc,
                               "discharge_cap_ah": dc, "coulombic_efficiency": ce})
        return json.dumps({"type": "capacity_per_cycle", "data": {"cycles": result}})
    elif command == "drt":
        freq = np.array(params["frequency"])
        zr = np.array(params["z_real"])
        zi = np.array(params["z_imag"])
        lam = params.get("lambda", 1e-3)
        n_tau = params.get("n_tau", 200)
        omega = 2 * np.pi * freq
        tau_min = 1.0 / (2*np.pi*freq.max()) / 10
        tau_max = 1.0 / (2*np.pi*freq.min()) * 10
        tau = np.logspace(np.log10(tau_min), np.log10(tau_max), n_tau)
        ln_tau = np.log(tau)
        d_ln_tau = np.diff(ln_tau)
        d_ln_tau = np.append(d_ln_tau, d_ln_tau[-1])
        og, tg = np.meshgrid(omega, tau, indexing="ij")
        A = 1.0 / (1.0 + 1j * og * tg) * d_ln_tau[np.newaxis, :]
        R_inf = zr[np.argmax(freq)]
        R_pol = zr[np.argmin(freq)] - R_inf
        zr_s = zr - R_inf
        A_stack = np.vstack([A.real, A.imag])
        z_stack = np.concatenate([zr_s, zi])
        n = n_tau
        L = np.zeros((n-2, n))
        for i in range(n-2):
            L[i, i] = 1; L[i, i+1] = -2; L[i, i+2] = 1
        ATA = A_stack.T @ A_stack
        ATb = A_stack.T @ z_stack
        gamma = np.linalg.solve(ATA + lam * R_pol**2 * L.T @ L, ATb)
        gamma = np.maximum(gamma, 0)
        gn = gamma / gamma.max() if gamma.max() > 0 else gamma
        return json.dumps({
            "type": "drt",
            "data": {"tau": tau.tolist(), "gamma": gamma.tolist(),
                     "gamma_normalized": gn.tolist(), "R_inf": float(R_inf)}
        })
    elif command == "simulate_circuit":
        from impedance.models.circuits import CustomCircuit
        freq = np.array(params["frequency"])
        circuit_str = params.get("circuit", "R0-p(R1,C1)-W1")
        p = np.array(params["parameters"])
        circuit = CustomCircuit(circuit_str, initial_guess=p.tolist())
        circuit.parameters_ = p
        Z = circuit.predict(freq)
        return json.dumps({
            "type": "simulate_circuit",
            "data": {
                "frequency": freq.tolist(),
                "z_real": Z.real.tolist(),
                "z_imag": Z.imag.tolist(),
                "circuit_string": circuit_str,
            }
        })
    elif command == "crop_frequencies":
        freq = np.array(params["frequency"])
        zr = np.array(params["z_real"])
        zi = np.array(params["z_imag"])
        fmin = params.get("freq_min")
        fmax = params.get("freq_max")
        mask = np.ones(len(freq), dtype=bool)
        if fmin is not None: mask &= freq >= fmin
        if fmax is not None: mask &= freq <= fmax
        return json.dumps({
            "type": "crop_frequencies",
            "data": {
                "frequency": freq[mask].tolist(),
                "z_real": zr[mask].tolist(),
                "z_imag": zi[mask].tolist(),
            }
        })
    elif command == "subtract_resistance":
        zr = np.array(params["z_real"])
        R = float(params["resistance"])
        return json.dumps({
            "type": "subtract_resistance",
            "data": {
                "z_real": (zr - R).tolist(),
                "z_imag": params["z_imag"],
            }
        })
    elif command == "kramers_kronig":
        from impedance.validation import linKK
        freq = np.array(params["frequency"])
        zr = np.array(params["z_real"])
        zi = np.array(params["z_imag"])
        Z = zr + 1j * zi
        c = params.get("c", 0.85)
        max_M = params.get("max_M", 50)
        M, mu, Z_fit, resids_real, resids_imag = linKK(freq, Z, c=c, max_M=max_M)
        return json.dumps({
            "type": "kramers_kronig",
            "data": {
                "M": int(M), "mu": float(mu), "valid": bool(mu < c),
                "z_fit_real": Z_fit.real.tolist(), "z_fit_imag": Z_fit.imag.tolist(),
                "resids_real": resids_real.tolist(), "resids_imag": resids_imag.tolist(),
            }
        })
    return json.dumps({"type": "error", "data": {"message": f"Unknown command: {command}"}})
`;

async function initPyodide() {
  post({ type: 'init_progress', message: 'Loading Pyodide runtime...' });

  pyodide = await loadPyodideModule({
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/',
  });

  post({ type: 'init_progress', message: 'Installing Python packages...' });
  await pyodide.loadPackage('micropip');
  const micropip = pyodide.pyimport('micropip');

  // Install core packages (available in Pyodide)
  await micropip.install(['numpy', 'pandas', 'scipy']);

  // Install galvani for Biologic .mpr parsing
  try {
    await micropip.install(['galvani']);
  } catch {
    console.warn('galvani not available in Pyodide');
  }

  post({ type: 'init_progress', message: 'Loading analysis engine...' });
  await pyodide.runPythonAsync(ECHEM_PARSE_SOURCE);

  post({ type: 'init_done' });
}

async function parseFile(id: string, filename: string, buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);

  // Sanitize filename for virtual filesystem (remove spaces/special chars from path)
  const safeBase = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const vfsPath = `/tmp/${safeBase}`;
  pyodide.FS.writeFile(vfsPath, bytes);

  // Pass original filename for type detection (extension matters), safe path for file access
  const resultJson = await pyodide.runPythonAsync(
    `parse_file(${JSON.stringify(vfsPath)}, ${JSON.stringify(filename)}, open(${JSON.stringify(vfsPath)}, "rb").read())`
  );

  const result = JSON.parse(resultJson);
  post({ type: 'parse_done', id, result });
}

async function runAnalysis(id: string, command: string, params: Record<string, unknown>) {
  const paramsJson = JSON.stringify(params);
  const resultJson = await pyodide.runPythonAsync(`
    run_analysis("${command}", '''${paramsJson}''')
  `);

  const result = JSON.parse(resultJson);
  post({ type: 'analyze_done', id, result });
}

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
        await initPyodide();
        break;
      case 'parse':
        await parseFile(msg.id, msg.filename, msg.buffer);
        break;
      case 'analyze':
        await runAnalysis(msg.id, msg.command, msg.params);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', id: 'id' in msg ? (msg as any).id : undefined, message });
  }
};
