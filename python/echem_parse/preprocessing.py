"""EIS data preprocessing functions.

Masking, averaging, frequency cropping, impedance subtraction,
and interpolation — matching DearEIS preprocessing capabilities.
"""

import numpy as np
from typing import Tuple, Optional


def mask_points(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    indices: list[int],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Exclude data points by index.

    Returns new arrays with masked points removed.
    """
    mask = np.ones(len(frequency), dtype=bool)
    mask[indices] = False
    return frequency[mask], z_real[mask], z_imag[mask]


def crop_frequencies(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    freq_min: Optional[float] = None,
    freq_max: Optional[float] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Crop data to a frequency range."""
    mask = np.ones(len(frequency), dtype=bool)
    if freq_min is not None:
        mask &= frequency >= freq_min
    if freq_max is not None:
        mask &= frequency <= freq_max
    return frequency[mask], z_real[mask], z_imag[mask]


def ignore_below_x_axis(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Remove points where -Z_imag < 0 (positive imaginary impedance).

    These points are typically inductive artifacts at high frequency.
    """
    mask = z_imag < 0  # Keep capacitive points (negative Z_imag)
    return frequency[mask], z_real[mask], z_imag[mask]


def average_spectra(
    datasets: list[Tuple[np.ndarray, np.ndarray, np.ndarray]],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Average multiple EIS spectra measured at the same frequencies.

    All datasets must have the same frequency points.
    Returns averaged (frequency, z_real, z_imag).
    """
    if len(datasets) == 0:
        raise ValueError("No datasets to average")
    if len(datasets) == 1:
        return datasets[0]

    freq = datasets[0][0]
    z_reals = np.array([d[1] for d in datasets])
    z_imags = np.array([d[2] for d in datasets])

    return freq, np.mean(z_reals, axis=0), np.mean(z_imags, axis=0)


def subtract_impedance(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    z_subtract_real: Optional[np.ndarray] = None,
    z_subtract_imag: Optional[np.ndarray] = None,
    resistance: Optional[float] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Subtract impedance from data.

    Either subtract a fixed resistance, or subtract another impedance spectrum
    (must be same length / interpolated to same frequencies).
    """
    if resistance is not None:
        return frequency, z_real - resistance, z_imag
    if z_subtract_real is not None and z_subtract_imag is not None:
        return frequency, z_real - z_subtract_real, z_imag - z_subtract_imag
    return frequency, z_real, z_imag


def add_parallel_impedance(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    resistance: float,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Add a parallel resistance: 1/Z_new = 1/Z_data + 1/R.

    Useful for correcting for a shunt resistance.
    """
    Z = z_real + 1j * z_imag
    Z_R = resistance
    Z_new = (Z * Z_R) / (Z + Z_R)
    return frequency, Z_new.real, Z_new.imag


def interpolate_outliers(
    frequency: np.ndarray,
    z_real: np.ndarray,
    z_imag: np.ndarray,
    outlier_indices: list[int],
    method: str = "akima",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Replace outlier points with interpolated values.

    Args:
        outlier_indices: Indices of points to replace.
        method: 'akima', 'cubic', or 'linear'.
    """
    from scipy.interpolate import Akima1DInterpolator, CubicSpline

    log_freq = np.log10(frequency)
    good_mask = np.ones(len(frequency), dtype=bool)
    good_mask[outlier_indices] = False

    zr_new = z_real.copy()
    zi_new = z_imag.copy()

    if method == "akima":
        interp_r = Akima1DInterpolator(log_freq[good_mask], z_real[good_mask])
        interp_i = Akima1DInterpolator(log_freq[good_mask], z_imag[good_mask])
    elif method == "cubic":
        interp_r = CubicSpline(log_freq[good_mask], z_real[good_mask])
        interp_i = CubicSpline(log_freq[good_mask], z_imag[good_mask])
    else:
        interp_r = lambda x: np.interp(x, log_freq[good_mask], z_real[good_mask])
        interp_i = lambda x: np.interp(x, log_freq[good_mask], z_imag[good_mask])

    zr_new[outlier_indices] = interp_r(log_freq[outlier_indices])
    zi_new[outlier_indices] = interp_i(log_freq[outlier_indices])

    return frequency, zr_new, zi_new


def simulate_circuit(
    circuit_string: str,
    frequency: np.ndarray,
    parameters: list[float],
    constants: Optional[dict] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Generate synthetic impedance from a circuit definition.

    Uses impedance.py CustomCircuit.predict().

    Returns (z_real, z_imag) arrays.
    """
    from impedance.models.circuits import CustomCircuit

    circuit = CustomCircuit(
        circuit_string,
        initial_guess=parameters,
        constants=constants or {},
    )
    # Set parameters directly (no fitting)
    circuit.parameters_ = np.array(parameters)
    Z = circuit.predict(frequency)
    return Z.real, Z.imag
