"""Unified electrochemical data parser.

Auto-detects file type from extension and magic bytes, parses into a common
DataFrame schema with standardized column names. Supports Biologic .mpr/.mpt,
Neware .nda/.ndax, Gamry .DTA, Maccor text exports, Arbin CSV, and generic
CSV with auto-detected columns.

Common schema columns (not all present for every technique):
  - time_s: float (seconds from start)
  - voltage_v: float (working electrode potential in volts)
  - current_a: float (current in amps)
  - capacity_ah: float (cumulative capacity in amp-hours)
  - cycle_number: int
  - z_real_ohm: float (real impedance for EIS)
  - z_imag_ohm: float (imaginary impedance, NEGATIVE convention)
  - frequency_hz: float (for EIS)
  - temperature_c: float (if available)
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Optional
import numpy as np
import pandas as pd


class FileType(Enum):
    BIOLOGIC_MPR = "biologic_mpr"
    BIOLOGIC_MPT = "biologic_mpt"
    NEWARE_NDA = "neware_nda"
    NEWARE_NDAX = "neware_ndax"
    GAMRY_DTA = "gamry_dta"
    MACCOR_TXT = "maccor_txt"
    ARBIN_CSV = "arbin_csv"
    EIS_CSV = "eis_csv"
    GENERIC_CSV = "generic_csv"


class ExperimentType(Enum):
    EIS = "eis"
    CYCLING = "cycling"
    CV = "cv"
    CHRONOAMPEROMETRY = "ca"
    CHRONOPOTENTIOMETRY = "cp"
    OCV = "ocv"
    UNKNOWN = "unknown"


@dataclass
class ParseResult:
    """Result of parsing an electrochemical data file."""
    data: pd.DataFrame
    file_type: FileType
    experiment_type: ExperimentType
    metadata: dict = field(default_factory=dict)
    raw_columns: list = field(default_factory=list)


# Magic bytes for file type detection
_BIOLOGIC_MAGIC = b"BIO-LOGIC MODULAR FILE"
_NEWARE_NDA_MAGIC = b"NEWARE"


def detect_file_type(filepath: str, content: Optional[bytes] = None) -> FileType:
    """Detect file type from extension and magic bytes."""
    ext = filepath.rsplit(".", 1)[-1].lower() if "." in filepath else ""

    if content is None:
        with open(filepath, "rb") as f:
            content = f.read(2048)

    if ext == "mpr":
        return FileType.BIOLOGIC_MPR
    if ext == "mpt":
        return FileType.BIOLOGIC_MPT
    if ext == "nda":
        return FileType.NEWARE_NDA
    if ext == "ndax":
        return FileType.NEWARE_NDAX
    if ext == "dta":
        return FileType.GAMRY_DTA

    # For text/CSV files, inspect content to distinguish formats
    if ext in ("txt", "csv", "tsv"):
        try:
            text = content.decode("utf-8-sig", errors="replace")
        except Exception:
            text = content.decode("latin-1", errors="replace")

        # Maccor: first line starts with "Today''s Date" or has Maccor-style header
        if "Today''s Date" in text or "Today's Date" in text:
            return FileType.MACCOR_TXT

        first_line = text.split("\n")[0]

        # Arbin CSV: has columns like "Cycle Index", "Step Index", "Voltage (V)"
        if "Cycle Index" in first_line and "Voltage (V)" in first_line:
            return FileType.ARBIN_CSV

        # EIS CSV: columns with frequency, Z_real, Z_imag patterns
        fl = first_line.lower()
        if any(k in fl for k in ["freq", "z_real", "z'", "zreal", "z_re"]):
            return FileType.EIS_CSV

        # EIS CSV without header: 3 columns of numbers (freq, Z_real, Z_imag)
        lines = text.strip().split("\n")
        if len(lines) >= 3:
            try:
                first_vals = [float(x) for x in lines[0].split(",")]
                if len(first_vals) == 3:
                    # Check if first column looks like frequency (positive, decreasing or increasing)
                    second_vals = [float(x) for x in lines[1].split(",")]
                    if first_vals[0] > 0 and second_vals[0] > 0:
                        return FileType.EIS_CSV
            except (ValueError, IndexError):
                pass

        return FileType.GENERIC_CSV

    if ext == "mpr":
        return FileType.BIOLOGIC_MPR

    return FileType.GENERIC_CSV


def _detect_experiment_type(df: pd.DataFrame, file_type: FileType) -> ExperimentType:
    """Infer experiment type from available columns."""
    cols = set(df.columns)
    if {"frequency_hz", "z_real_ohm", "z_imag_ohm"}.issubset(cols):
        return ExperimentType.EIS
    if "cycle_number" in cols and "capacity_ah" in cols:
        return ExperimentType.CYCLING
    if "voltage_v" in cols and "current_a" in cols:
        vrange = df["voltage_v"].max() - df["voltage_v"].min()
        if vrange > 0.1 and "capacity_ah" not in cols:
            return ExperimentType.CV
    if "voltage_v" in cols and "current_a" not in cols:
        return ExperimentType.OCV
    return ExperimentType.UNKNOWN


# ---------------------------------------------------------------------------
# Biologic .mpr parser
# ---------------------------------------------------------------------------

# Column name mapping from Biologic native names to our common schema
_BIOLOGIC_COL_MAP = {
    "time/s": "time_s",
    "Ewe/V": "voltage_v",
    "<Ewe>/V": "voltage_v",
    "Ewe/mV": "voltage_mv",
    "I/mA": "current_ma",
    "<I>/mA": "current_ma",
    "control/V/mA": "control_v_ma",
    "Q charge/discharge/mA.h": "capacity_mah",
    "(Q-Qo)/mA.h": "capacity_offset_mah",
    "dq/mA.h": "dq_mah",
    "half cycle": "half_cycle",
    "cycle number": "cycle_number",
    "freq/Hz": "frequency_hz",
    "Re(Z)/Ohm": "z_real_ohm",
    "-Im(Z)/Ohm": "z_imag_neg_ohm",
    "|Z|/Ohm": "z_mag_ohm",
    "Phase(Z)/deg": "z_phase_deg",
    "Cs/µF": "cs_uf",
    "Cp/µF": "cp_uf",
    "P/W": "power_w",
    "|Energy|/W.h": "energy_wh",
    "Ns": "sequence_number",
    "I Range": "current_range",
    "flags": "flags",
    "dQ/C": "dq_c",
    "(Q-Qo)/C": "capacity_offset_c",
    "control/V": "control_v",
    "control/mA": "control_ma",
}


def _parse_biologic_mpr(filepath: str) -> ParseResult:
    from galvani import BioLogic

    mpr = BioLogic.MPRfile(filepath)
    raw_data = mpr.data
    df = pd.DataFrame({name: raw_data[name] for name in raw_data.dtype.names})
    raw_columns = df.columns.tolist()

    # Rename columns to common schema
    rename_map = {}
    for orig, target in _BIOLOGIC_COL_MAP.items():
        if orig in df.columns:
            rename_map[orig] = target
    df = df.rename(columns=rename_map)

    # Convert units to standard
    if "current_ma" in df.columns:
        df["current_a"] = df["current_ma"] / 1000.0
    if "capacity_mah" in df.columns:
        df["capacity_ah"] = df["capacity_mah"] / 1000.0
    if "voltage_mv" in df.columns and "voltage_v" not in df.columns:
        df["voltage_v"] = df["voltage_mv"] / 1000.0

    # For EIS: convert -Im(Z) to Im(Z) with negative convention
    if "z_imag_neg_ohm" in df.columns:
        df["z_imag_ohm"] = -df["z_imag_neg_ohm"]

    # Infer cycle number from half_cycle if not present
    if "cycle_number" not in df.columns and "half_cycle" in df.columns:
        df["cycle_number"] = (df["half_cycle"] + 1) // 2

    metadata = {}
    if hasattr(mpr, "timestamp"):
        metadata["timestamp"] = str(mpr.timestamp)

    exp_type = _detect_experiment_type(df, FileType.BIOLOGIC_MPR)
    return ParseResult(
        data=df,
        file_type=FileType.BIOLOGIC_MPR,
        experiment_type=exp_type,
        metadata=metadata,
        raw_columns=raw_columns,
    )


# ---------------------------------------------------------------------------
# Biologic .mpt parser (text export)
# ---------------------------------------------------------------------------

def _parse_biologic_mpt(filepath: str) -> ParseResult:
    from galvani import BioLogic

    mpt = BioLogic.MPTfile(filepath)
    df = pd.DataFrame(mpt.data) if hasattr(mpt, 'data') else pd.DataFrame()
    raw_columns = df.columns.tolist()

    rename_map = {}
    for orig, target in _BIOLOGIC_COL_MAP.items():
        if orig in df.columns:
            rename_map[orig] = target
    df = df.rename(columns=rename_map)

    if "current_ma" in df.columns:
        df["current_a"] = df["current_ma"] / 1000.0
    if "capacity_mah" in df.columns:
        df["capacity_ah"] = df["capacity_mah"] / 1000.0
    if "z_imag_neg_ohm" in df.columns:
        df["z_imag_ohm"] = -df["z_imag_neg_ohm"]
    if "cycle_number" not in df.columns and "half_cycle" in df.columns:
        df["cycle_number"] = (df["half_cycle"] + 1) // 2

    exp_type = _detect_experiment_type(df, FileType.BIOLOGIC_MPT)
    return ParseResult(
        data=df,
        file_type=FileType.BIOLOGIC_MPT,
        experiment_type=exp_type,
        metadata={},
        raw_columns=raw_columns,
    )


# ---------------------------------------------------------------------------
# Neware .nda/.ndax parser
# ---------------------------------------------------------------------------

_NEWARE_COL_MAP = {
    "Voltage": "voltage_v",
    "Current": "current_a",
    "Current(mA)": "current_ma_raw",
    "Time": "time_s",
    "Cycle": "cycle_number",
    "Capacity": "capacity_ah",
    "Charge_Capacity(mAh)": "charge_capacity_mah",
    "Discharge_Capacity(mAh)": "discharge_capacity_mah",
    "Charge_Energy(mWh)": "charge_energy_mwh",
    "Discharge_Energy(mWh)": "discharge_energy_mwh",
    "Timestamp": "timestamp",
    "Step": "step",
    "Step_Index": "step_index",
    "Status": "status",
    "state": "state",
    "half cycle": "half_cycle",
    "full cycle": "full_cycle",
    "cycle change": "cycle_change",
}


def _parse_neware(filepath: str, file_type: FileType) -> ParseResult:
    import navani.echem as ec

    df = ec.echem_file_loader(filepath)
    raw_columns = df.columns.tolist()

    rename_map = {}
    for orig, target in _NEWARE_COL_MAP.items():
        if orig in df.columns:
            rename_map[orig] = target
    df = df.rename(columns=rename_map)

    # Convert capacity from mAh if needed
    if "capacity_ah" in df.columns:
        cap = df["capacity_ah"]
        if cap.max() > 0 and cap.max() < 100:
            df["capacity_ah"] = cap / 1000.0

    exp_type = _detect_experiment_type(df, file_type)
    return ParseResult(
        data=df,
        file_type=file_type,
        experiment_type=exp_type,
        metadata={},
        raw_columns=raw_columns,
    )


# ---------------------------------------------------------------------------
# Gamry .DTA parser
# ---------------------------------------------------------------------------

def _parse_gamry_dta(filepath: str) -> ParseResult:
    metadata = {}
    # Parse header for metadata
    with open(filepath, "r", encoding="latin-1") as f:
        lines = f.readlines()

    # Extract metadata from header
    for line in lines[:30]:
        parts = line.strip().split("\t")
        if len(parts) >= 3:
            key = parts[0].strip()
            if key == "TITLE":
                metadata["title"] = parts[2] if len(parts) > 2 else ""
            elif key == "DATE":
                metadata["date"] = parts[2] if len(parts) > 2 else ""
            elif key == "TIME":
                metadata["time"] = parts[2] if len(parts) > 2 else ""
            elif key == "PSTAT":
                metadata["instrument"] = parts[2] if len(parts) > 2 else ""
            elif key == "TAG":
                metadata["technique"] = parts[1] if len(parts) > 1 else ""

    # Use impedance.py to read the EIS data
    from impedance.preprocessing import readGamry
    freq, Z = readGamry(filepath)

    df = pd.DataFrame({
        "frequency_hz": freq,
        "z_real_ohm": Z.real,
        "z_imag_ohm": Z.imag,
        "z_mag_ohm": np.abs(Z),
        "z_phase_deg": np.degrees(np.arctan2(Z.imag, Z.real)),
    })

    return ParseResult(
        data=df,
        file_type=FileType.GAMRY_DTA,
        experiment_type=ExperimentType.EIS,
        metadata=metadata,
        raw_columns=["freq", "Z_real", "Z_imag"],
    )


# ---------------------------------------------------------------------------
# Maccor text export parser
# ---------------------------------------------------------------------------

_MACCOR_COL_MAP = {
    "Cyc#": "cycle_number",
    "Step": "step",
    "TestTime(s)": "time_s",
    "StepTime(s)": "step_time_s",
    "Capacity(Ah)": "capacity_ah",
    "Watt-hr": "energy_wh",
    "Current(A)": "current_a",
    "Voltage(V)": "voltage_v",
    "Temp 1": "temperature_c",
    "ES": "end_status",
    "DPt Time": "datapoint_time",
    "ACR": "acr_ohm",
    "DCIR": "dcir_ohm",
}


def _parse_maccor_txt(filepath: str) -> ParseResult:
    metadata = {}
    # Read first two lines for metadata
    with open(filepath, "r") as f:
        line1 = f.readline().strip()
        line2 = f.readline().strip()

    if "Today" in line1:
        parts = line1.split("\t")
        if len(parts) >= 2:
            metadata["export_date"] = parts[1]
    if "Date of Test" in line2:
        parts = line2.split("\t")
        if len(parts) >= 2:
            metadata["test_date"] = parts[1]

    df = pd.read_csv(filepath, sep="\t", skiprows=2)
    raw_columns = df.columns.tolist()

    # Drop unnamed columns (trailing tab)
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]

    rename_map = {}
    for orig, target in _MACCOR_COL_MAP.items():
        if orig in df.columns:
            rename_map[orig] = target
    df = df.rename(columns=rename_map)

    exp_type = _detect_experiment_type(df, FileType.MACCOR_TXT)
    return ParseResult(
        data=df,
        file_type=FileType.MACCOR_TXT,
        experiment_type=exp_type,
        metadata=metadata,
        raw_columns=raw_columns,
    )


# ---------------------------------------------------------------------------
# Arbin CSV parser
# ---------------------------------------------------------------------------

_ARBIN_COL_MAP = {
    "Test Time (s)": "time_s",
    "Step Time (s)": "step_time_s",
    "Cycle Index": "cycle_number",
    "Step Index": "step_index",
    "Current (A)": "current_a",
    "Voltage (V)": "voltage_v",
    "Power (W)": "power_w",
    "Charge Capacity (Ah)": "charge_capacity_ah",
    "Discharge Capacity (Ah)": "discharge_capacity_ah",
    "Charge Energy (Wh)": "charge_energy_wh",
    "Discharge Energy (Wh)": "discharge_energy_wh",
    "ACR (Ohm)": "acr_ohm",
    "Internal Resistance (Ohm)": "internal_resistance_ohm",
    "dV/dt (V/s)": "dv_dt",
    "dQ/dV (Ah/V)": "dq_dv",
    "dV/dQ (V/Ah)": "dv_dq",
    "Aux_Temperature_1 (C)": "temperature_c",
    "Date Time": "datetime",
}


def _parse_arbin_csv(filepath: str) -> ParseResult:
    df = pd.read_csv(filepath)
    raw_columns = df.columns.tolist()

    rename_map = {}
    for orig, target in _ARBIN_COL_MAP.items():
        if orig in df.columns:
            rename_map[orig] = target
    df = df.rename(columns=rename_map)

    # Compute net capacity from charge/discharge
    if "charge_capacity_ah" in df.columns and "discharge_capacity_ah" in df.columns:
        df["capacity_ah"] = df["charge_capacity_ah"] + df["discharge_capacity_ah"]

    exp_type = _detect_experiment_type(df, FileType.ARBIN_CSV)
    return ParseResult(
        data=df,
        file_type=FileType.ARBIN_CSV,
        experiment_type=exp_type,
        metadata={},
        raw_columns=raw_columns,
    )


# ---------------------------------------------------------------------------
# EIS CSV parser
# ---------------------------------------------------------------------------

_EIS_COL_PATTERNS = {
    "frequency_hz": ["freq", "f_hz", "frequency"],
    "z_real_ohm": ["z_real", "zreal", "z'", "re(z)", "z_re"],
    "z_imag_ohm": ["z_imag", "zimag", "z''", "im(z)", "z_im", "-z_imag", "-z''"],
}


def _parse_eis_csv(filepath: str) -> ParseResult:
    from impedance.preprocessing import readFile
    freq, Z = readFile(filepath)

    df = pd.DataFrame({
        "frequency_hz": freq,
        "z_real_ohm": Z.real,
        "z_imag_ohm": Z.imag,
        "z_mag_ohm": np.abs(Z),
        "z_phase_deg": np.degrees(np.arctan2(Z.imag, Z.real)),
    })

    return ParseResult(
        data=df,
        file_type=FileType.EIS_CSV,
        experiment_type=ExperimentType.EIS,
        metadata={},
        raw_columns=["frequency", "Z_real", "Z_imag"],
    )


# ---------------------------------------------------------------------------
# Generic CSV parser
# ---------------------------------------------------------------------------

_GENERIC_COL_PATTERNS = {
    "time_s": ["time", "t_s", "time_s", "elapsed"],
    "voltage_v": ["voltage", "potential", "ewe", "ecell", "v_cell", "voltage_v"],
    "current_a": ["current", "i_a", "current_a"],
    "capacity_ah": ["capacity", "cap", "q_ah", "capacity_ah"],
    "cycle_number": ["cycle", "cyc", "cycle_number", "cycle_index"],
    "temperature_c": ["temp", "temperature", "t_c"],
    "frequency_hz": ["freq", "frequency", "f_hz"],
    "z_real_ohm": ["z_real", "zreal", "z_re", "re_z"],
    "z_imag_ohm": ["z_imag", "zimag", "z_im", "im_z"],
}


def _parse_generic_csv(filepath: str) -> ParseResult:
    # Try common delimiters
    for sep in [",", "\t", ";"]:
        try:
            df = pd.read_csv(filepath, sep=sep, nrows=5)
            if len(df.columns) > 1:
                df = pd.read_csv(filepath, sep=sep)
                break
        except Exception:
            continue
    else:
        df = pd.read_csv(filepath)

    raw_columns = df.columns.tolist()

    # Auto-detect columns by matching patterns
    rename_map = {}
    for target, patterns in _GENERIC_COL_PATTERNS.items():
        for col in df.columns:
            cl = col.lower().strip()
            if any(p in cl for p in patterns):
                if target not in rename_map.values():
                    rename_map[col] = target
                break
    df = df.rename(columns=rename_map)

    exp_type = _detect_experiment_type(df, FileType.GENERIC_CSV)
    return ParseResult(
        data=df,
        file_type=FileType.GENERIC_CSV,
        experiment_type=exp_type,
        metadata={},
        raw_columns=raw_columns,
    )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

_PARSERS = {
    FileType.BIOLOGIC_MPR: _parse_biologic_mpr,
    FileType.BIOLOGIC_MPT: _parse_biologic_mpt,
    FileType.NEWARE_NDA: lambda fp: _parse_neware(fp, FileType.NEWARE_NDA),
    FileType.NEWARE_NDAX: lambda fp: _parse_neware(fp, FileType.NEWARE_NDAX),
    FileType.GAMRY_DTA: _parse_gamry_dta,
    FileType.MACCOR_TXT: _parse_maccor_txt,
    FileType.ARBIN_CSV: _parse_arbin_csv,
    FileType.EIS_CSV: _parse_eis_csv,
    FileType.GENERIC_CSV: _parse_generic_csv,
}


def load(filepath: str, file_type: Optional[FileType] = None) -> ParseResult:
    """Load an electrochemical data file and return parsed data.

    Args:
        filepath: Path to the data file.
        file_type: Force a specific file type. If None, auto-detect.

    Returns:
        ParseResult with standardized DataFrame, detected type, and metadata.
    """
    if file_type is None:
        file_type = detect_file_type(filepath)

    parser = _PARSERS.get(file_type)
    if parser is None:
        raise ValueError(f"No parser for file type: {file_type}")

    return parser(filepath)
