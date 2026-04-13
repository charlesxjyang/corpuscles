"""Electrochemical analysis functions.

Cycling: capacity per cycle, dQ/dV, capacity fade fitting.
EIS: equivalent circuit fitting (impedance.py), DRT (pyDRTtools),
     Kramers-Kronig validation (impedance.py linKK + pyDRTtools BHT).
"""

import numpy as np
import pandas as pd
from scipy.signal import savgol_filter
from typing import Optional, Tuple


# ---------------------------------------------------------------------------
# Cycling analysis (pure numpy/pandas — no external deps needed)
# ---------------------------------------------------------------------------

def capacity_per_cycle(df: pd.DataFrame) -> pd.DataFrame:
    """Extract capacity, efficiency, and energy per cycle.

    Expects columns: cycle_number, voltage_v, current_a, capacity_ah (or
    charge_capacity_ah / discharge_capacity_ah), and optionally time_s.
    """
    if "cycle_number" not in df.columns:
        raise ValueError("DataFrame must have 'cycle_number' column")

    if "charge_capacity_ah" in df.columns and "discharge_capacity_ah" in df.columns:
        result = []
        for cycle, grp in df.groupby("cycle_number"):
            charge_cap = grp["charge_capacity_ah"].max()
            discharge_cap = grp["discharge_capacity_ah"].max()
            charge_energy = grp.get("charge_energy_wh", pd.Series([0])).max()
            discharge_energy = grp.get("discharge_energy_wh", pd.Series([0])).max()
            ce = discharge_cap / charge_cap if charge_cap > 0 else np.nan
            result.append({
                "cycle": cycle,
                "charge_cap_ah": charge_cap,
                "discharge_cap_ah": discharge_cap,
                "coulombic_efficiency": ce,
                "charge_energy_wh": charge_energy,
                "discharge_energy_wh": discharge_energy,
            })
        return pd.DataFrame(result)

    if "current_a" not in df.columns:
        raise ValueError("Need 'current_a' or 'charge_capacity_ah'/'discharge_capacity_ah'")

    result = []
    for cycle, grp in df.groupby("cycle_number"):
        if cycle == 0:
            continue
        charge_mask = grp["current_a"] > 0
        discharge_mask = grp["current_a"] < 0

        if "capacity_ah" in grp.columns:
            charge_cap = grp.loc[charge_mask, "capacity_ah"].max() if charge_mask.any() else 0
            discharge_cap = grp.loc[discharge_mask, "capacity_ah"].max() if discharge_mask.any() else 0
        elif "time_s" in grp.columns:
            dt = np.diff(grp["time_s"].values, prepend=grp["time_s"].values[0])
            q = np.cumsum(grp["current_a"].values * dt) / 3600.0
            charge_cap = q[charge_mask.values].max() if charge_mask.any() else 0
            discharge_cap = abs(q[discharge_mask.values].min()) if discharge_mask.any() else 0
        else:
            continue

        ce = discharge_cap / charge_cap if charge_cap > 0 else np.nan

        charge_energy = 0
        discharge_energy = 0
        if "voltage_v" in grp.columns and "time_s" in grp.columns:
            dt = np.diff(grp["time_s"].values, prepend=grp["time_s"].values[0])
            power = grp["voltage_v"].values * grp["current_a"].values
            energy = power * dt / 3600.0
            charge_energy = energy[charge_mask.values].sum() if charge_mask.any() else 0
            discharge_energy = abs(energy[discharge_mask.values].sum()) if discharge_mask.any() else 0

        result.append({
            "cycle": cycle,
            "charge_cap_ah": abs(charge_cap),
            "discharge_cap_ah": abs(discharge_cap),
            "coulombic_efficiency": ce,
            "charge_energy_wh": abs(charge_energy),
            "discharge_energy_wh": abs(discharge_energy),
        })

    return pd.DataFrame(result)


def dqdv(
    voltage: np.ndarray,
    capacity: np.ndarray,
    smoothing_window: int = 51,
    polyorder: int = 3,
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute differential capacity dQ/dV using Savitzky-Golay smoothing."""
    v = np.asarray(voltage, dtype=float)
    q = np.asarray(capacity, dtype=float)

    if smoothing_window % 2 == 0:
        smoothing_window += 1
    smoothing_window = min(smoothing_window, len(v) - 1)
    if smoothing_window < polyorder + 2:
        smoothing_window = polyorder + 2
        if smoothing_window % 2 == 0:
            smoothing_window += 1

    q_smooth = savgol_filter(q, smoothing_window, polyorder)
    dv = np.diff(v)
    dq = np.diff(q_smooth)
    mask = np.abs(dv) > 1e-10
    v_mid = (v[:-1] + v[1:]) / 2.0
    dqdv_vals = np.where(mask, dq / dv, 0.0)

    return v_mid[mask], dqdv_vals[mask]


def capacity_fade_fit(
    cycles: np.ndarray,
    capacities: np.ndarray,
    model: str = "power",
) -> dict:
    """Fit capacity fade model (linear, sqrt, power law)."""
    n = np.asarray(cycles, dtype=float)
    q = np.asarray(capacities, dtype=float)

    if model == "linear":
        coeffs = np.polyfit(n, q, 1)
        q_fit = np.polyval(coeffs, n)
        params = {"Q0": coeffs[1], "k": -coeffs[0]}
    elif model == "sqrt":
        sqrt_n = np.sqrt(n)
        coeffs = np.polyfit(sqrt_n, q, 1)
        q_fit = np.polyval(coeffs, sqrt_n)
        params = {"Q0": coeffs[1], "k": -coeffs[0]}
    elif model == "power":
        mask = (n > 0) & (q > 0)
        log_n = np.log(n[mask])
        log_q = np.log(q[mask])
        coeffs = np.polyfit(log_n, log_q, 1)
        alpha = -coeffs[0]
        Q0 = np.exp(coeffs[1])
        q_fit = Q0 * n[mask] ** (-alpha)
        n = n[mask]
        q = q[mask]
        params = {"Q0": Q0, "alpha": alpha}
    else:
        raise ValueError(f"Unknown model: {model}")

    ss_res = np.sum((q - q_fit) ** 2)
    ss_tot = np.sum((q - np.mean(q)) ** 2)
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return {"model": model, "params": params, "r_squared": r_squared}


# ---------------------------------------------------------------------------
# EIS analysis — impedance.py
# ---------------------------------------------------------------------------

def equivalent_circuit_fit(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    circuit_string: str = "R0-p(R1,C1)-W1",
    initial_guess: Optional[list] = None,
    constants: Optional[dict] = None,
    global_opt: bool = False,
) -> dict:
    """Fit equivalent circuit to EIS data using impedance.py.

    Args:
        frequency: Frequency array (Hz).
        z_real: Real impedance (Ohm).
        z_imag: Imaginary impedance (Ohm).
        circuit_string: Circuit string in impedance.py format.
            Elements: R, C, L, W, Wo, Ws, CPE, La, G, Gs, K, Zarc, TLMQ, T
            Series: '-', Parallel: 'p(X,Y)'
        initial_guess: Initial parameter values.
        constants: Dict of parameter names to hold constant (e.g. {'R0': 50}).
        global_opt: Use basin-hopping global optimization.

    Returns:
        Dict with param_names, param_units, param_values, confidence intervals,
        fitted impedance, and residual RMSE.
    """
    from impedance.models.circuits import CustomCircuit

    freq = np.asarray(frequency)
    Z = np.asarray(z_real) + 1j * np.asarray(z_imag)

    if initial_guess is None:
        initial_guess = [
            np.min(z_real),
            np.max(z_real) - np.min(z_real),
            1e-6,
            np.max(z_real),
        ]

    circuit = CustomCircuit(
        circuit_string,
        initial_guess=initial_guess,
        constants=constants or {},
    )
    circuit.fit(freq, Z, global_opt=global_opt)

    names, units = circuit.get_param_names()
    Z_fit = circuit.predict(freq)
    residual = np.sqrt(np.mean(np.abs(Z - Z_fit) ** 2)) / np.mean(np.abs(Z))

    return {
        "param_names": names,
        "param_units": units,
        "param_values": circuit.parameters_.tolist(),
        "param_conf": circuit.conf_.tolist() if circuit.conf_ is not None else None,
        "z_fit_real": Z_fit.real.tolist(),
        "z_fit_imag": Z_fit.imag.tolist(),
        "residual_rmse": float(residual),
        "circuit_string": circuit_string,
    }


def kramers_kronig_validation(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    c: float = 0.85,
    max_M: int = 50,
) -> dict:
    """Kramers-Kronig validation using impedance.py linKK method.

    Args:
        frequency: Frequency array (Hz).
        z_real: Real impedance (Ohm).
        z_imag: Imaginary impedance (Ohm).
        c: Cutoff for mu metric (lower = stricter).
        max_M: Maximum number of RC elements to try.

    Returns:
        Dict with M (RC elements used), mu (quality metric),
        fitted impedance, and residuals.
    """
    from impedance.validation import linKK

    freq = np.asarray(frequency)
    Z = np.asarray(z_real) + 1j * np.asarray(z_imag)

    M, mu, Z_fit, resids_real, resids_imag = linKK(freq, Z, c=c, max_M=max_M)

    return {
        "M": int(M),
        "mu": float(mu),
        "valid": bool(mu < c),
        "z_fit_real": Z_fit.real.tolist(),
        "z_fit_imag": Z_fit.imag.tolist(),
        "resids_real": resids_real.tolist(),
        "resids_imag": resids_imag.tolist(),
    }


# ---------------------------------------------------------------------------
# DRT analysis — pyDRTtools
# ---------------------------------------------------------------------------

def drt_analysis(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    method: str = "simple",
    rbf_type: str = "Gaussian",
    data_used: str = "Combined Re-Im Data",
    der_used: str = "1st order",
    cv_type: str = "GCV",
    reg_param: float = 1e-3,
    coeff: float = 0.5,
    NMC_sample: int = 2000,
) -> dict:
    """Distribution of Relaxation Times analysis using pyDRTtools.

    Args:
        frequency: Frequency array (Hz).
        z_real: Real impedance (Ohm).
        z_imag: Imaginary impedance (Ohm).
        method: 'simple' (Tikhonov), 'bayesian' (with uncertainty), or 'BHT'.
        rbf_type: Radial basis function type.
        data_used: Which impedance data to use.
        der_used: Derivative order for regularization.
        cv_type: Cross-validation type ('GCV' or 'custom').
        reg_param: Regularization parameter (if cv_type='custom').
        coeff: Shape factor coefficient.
        NMC_sample: Number of MCMC samples for Bayesian method.

    Returns:
        Dict with tau, gamma, and method-specific results.
    """
    from pyDRTtools.runs import EIS_object, simple_run, Bayesian_run, BHT_run

    freq = np.asarray(frequency, dtype=float)
    zr = np.asarray(z_real, dtype=float)
    zi = np.asarray(z_imag, dtype=float)

    eis = EIS_object(freq, zr, zi)

    common_kwargs = dict(
        rbf_type=rbf_type,
        der_used=der_used,
        shape_control="FWHM Coefficient",
        coeff=coeff,
    )

    def _to_float(val):
        """Safely convert scalar or 0-d/1-element array to float."""
        v = np.asarray(val)
        return float(v.flat[0]) if v.size > 0 else 0.0

    if method == "simple":
        result = simple_run(
            entry=eis,
            data_used=data_used,
            induct_used=1,
            cv_type=cv_type,
            reg_param=reg_param,
            **common_kwargs,
        )
        return {
            "method": "simple",
            "tau": result.out_tau_vec.tolist(),
            "gamma": result.gamma.tolist(),
            "R_inf": _to_float(result.R),
            "L": _to_float(result.L),
            "lambda_value": _to_float(result.lambda_value),
        }

    elif method == "bayesian":
        result = Bayesian_run(
            entry=eis,
            data_used=data_used,
            induct_used=1,
            cv_type=cv_type,
            reg_param=reg_param,
            NMC_sample=NMC_sample,
            **common_kwargs,
        )
        return {
            "method": "bayesian",
            "tau": result.out_tau_vec.tolist(),
            "gamma": result.gamma.tolist(),
            "mean": result.mean.tolist(),
            "lower_bound": result.lower_bound.tolist(),
            "upper_bound": result.upper_bound.tolist(),
            "R_inf": _to_float(result.R),
            "L": _to_float(result.L),
        }

    elif method == "BHT":
        result = BHT_run(
            entry=eis,
            **common_kwargs,
        )
        return {
            "method": "BHT",
            "tau_re": result.out_tau_vec.tolist() if hasattr(result, 'out_tau_vec') else [],
            "gamma_re": result.mu_gamma_fine_re.tolist() if hasattr(result, 'mu_gamma_fine_re') else [],
            "gamma_im": result.mu_gamma_fine_im.tolist() if hasattr(result, 'mu_gamma_fine_im') else [],
            "scores": result.out_scores if hasattr(result, 'out_scores') else {},
            "R_inf": _to_float(result.mu_R_inf) if hasattr(result, 'mu_R_inf') else 0.0,
        }

    else:
        raise ValueError(f"Unknown DRT method: {method}. Use 'simple', 'bayesian', or 'BHT'.")


def drt_peak_analysis(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    n_peaks: int = 1,
    rbf_type: str = "Gaussian",
    coeff: float = 0.5,
) -> dict:
    """Identify and fit peaks in DRT using pyDRTtools.

    Returns:
        Dict with tau, gamma, peak positions, and individual peak Gaussians.
    """
    from pyDRTtools.runs import EIS_object, peak_analysis

    eis = EIS_object(
        np.asarray(frequency, dtype=float),
        np.asarray(z_real, dtype=float),
        np.asarray(z_imag, dtype=float),
    )

    result = peak_analysis(
        entry=eis,
        rbf_type=rbf_type,
        data_used="Combined Re-Im Data",
        induct_used=1,
        der_used="1st order",
        cv_type="GCV",
        reg_param=1e-3,
        shape_control="FWHM Coefficient",
        coeff=coeff,
        peak_method="separate",
        N_peaks=n_peaks,
    )

    return {
        "tau": result.out_tau_vec.tolist(),
        "gamma": result.gamma.tolist(),
        "gamma_fit": result.gamma_fit_tot.tolist() if hasattr(result, 'gamma_fit_tot') else [],
        "peaks": result.Gaussian.tolist() if hasattr(result, 'Gaussian') else [],
        "n_peaks": n_peaks,
    }


# ---------------------------------------------------------------------------
# Plot data formatting helpers (pure numpy, no external deps)
# ---------------------------------------------------------------------------

def nyquist_plot_data(
    z_real: np.ndarray,
    z_imag: np.ndarray,
    frequency: Optional[np.ndarray] = None,
) -> dict:
    """Format EIS data for Nyquist plot (Z_real vs -Z_imag)."""
    return {
        "x": np.asarray(z_real),
        "y": -np.asarray(z_imag),
        "x_label": "Z' (\u03a9)",
        "y_label": "-Z'' (\u03a9)",
        "frequency": np.asarray(frequency) if frequency is not None else None,
    }


def bode_plot_data(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
) -> dict:
    """Format EIS data for Bode plot."""
    f = np.asarray(frequency)
    zr = np.asarray(z_real)
    zi = np.asarray(z_imag)
    z_mag = np.sqrt(zr**2 + zi**2)
    z_phase = np.degrees(np.arctan2(zi, zr))

    return {
        "frequency": f,
        "magnitude": z_mag,
        "phase": z_phase,
        "log_frequency": np.log10(f),
        "log_magnitude": np.log10(z_mag),
    }
